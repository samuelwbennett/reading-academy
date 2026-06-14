import React, { useEffect, useRef } from "react";
import { speakWord } from "../lib/useSpeechRecognition.js";

// Phoneme-level drill item. Handles every PA assessment type plus
// letter_sound. TTS is the primary stimulus; teacher self-scoring
// is the response path.
//
// Why not Web Speech API for scoring? Web Speech recognizes whole
// words, not isolated phonemes. /s/ vs /sh/ vs "ess" all collapse to
// nearly-identical text on Chrome's recognizer. Adult tap is the
// reliable signal; the Web Speech path stays for read_aloud (DrillItem).
//
// Auto-plays the relevant stimulus on mount + on item change. A
// "Replay" button lets the teacher repeat without rewinding.
//
// Props:
//   node:        skill node def (for assessment type)
//   item:        { prompt, answer, phonemes?, instruction?, ... }
//   onAdultScore (correct: boolean, latencyMs: number) => void
//   lastResult:  { correct, latencyMs, ... } | null
//   busy:        true while the parent is committing the previous attempt

const INSTRUCTIONS = {
  phoneme_isolate_initial: "Say the word. Student says the first sound.",
  phoneme_isolate_final: "Say the word. Student says the last sound.",
  phoneme_isolate_medial: "Say the word. Student says the middle vowel sound.",
  phoneme_blend: "Play the phonemes. Student blends them into the word.",
  phoneme_segment: "Say the word. Student segments each sound.",
  phoneme_delete_initial: "Read the instruction. Student says the new word.",
  phoneme_delete_final: "Read the instruction. Student says the new word.",
  phoneme_substitute: "Read the instruction. Student says the new word.",
  letter_sound: "Student names the sound for this letter.",
};

const SILENT_ASSESSMENTS = new Set(["letter_sound"]);

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

function speakPhonemes(phonemes, gapMs = 380) {
  if (!Array.isArray(phonemes) || !phonemes.length) return;
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  phonemes.forEach((p, i) => {
    setTimeout(() => speakWord(p, { rate: 0.7 }), i * gapMs);
  });
}

function playStimulus(assessment, item) {
  if (!item) return;
  if (SILENT_ASSESSMENTS.has(assessment)) return;
  if (assessment === "phoneme_blend" && Array.isArray(item.phonemes)) {
    speakPhonemes(item.phonemes);
    return;
  }
  if (
    assessment === "phoneme_substitute" ||
    assessment === "phoneme_delete_initial" ||
    assessment === "phoneme_delete_final"
  ) {
    if (item.instruction) {
      speakWord(item.instruction, { rate: 0.85 });
      return;
    }
  }
  if (item.prompt) speakWord(item.prompt, { rate: 0.85 });
}

export default function PhonemeItem({
  node,
  item,
  onAdultScore,
  lastResult,
  busy,
}) {
  const presentedAtRef = useRef(Date.now());
  const playedKeyRef = useRef(null);

  // Auto-play stimulus + reset stopwatch each time the item changes.
  useEffect(() => {
    presentedAtRef.current = Date.now();
    const key = `${node?.id}|${item?.prompt}`;
    if (playedKeyRef.current === key) return;
    playedKeyRef.current = key;
    const t = setTimeout(() => playStimulus(node?.assessment, item), 200);
    return () => clearTimeout(t);
  }, [node?.id, node?.assessment, item?.prompt]);

  const handleAdult = (correct) => {
    if (busy) return;
    const latencyMs = Date.now() - presentedAtRef.current;
    onAdultScore?.(correct, latencyMs);
  };

  const replay = () => playStimulus(node?.assessment, item);

  const verdict = lastResult
    ? lastResult.correct
      ? "correct"
      : "incorrect"
    : null;

  const expectedLabel = item?.answer && item.answer !== item?.prompt
    ? item.answer
    : null;
  const phonemeLabels = Array.isArray(item?.phonemeLabels)
    ? item.phonemeLabels.join(" ")
    : null;
  const isLetterSound = node?.assessment === "letter_sound";

  return (
    <div className="ra-drill-item">
      <p className="ra-card-sub" style={{ marginTop: 0 }}>
        {INSTRUCTIONS[node?.assessment] || "Have the student respond."}
      </p>

      {item?.instruction && (
        <p
          className="ra-drill-instruction"
          style={{
            fontSize: "1.05rem",
            lineHeight: 1.4,
            margin: "10px 0 18px",
            color: "#333",
          }}
        >
          {item.instruction}
        </p>
      )}

      <div
        className="ra-drill-prompt"
        aria-label={`Prompt: ${item?.prompt ?? ""}`}
        style={isLetterSound ? { fontSize: "5rem" } : undefined}
      >
        {item?.prompt ?? ""}
      </div>

      {phonemeLabels && (
        <div
          className="ra-drill-phonemes"
          style={{
            textAlign: "center",
            marginTop: 8,
            color: "#666",
            letterSpacing: 2,
          }}
        >
          {phonemeLabels}
        </div>
      )}

      {expectedLabel && (
        <p className="ra-diag-expected" style={{ marginTop: 12 }}>
          Expected: <strong>{expectedLabel}</strong>
        </p>
      )}

      {!SILENT_ASSESSMENTS.has(node?.assessment) && (
        <div className="ra-drill-helpers">
          <button type="button" className="ra-link" onClick={replay}>
            ▶︎ Replay
          </button>
        </div>
      )}

      {lastResult && (
        <div className={`ra-drill-feedback ${verdict}`}>
          <div className="ra-drill-feedback-row">
            <span
              className={`ra-dot ra-dot-${
                verdict === "correct" ? "mastered" : "active"
              }`}
            />
            <strong>{pickFeedback(verdict, lastResult.latencyMs)}</strong>
            {Number.isFinite(lastResult.latencyMs) && (
              <span className="ra-drill-feedback-latency">
                {(lastResult.latencyMs / 1000).toFixed(2)}s
              </span>
            )}
          </div>
        </div>
      )}

      <div className="ra-drill-override">
        <div className="ra-drill-override-label">Score the response</div>
        <div className="ra-actions">
          <button
            type="button"
            className="ra-btn ra-btn-incorrect"
            onClick={() => handleAdult(false)}
            disabled={busy}
          >
            Incorrect
          </button>
          <button
            type="button"
            className="ra-btn ra-btn-correct"
            onClick={() => handleAdult(true)}
            disabled={busy}
          >
            Correct
          </button>
        </div>
      </div>
    </div>
  );
}
