import React, { useEffect, useRef } from "react";
import MicButton from "./MicButton.jsx";
import { speakWord } from "../lib/useSpeechRecognition.js";
import { useStudentMode } from "../../../lib/auth/useStudentMode.js";

const FAST_FEEDBACK = ["Lightning fast!", "Super speedy!", "Snap!", "Quick!"];
const CORRECT_FEEDBACK = [
  "Nice!",
  "Got it.",
  "That's it!",
  "Yep!",
  "Excellent.",
  "Right on.",
];
const TRY_AGAIN_FEEDBACK = [
  "Almost — try again.",
  "Close! One more shot.",
  "Not yet — keep going.",
  "That one's tricky. Try again.",
];

function pickFeedback(verdict, latencyMs) {
  const pool =
    verdict === "correct"
      ? Number.isFinite(latencyMs) && latencyMs <= 1500
        ? FAST_FEEDBACK
        : CORRECT_FEEDBACK
      : TRY_AGAIN_FEEDBACK;
  return pool[Math.floor(Math.random() * pool.length)];
}

// One drill item.
//   - Renders the prompt prominently.
//   - Mic button is the primary scoring path.
//   - Adult-override row sits below as secondary scoring.
//   - Last attempt result (transcript + verdict) shown above the controls.
//
// Props:
//   item              { prompt, answer, ... }
//   speechSupported   boolean — drives whether mic UI shows
//   listening         boolean — pulses the mic
//   onMicTap          () => void — start ASR
//   onAdultScore      (correct: boolean) => void
//   lastResult        last attempt payload, or null
//   busy              true while a result is being committed (debounce taps)

export default function DrillItem({
  item,
  speechSupported,
  listening,
  onMicTap,
  onAdultScore,
  lastResult,
  busy,
}) {
  const isStudent = useStudentMode();
  const presentedAtRef = useRef(Date.now());

  // Reset the "presented at" stopwatch each time we change items.
  useEffect(() => {
    presentedAtRef.current = Date.now();
  }, [item?.prompt]);

  const handleAdult = (correct) => {
    if (busy) return;
    const latencyMs = Date.now() - presentedAtRef.current;
    onAdultScore?.(correct, latencyMs);
  };

  // M16-F2: a softRetry result means the engine never heard audio —
  // not the same as a wrong answer. Treat it as a neutral nudge so we
  // don't show "Almost — try again." for a child who simply hadn't
  // started speaking yet.
  const verdict = lastResult
    ? lastResult.softRetry
      ? "retry"
      : lastResult.correct
        ? "correct"
        : "incorrect"
    : null;

  return (
    <div className="ra-drill-item">
      <div
        className="ra-drill-prompt"
        aria-label={`Read the word: ${item.prompt}`}
      >
        {item.prompt}
      </div>

      <div className="ra-drill-helpers">
        <button
          type="button"
          className="ra-link"
          onClick={() => speakWord(item.prompt)}
        >
          ▶︎ Hear word
        </button>
      </div>

      {speechSupported ? (
        <MicButton
          listening={listening}
          disabled={busy}
          onTap={onMicTap}
        />
      ) : isStudent ? (
        <div className="ra-drill-fallback-note">
          The microphone isn't ready yet. Ask an adult for help.
        </div>
      ) : (
        <div className="ra-drill-fallback-note">
          Mic recognition needs Chrome, Edge, or Safari. Use the buttons below to score by hand.
        </div>
      )}

      {lastResult && verdict === "retry" && (
        <div className="ra-drill-feedback retry">
          <div
            className="ra-drill-feedback-row"
            style={{ color: "#666", fontSize: 14 }}
          >
            I didn't hear you. Tap the mic and try again.
          </div>
        </div>
      )}

      {lastResult && verdict !== "retry" && (
        <div className={`ra-drill-feedback ${verdict}`}>
          <div className="ra-drill-feedback-row">
            <span className={`ra-dot ra-dot-${verdict === "correct" ? "mastered" : "active"}`} />
            <strong>{pickFeedback(verdict, lastResult.latencyMs)}</strong>
            {Number.isFinite(lastResult.latencyMs) && (
              <span className="ra-drill-feedback-latency">
                {(lastResult.latencyMs / 1000).toFixed(2)}s
              </span>
            )}
          </div>
          {!isStudent && lastResult.transcript && (
            <div className="ra-drill-feedback-heard">
              Heard: <em>"{lastResult.transcript}"</em>
            </div>
          )}
          {!isStudent && lastResult.error && lastResult.error !== "no-speech" && (
            <div className="ra-drill-feedback-error">
              Mic error: {lastResult.error}
            </div>
          )}
          {isStudent && lastResult.error && lastResult.error !== "no-speech" && (
            <div
              className="ra-drill-feedback-error"
              style={{ color: "#888", fontSize: 13, marginTop: 6 }}
            >
              Didn't catch that — tap the mic to try again.
            </div>
          )}
        </div>
      )}

      {!isStudent && (
        <div className="ra-drill-override">
          <div className="ra-drill-override-label">
            Adult override (debug only — hidden in normal student mode)
          </div>
          <div className="ra-actions">
            <button
              type="button"
              className="ra-btn ra-btn-incorrect"
              onClick={() => handleAdult(false)}
              disabled={busy}
            >
              Mark Incorrect
            </button>
            <button
              type="button"
              className="ra-btn ra-btn-correct"
              onClick={() => handleAdult(true)}
              disabled={busy}
            >
              Mark Correct
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
