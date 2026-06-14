// Web Speech API hook.
//
// Wraps webkitSpeechRecognition (Chrome/Safari/Edge) into a single React hook
// that exposes a listen(onComplete) function. The hook never throws — every
// error path resolves through onComplete with an `error` field.
//
// Returns:
//   supported  : boolean — Web Speech API present
//   listening  : boolean — currently capturing audio
//   listen     : (onComplete) => void — start a single capture
//   stop       : () => void — abort an in-flight capture
//   lastResult : last { transcript, alternatives, confidence, latencyMs, error }
//
// ============================================================================
// M16-F1 RECOGNIZER LIFECYCLE FIX — recognizer actually stays alive
// ============================================================================
// Problem this hook had before M16-F1:
//   webkitSpeechRecognition has its own internal silence timeout (~1s on
//   Chrome) and fires `onend` before a hesitant K-2 reader can answer.
//   The previous "fix" only delayed setListening(false) — the result
//   callback fired immediately, so the drill counted a no-audio close
//   as an incorrect attempt and advanced.
//
// What this rewrite does:
//   1. Tracks a single LISTEN SESSION across multiple recognizer instances.
//   2. If the recognizer ends with no audio detected and we're still inside
//      the patience window, silently start a NEW recognizer (restart loop).
//   3. A hard max-duration timer is the only thing that finalizes as
//      "no-speech" — the visible UI stays alive that whole time.
//   4. Once audio onset is detected, restarts stop — the recognizer is
//      allowed to resolve naturally so a real utterance lands cleanly.
//   5. Errors that aren't "no-speech"/"aborted" finalize immediately so
//      mic-permission etc. don't get swallowed.
//
// Timing constants below mirror the M16-F1 brief.
//
// Latency is measured from the speechstart event (audio onset) when
// available, falling back to the start() call timestamp.

import { useCallback, useEffect, useRef, useState } from "react";

function getRecognitionCtor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function isSpeechSupported() {
  return !!getRecognitionCtor();
}

// M16-F1: K-2 patience tuning for the ENGINE (not just the visible state).
//
// Two named profiles. Routes pass `patience: "k2"` (default) for drill /
// diagnostic / passage flows that need to wait on a hesitant child, or
// `patience: "fluency"` for the 60-second sprint where snappy resolution
// matters more than patience.
//
//   - hardMaxMs:          total time the listen session can run before we
//                         give up and resolve as no-speech.
//   - initialNoSpeechMs:  how long to keep restarting the recognizer when
//                         no audio has been detected yet.
//   - minListenMs:        minimum time the visible "listening" state shows
//                         even if the engine resolves immediately
//                         (anti-flicker, cosmetic only).
//   - maxRestarts:        hard safety cap on the restart loop.
const PATIENCE_PROFILES = {
  k2: {
    hardMaxMs: 12_000,
    initialNoSpeechMs: 8_000,
    minListenMs: 5_000,
    maxRestarts: 6,
  },
  fluency: {
    hardMaxMs: 4_000,
    initialNoSpeechMs: 1_500,
    minListenMs: 0,
    maxRestarts: 2,
  },
};
function resolvePatience(input) {
  if (typeof input === "string") {
    return PATIENCE_PROFILES[input] || PATIENCE_PROFILES.k2;
  }
  if (input && typeof input === "object") {
    return { ...PATIENCE_PROFILES.k2, ...input };
  }
  return PATIENCE_PROFILES.k2;
}

// M16-G3: critical lifecycle markers ALWAYS print to console so we can
// debug production directly without flipping any browser flags. The
// verbose extras (per-event payloads, Azure event noise, etc.) stay
// gated on `localStorage.setItem("ra-debug-asr", "1")` so console
// volume in normal student sessions doesn't explode.
function debugEnabled() {
  try {
    return (
      typeof window !== "undefined" &&
      window.localStorage?.getItem("ra-debug-asr") === "1"
    );
  } catch {
    return false;
  }
}
// Always-on critical marker.
function mark(...args) {
  // eslint-disable-next-line no-console
  console.log("[asr.web]", ...args);
}
// Verbose (debug-flag-gated) detail.
function dbg(...args) {
  if (debugEnabled()) {
    // eslint-disable-next-line no-console
    console.log("[asr.web.debug]", ...args);
  }
}

