// src/pages/Reading/components/PhonemeAsrItem.jsx (M16-B2)
//
// Mic-first PA drill item. For PA tasks whose answer is a complete
// word — phoneme_blend, phoneme_delete_initial, phoneme_delete_final,
// phoneme_substitute — the student hears/sees the prompt, speaks the
// answer, and ASR (Azure preferred, Web Speech fallback) scores it.
//
// No teacher tap in normal student mode (per the M16-B architecture
// rule). Manual override is gated behind `teacherMode` prop, which
// the Drill route passes when ?teacher=1 or the signed-in user is
// a teacher/admin.
//
// TTS rules per assessment:
//   - phoneme_blend: speak each phoneme one by one, gapped, then
//     wait for the student to say the whole word
//   - phoneme_delete_initial / phoneme_delete_final / phoneme_substitute:
//     speak the instruction verbatim ("Say stop without the /s/")
//
// The expected answer string for ASR comes from item.answer (the
// post-operation word: "top" for stop-minus-/s/).

import React, { useEffect, useRef, useState } from "react";
import { speakWord } from "../lib/useSpeechRecognition.js";
import MicButton from "./MicButton.jsx";

const FAST_FEEDBACK = ["Lightning fast!", "Snap!", "Quick!"];
const CORRECT_FEEDBACK = ["Nice!", "Got it.", "Yep!", "Excellent.", "Right on."];
const TRY_AGAIN_FEEDBACK = [
  "Almost — try again.",
  "Close! One more shot.",
  "Not yet — keep going.",
  "Try once more.",
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

const INSTRUCTIONS = {
  phoneme_blend: "Listen to the sounds. Say the whole word.",
  phoneme_delete_initial: "Listen, then say the new word.",
  phoneme_delete_final: "Listen, then say the new word.",
  phoneme_substitute: "Listen, then say the new word.",
};

export default function PhonemeAsrItem({
  node,
  item,
  speechSupported,
  listening,
  onMicTap,
  onAdultScore, // optional — only used in teacherMode
  lastResult,
  busy,
  teacherMode = false,
}) {
  const presentedAtRef = useRef(Date.now());
  const playedKeyRef = useRef(null);

  // Auto-play stimulus + reset stopwatch on each new item.
  useEffect(() => {
    presentedAtRef.current = Date.now();
    const key = `${node?.id}|${item?.prompt}`;
    if (playedKeyRef.current === key) return;
    playedKeyRef.current = key;
    const t = setTimeout(() => playStimulus(node?.assessment, item), 200);
    return () => clearTimeout(t);
  }, [node?.id, node?.assessment, item?.prompt]);

  const replay = () => playStimulus(node?.assessment, item);

  const handleAdult = (correct) => {
    if (busy || !teacherMode) return;
    const latencyMs = Date.now() - presentedAtRef.current;
    onAdultScore?.(correct, latencyMs);
  };

  // M16-F2: softRetry = engine never heard audio. Render as a neutral
  // "try again" prompt instead of "Almost — try again."
  const verdict = lastResult
    ? lastResult.softRetry
      ? "retry"
      : lastResult.correct
        ? "correct"
        : "incorrect"
    : null;

  const expectedLabel =
    item?.answer && item.answer !== item?.prompt ? item.answer : null;
  const phonemeLabels = Array.isArray(item?.phonemeLabels)
    ? item.phonemeLabels.join(" ")
    : null;

  return (
    <div className="ra-drill-item">
      <p className="ra-card-sub" style={{ marginTop: 0 }}>
        {INSTRUCTIONS[node?.assessment] || "Listen, then speak your answer."}
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
      >
        {item?.prompt ?? ""}
      </div>

      {phonemeLabels && (
        <div
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

      <div className="ra-drill-helpers" style={{ marginTop: 8 }}>
        <button type="button" className="ra-link" onClick={replay}>
          ▶︎ Replay
        </button>
      </div>

      {speechSupported ? (
        <MicButton listening={listening} disabled={busy} onTap={onMicTap} />
      ) : (
        <div className="ra-drill-fallback-note">
          {teacherMode
            ? "Mic recognition needs Chrome, Edge, or Safari. Use teacher mode buttons below."
            : "The microphone isn't ready yet. Ask an adult for help."}
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
          {teacherMode && lastResult.transcript && (
            <div className="ra-drill-feedback-heard">
              Heard: <em>"{lastResult.transcript}"</em>
              {expectedLabel && <> · expected <strong>{expectedLabel}</strong></>}
            </div>
          )}
          {!teacherMode && lastResult.error && lastResult.error !== "no-speech" && (
            <div
              className="ra-drill-feedback-error"
              style={{ color: "#888", fontSize: 13, marginTop: 6 }}
            >
              Didn't catch that — tap the mic to try again.
            </div>
          )}
        </div>
      )}

      {teacherMode && (
        <div className="ra-drill-override">
          <div
            className="ra-drill-override-label"
            style={{ color: "#a72", fontSize: 11 }}
          >
            Teacher override (debug only — not visible in normal student mode)
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
