// src/pages/Reading/lib/azureSpeech.js  (M15-B)
//
// Azure Speech client wrapper. Loads the official SDK from Microsoft's
// CDN on first use so we don't ship 500KB+ in the initial bundle.
// Exposes one method:
//
//   recognizeWithPronunciation(referenceText, opts)
//     → Promise<{
//         transcript, accuracy, fluency, completeness, prosody,
//         words: [{ word, accuracy, errorType }],
//         phonemes: [{ phoneme, accuracy }],
//         latencyMs, error
//       }>
//
// "Pronunciation Assessment" is the killer feature versus Web Speech
// API: Azure scores the learner's audio against the expected text at
// the word AND phoneme level. /s/ vs /sh/ distinctions become
// reliable, which is exactly where the existing self-scoring path
// loses confidence.
//
// Token discipline: never holds the long-lived AZURE_SPEECH_KEY.
// Fetches a 9-minute issuer token from /api/azure-speech-token and
// auto-refreshes when it nears expiry.
//
// Per the LLM-boundary discipline applied to ASR: this is the
// upgrade engine. The deterministic Web Speech API stays as the
// fallback (in useSpeechRecognition.js). If anything below fails —
// CDN unreachable, mic blocked, region wrong — the caller proceeds
// without us.

const SDK_CDN = "https://aka.ms/csspeech/jsbrowserpackage";
const TOKEN_ENDPOINT = "/api/azure-speech-token";
const TOKEN_REFRESH_BUFFER_MS = 60_000; // refresh if within 60s of expiry

let sdkLoadPromise = null;
let cachedToken = null; // { token, region, expiresAtMs }

// M16-H1: critical Azure lifecycle markers ALWAYS print so we can see
// from the production console whether Azure is being invoked, what
// reason recognizeOnceAsync resolved with, and how long it took. Verbose
// per-event payloads (recognizing fragments, sessionStarted/Stopped)
// stay gated on `localStorage.setItem("ra-debug-asr", "1")` so console
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
function mark(...args) {
  // eslint-disable-next-line no-console
  console.log("[asr.azure]", ...args);
}
function dbg(...args) {
  if (debugEnabled()) {
    // eslint-disable-next-line no-console
    console.log("[asr.azure.debug]", ...args);
  }
}

// ---- SDK loader -------------------------------------------------

/**
 * Dynamically inject the Speech SDK <script> tag. Returns the
 * window.SpeechSDK global when ready. Idempotent: parallel callers
 * share one promise.
 */