export function useSpeechRecognition({
  lang = "en-US",
  maxAlternatives = 5,
  patience = "k2",
} = {}) {
  const supported = isSpeechSupported();
  const [listening, setListening] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  // The active session. Holds everything that survives across restarts.
  const sessionRef = useRef(null);
  const patienceRef = useRef(resolvePatience(patience));
  // Keep patience in sync if the route changes its profile mid-mount.
  useEffect(() => {
    patienceRef.current = resolvePatience(patience);
  }, [patience]);

  const cleanupRecognizer = (rec) => {
    if (!rec) return;
    try {
      rec.onstart = null;
      rec.onspeechstart = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
    } catch {}
    try {
      rec.abort();
    } catch {}
  };

  const stop = useCallback(() => {
    const sess = sessionRef.current;
    if (!sess) {
      setListening(false);
      return;
    }
    sess.resolved = true;
    clearTimeout(sess.hardMaxTimer);
    cleanupRecognizer(sess.rec);
    sess.rec = null;
    sessionRef.current = null;
    setListening(false);
  }, []);

  // Cleanup on unmount.
  useEffect(() => () => stop(), [stop]);

  const listen = useCallback(
    (onComplete) => {
      if (!supported) {
        const result = {
          transcript: null,
          alternatives: [],
          confidence: null,
          latencyMs: 0,
          error: "unsupported",
        };
        setLastResult(result);
        onComplete?.(result);
        return;
      }

      // Tear down any in-flight session before starting a new one so a
      // delayed callback from the previous session can't fire onComplete
      // for this one.
      if (sessionRef.current) {
        const old = sessionRef.current;
        old.resolved = true;
        clearTimeout(old.hardMaxTimer);
        cleanupRecognizer(old.rec);
        old.rec = null;
        sessionRef.current = null;
      }

      // Snapshot the patience profile at the moment the session starts
      // so a mid-flight prop change can't shrink the timeouts.
      const PROFILE = patienceRef.current;

      // Set listening up front so the visible state never flickers when
      // the restart loop tears down one recognizer to spin up the next.
      setListening(true);

      const session = {
        startedAt: Date.now(),
        audioStartedAt: null,
        restartCount: 0,
        resolved: false,
        rec: null,
        cb: onComplete || null,
        hardMaxTimer: null,
        minListenTimer: null,
        endReason: null,
        profile: PROFILE,
      };
      sessionRef.current = session;
      mark("session.start", {
        profile: typeof patience === "string" ? patience : "custom",
        hardMaxMs: PROFILE.hardMaxMs,
        initialNoSpeechMs: PROFILE.initialNoSpeechMs,
      });

      const finish = (payload, endReason) => {
        if (session.resolved) return;
        session.resolved = true;
        session.endReason = endReason || payload?.error || "ok";
        clearTimeout(session.hardMaxTimer);
        const endedAt = Date.now();
        const onset = session.audioStartedAt ?? session.startedAt;
        const latencyMs = endedAt - onset;

        cleanupRecognizer(session.rec);
        session.rec = null;
        if (sessionRef.current === session) sessionRef.current = null;

        const result = { latencyMs, ...payload };
        // Critical lifecycle marker — always on so production console
        // shows the actual recognizer end with its reason + timing.
        mark("finish", {
          endReason: session.endReason,
          transcript: result.transcript,
          error: result.error,
          durationMs: endedAt - session.startedAt,
          restartCount: session.restartCount,
          audioStartDetected: !!session.audioStartedAt,
        });

        setLastResult(result);

        // Hold the visible "listening" state for at least MIN_LISTEN_MS
        // so the button doesn't flicker on a rapid resolve. The actual
        // recognizer is already torn down — this is purely cosmetic now.
        const visualElapsed = endedAt - session.startedAt;
        const isEmpty =
          payload?.error === "no-speech" ||
          payload?.transcript == null;
        const remaining = session.profile.minListenMs - visualElapsed;
        if (isEmpty && remaining > 0) {
          setTimeout(() => {
            // Only clear if no newer session has taken over.
            if (sessionRef.current == null) setListening(false);
          }, remaining);
        } else {
          setListening(false);
        }

        const cb = session.cb;
        session.cb = null;
        cb?.(result);
      };

      const startRecognizer = () => {
        // Defensive: if the session was killed before this fires (e.g.
        // unmount during a restart timeout), bail.
        if (session.resolved) return;
        const Ctor = getRecognitionCtor();
        if (!Ctor) {
          finish(
            {
              transcript: null,
              alternatives: [],
              confidence: null,
              error: "unsupported",
            },
            "unsupported",
          );
          return;
        }

        const rec = new Ctor();
        rec.lang = lang;
        rec.continuous = false;
        rec.interimResults = false;
        rec.maxAlternatives = maxAlternatives;

        rec.onstart = () => {
          mark("recognizer.start", {
            restartCount: session.restartCount,
            elapsedMs: Date.now() - session.startedAt,
          });
          setListening(true);
        };
        rec.onspeechstart = () => {
          if (!session.audioStartedAt) {
            session.audioStartedAt = Date.now();
            dbg("speechstart", {
              elapsedMs: session.audioStartedAt - session.startedAt,
            });
          }
        };
        rec.onresult = (e) => {
          const alts = [];
          let confidence = null;
          try {
            const r0 = e.results[0];
            for (let i = 0; i < r0.length; i++) {
              alts.push((r0[i].transcript || "").trim());
              if (i === 0) confidence = r0[i].confidence ?? null;
            }
          } catch {
            // alts stays empty
          }
          finish(
            {
              transcript: alts[0] || null,
              alternatives: alts,
              confidence,
              error: null,
            },
            "result",
          );
        };
        rec.onerror = (e) => {
          const code = e?.error || "error";
          mark("recognizer.error", {
            code,
            restartCount: session.restartCount,
            elapsedMs: Date.now() - session.startedAt,
          });
          // Recoverable codes — defer to onend, which decides whether
          // to restart the recognizer or finalize. Browser-fired
          // "no-speech" is the SDK saying it heard silence; "aborted"
          // happens when our own teardown bumps into a slow start().
          if (code === "no-speech" || code === "aborted") return;
          finish(
            {
              transcript: null,
              alternatives: [],
              confidence: null,
              error: code,
            },
            `error:${code}`,
          );
        };
        rec.onend = () => {
          if (session.resolved) return;
          const elapsed = Date.now() - session.startedAt;
          const haveAudio = !!session.audioStartedAt;
          mark("recognizer.end", {
            elapsedMs: elapsed,
            haveAudio,
            restartCount: session.restartCount,
          });

          // If audio onset has been detected, the recognizer ending
          // means the utterance is done (or the engine bailed) — we
          // shouldn't restart over a real attempt. Finalize with
          // whatever we got (no-speech if no result fired before end).
          if (haveAudio) {
            finish(
              {
                transcript: null,
                alternatives: [],
                confidence: null,
                error: "no-speech",
              },
              "ended_after_audio_no_result",
            );
            return;
          }

          // No audio detected yet. If we're still inside the initial
          // patience window AND haven't blown the restart cap, start a
          // NEW recognizer so the student keeps a live mic.
          if (
            elapsed < session.profile.initialNoSpeechMs &&
            session.restartCount < session.profile.maxRestarts
          ) {
            session.restartCount++;
            mark("restart", {
              restartCount: session.restartCount,
              elapsedMs: elapsed,
              reason: "no_audio_yet",
            });
            // Tear down this dead instance and spin up a fresh one.
            cleanupRecognizer(rec);
            // Tiny gap lets the platform release the previous mic
            // session; without it Chrome occasionally throws
            // InvalidStateError on the next start().
            setTimeout(startRecognizer, 50);
            return;
          }

          // Out of patience — finalize as no-speech.
          finish(
            {
              transcript: null,
              alternatives: [],
              confidence: null,
              error: "no-speech",
            },
            "no_speech_window_exhausted",
          );
        };

        session.rec = rec;
        try {
          rec.start();
        } catch (e) {
          // Some browsers throw InvalidStateError if start() races a
          // previous abort. Retry once after a beat; if still failing,
          // surface as start-failed.
          dbg("start-threw", e?.message || String(e));
          setTimeout(() => {
            if (session.resolved) return;
            try {
              rec.start();
            } catch {
              finish(
                {
                  transcript: null,
                  alternatives: [],
                  confidence: null,
                  error: "start-failed",
                },
                "start_failed",
              );
            }
          }, 120);
        }
      };

      // Hard max-duration safety net. If the engine somehow gets stuck,
      // this guarantees we resolve.
      session.hardMaxTimer = setTimeout(() => {
        if (session.resolved) return;
        dbg("hard-max-hit", { ms: PROFILE.hardMaxMs });
        finish(
          {
            transcript: null,
            alternatives: [],
            confidence: null,
            error: "no-speech",
          },
          "hard_max",
        );
      }, PROFILE.hardMaxMs);

      startRecognizer();
    },
    [supported, lang, maxAlternatives],
  );

  return { supported, listening, listen, stop, lastResult };
}

// Helper: speak a word via Web Speech Synthesis. Used by the "Hear word"
// button so a stuck student can request a model. Browser blocks synthesis
// until first user interaction; this is fine because the student has
// already tapped "Start Drill" by the time it's invoked.
export function speakWord(text, { rate = 0.85, pitch = 1.05 } = {}) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = rate;
    utter.pitch = pitch;
    utter.lang = "en-US";
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find((v) =>
      /Samantha|Karen|Aria|Jenny|Google US English|en-US/i.test(`${v.name} ${v.lang}`),
    );
    if (preferred) utter.voice = preferred;
    window.speechSynthesis.speak(utter);
  } catch (e) {
    console.warn("[reading.tts] speak failed", e);
  }
}