function loadSdk() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("ssr"));
  }
  if (window.SpeechSDK) return Promise.resolve(window.SpeechSDK);
  if (sdkLoadPromise) return sdkLoadPromise;
  sdkLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-azure-speech-sdk]`);
    if (existing && window.SpeechSDK) return resolve(window.SpeechSDK);
    const s = document.createElement("script");
    s.src = SDK_CDN;
    s.async = true;
    s.dataset.azureSpeechSdk = "true";
    s.onload = () => {
      if (window.SpeechSDK) resolve(window.SpeechSDK);
      else reject(new Error("SDK loaded but window.SpeechSDK undefined"));
    };
    s.onerror = () => reject(new Error("Azure Speech SDK CDN load failed"));
    document.head.appendChild(s);
  });
  return sdkLoadPromise;
}

// ---- Token management ------------------------------------------

async function fetchToken() {
  const res = await fetch(TOKEN_ENDPOINT, { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token endpoint ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json?.token || !json?.region) throw new Error("token response missing fields");
  return {
    token: json.token,
    region: json.region,
    expiresAtMs: Date.now() + (Number(json.expiresInSeconds) || 540) * 1000,
  };
}

async function getToken() {
  if (
    cachedToken &&
    cachedToken.expiresAtMs - Date.now() > TOKEN_REFRESH_BUFFER_MS
  ) {
    return cachedToken;
  }
  cachedToken = await fetchToken();
  return cachedToken;
}

/**
 * Cheap probe — returns true iff /api/azure-speech-token responds
 * with a usable token. Cached after first call so repeat callers
 * don't re-roundtrip.
 */
let probeResult = null;
export async function isAzureAvailable() {
  if (probeResult != null) return probeResult;
  try {
    await getToken();
    probeResult = true;
  } catch {
    probeResult = false;
  }
  return probeResult;
}

// ---- Recognition -----------------------------------------------

/**
 * Run a single-utterance recognition with pronunciation assessment.
 * Resolves with a structured result that the scoring layer can use,
 * or with `{ error: "..." }` on any failure path.
 *
 * The caller passes `referenceText` (what the learner is supposed
 * to say). For phoneme-level results, set `granularity: "Phoneme"`.
 */
export async function recognizeWithPronunciation(referenceText, opts = {}) {
  const startedAt = Date.now();
  let recognizer;
  mark("entry", { referenceText, opts });
  try {
    const SDK = await loadSdk();
    mark("sdk.loaded", { elapsedMs: Date.now() - startedAt });
    const tok = await getToken();
    mark("token.ready", {
      elapsedMs: Date.now() - startedAt,
      region: tok.region,
      msUntilExpiry: tok.expiresAtMs - Date.now(),
    });
    const speechConfig = SDK.SpeechConfig.fromAuthorizationToken(tok.token, tok.region);
    speechConfig.speechRecognitionLanguage = opts.lang || "en-US";

    // M16-E1: K-2 patience tuning. Default Azure silence timeouts
    // are tuned for fluent adult conversation and cut off hesitant
    // young readers. Bump initial-silence to 8s so a child has time
    // to think before speaking, and end-silence to 2s so trailing
    // breath/processing doesn't end the utterance early.
    try {
      speechConfig.setProperty(
        SDK.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
        "8000",
      );
      speechConfig.setProperty(
        SDK.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
        "2000",
      );
      // Older SDK builds may not have this property; setProperty is
      // forgiving — silently no-ops on unknown enums.
      if (SDK.PropertyId.Speech_SegmentationSilenceTimeoutMs) {
        speechConfig.setProperty(
          SDK.PropertyId.Speech_SegmentationSilenceTimeoutMs,
          "2000",
        );
      }
    } catch (e) {
      console.warn("[azureSpeech] silence-timeout setProperty failed", e);
    }

    const audioConfig = SDK.AudioConfig.fromDefaultMicrophoneInput();
    recognizer = new SDK.SpeechRecognizer(speechConfig, audioConfig);

    // M16-H1: critical lifecycle marks ALWAYS fire. Verbose details
    // (sessionStarted/Stopped, partial results, speechEnd) stay gated.
    let audioStartedAt = null;
    let firstResultAt = null;
    recognizer.sessionStarted = (_s, _e) => dbg("session.started");
    recognizer.sessionStopped = (_s, _e) => dbg("session.stopped");
    recognizer.speechStartDetected = (_s, _e) => {
      audioStartedAt = Date.now();
      mark("speech.start", { elapsedMs: audioStartedAt - startedAt });
    };
    recognizer.speechEndDetected = (_s, _e) => {
      dbg("speech.end", { elapsedMs: Date.now() - startedAt });
    };
    recognizer.recognizing = (_s, e) => {
      if (!firstResultAt) {
        firstResultAt = Date.now();
        mark("recognizing.first", {
          elapsedMs: firstResultAt - startedAt,
          partial: e?.result?.text,
        });
      }
    };
    recognizer.canceled = (_s, e) => {
      // ALWAYS log cancellations — this is the most common reason an
      // Azure recognition fast-fails (mic permission, WebSocket, auth).
      mark("canceled", {
        reason: e?.reason,
        errorCode: e?.errorCode,
        errorDetails: e?.errorDetails,
        elapsedMs: Date.now() - startedAt,
      });
    };

    const paConfig = new SDK.PronunciationAssessmentConfig(
      String(referenceText || ""),
      SDK.PronunciationAssessmentGradingSystem.HundredMark,
      opts.granularity === "Phoneme"
        ? SDK.PronunciationAssessmentGranularity.Phoneme
        : SDK.PronunciationAssessmentGranularity.Word,
      false, // miscue detection — keep off for K-2 noisy mics
    );
    paConfig.applyTo(recognizer);

    mark("recognizeOnce.invoke", {
      referenceText,
      initialSilenceMs: 8000,
      endSilenceMs: 2000,
    });
    const result = await new Promise((resolve, reject) => {
      recognizer.recognizeOnceAsync(resolve, reject);
    });
    mark("recognizeOnce.resolve", {
      reason: result?.reason,
      text: result?.text,
      durationMs: Date.now() - startedAt,
      audioStartedMs: audioStartedAt
        ? audioStartedAt - startedAt
        : null,
    });

    const reason = result?.reason;
    if (reason === SDK.ResultReason.NoMatch) {
      return { error: "no-speech", latencyMs: Date.now() - startedAt };
    }
    if (reason === SDK.ResultReason.Canceled) {
      const cancel = SDK.CancellationDetails.fromResult(result);
      return {
        error: `canceled:${cancel.errorDetails || cancel.reason}`,
        latencyMs: Date.now() - startedAt,
      };
    }

    const transcript = (result?.text || "").trim();
    const pa = SDK.PronunciationAssessmentResult.fromResult(result);
    const accuracy = pa?.accuracyScore ?? null;
    const fluency = pa?.fluencyScore ?? null;
    const completeness = pa?.completenessScore ?? null;
    const prosody = pa?.prosodyScore ?? null;

    // SDK exposes word- and phoneme-level details inside
    // pa.detailResult, which mirrors the JSON shape of the REST API.
    const detail = pa?.detailResult || {};
    const wordsRaw = Array.isArray(detail?.Words) ? detail.Words : [];
    const words = wordsRaw.map((w) => ({
      word: w?.Word || "",
      accuracy: w?.PronunciationAssessment?.AccuracyScore ?? null,
      errorType: w?.PronunciationAssessment?.ErrorType || "None",
    }));
    const phonemes = [];
    for (const w of wordsRaw) {
      const ps = Array.isArray(w?.Phonemes) ? w.Phonemes : [];
      for (const p of ps) {
        phonemes.push({
          phoneme: p?.Phoneme || "",
          accuracy: p?.PronunciationAssessment?.AccuracyScore ?? null,
        });
      }
    }

    return {
      transcript,
      accuracy,
      fluency,
      completeness,
      prosody,
      words,
      phonemes,
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  } catch (err) {
    return {
      error: err?.message || String(err),
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    try { recognizer?.close(); } catch { /* noop */ }
  }
}

/** Test helper: clears the cached token + probe so the next call re-checks env. */
export function __resetAzureCachesForTest() {
  cachedToken = null;
  probeResult = null;
  sdkLoadPromise = null;
}
