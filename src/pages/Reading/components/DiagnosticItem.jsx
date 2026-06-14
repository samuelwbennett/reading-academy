import React, { useEffect, useRef, useState } from "react";
import { speakWord } from "../lib/useSpeechRecognition.js";
import { isTeacherScored } from "../../../lib/assessment";
import MicButton from "./MicButton.jsx";
import ComprehensionItem from "./ComprehensionItem.jsx";
import MorphemeSplitItem from "./MorphemeSplitItem.jsx";

// Phase A/B comprehension families. These are tap-to-pick MCQ items —
// no mic, no read-aloud — so they render through ComprehensionItem
// instead of the mic/teacher card paths below.
const COMPREHENSION_ASSESSMENTS = new Set([
  "vocab_in_context",
  "literal_recall",
  "inference",
  "bg_knowledge",
  "morpheme_meaning",
]);

// Wraps ComprehensionItem for the diagnostic walk. ComprehensionItem
// fires onAdultScore the instant a choice is tapped; we hold ~700ms so
// the correct/incorrect reveal animation can play before the parent
// advances to the next item (mirrors the mic path's post-result pause).
function DiagnosticComprehension({ item, onScore, busy }) {
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    setLocked(false);
  }, [item?.question]);
  return (
    <div className="ra-diag-item">
      <ComprehensionItem
        item={item}
        busy={busy || locked}
        lastResult={null}
        onAdultScore={(correct) => {
          setLocked(true);
          setTimeout(() => onScore?.(correct), 700);
        }}
      />
    </div>
  );
}

// Same hold-then-advance wrapper for the morpheme-split probe.
function DiagnosticMorphemeSplit({ item, onScore, busy }) {
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    setLocked(false);
  }, [item?.word]);
  return (
    <div className="ra-diag-item">
      <MorphemeSplitItem
        item={item}
        busy={busy || locked}
        onAdultScore={(correct) => {
          setLocked(true);
          setTimeout(() => onScore?.(correct), 900);
        }}
      />
    </div>
  );
}

// One diagnostic item.
//
// M16-I1 / M16-I4 — three render modes:
//
//   STUDENT, auto-scorable assessment:
//     Calm prompt + auto-TTS for the stimulus + mic button.
//     The parent route's handleMicTap captures audio, scores it via
//     scoreReadAloudAuto, and calls onScore. NO Correct/Incorrect
//     buttons appear. Soft-retry "I didn't hear you" surfaces here
//     when the engine returns no usable signal.
//
//   STUDENT, teacher-scored assessment (defensive — should never happen
//   because filterAutonomousTestableNodes excludes them):
//     "Teacher check" panel that explains a grown-up does this one.
//     No buttons; the student moves on without scoring.
//
//   TEACHER, any assessment:
//     The legacy teacher-administered card with Correct / Incorrect
//     buttons + the expected-answer hint.
//
// TTS rules per assessment type (unchanged from the legacy version):
//   - read_aloud / cold_passage / letter_sound: do NOT auto-play.
//     A "Hear word" / "Replay" button is still offered for an adult
//     model on demand.
//   - phoneme_isolate_*: speak the prompt word.
//   - phoneme_blend: speak each phoneme one by one with brief gaps.
//   - phoneme_segment: speak the prompt word.
//   - phoneme_delete_* / phoneme_substitute: speak the instruction.
//
// Props:
//   node             — current node def
//   item             — { prompt, answer, phonemes?, instruction?, ... }
//   onScore          — (correct: boolean) => void   (used by teacher path)
//   isStudent        — boolean
//   teacherMode      — boolean
//   speechSupported  — boolean (only used in student mode)
//   listening        — boolean
//   onMicTap         — () => void (parent listens + scores)
//   lastResult       — { correct, transcript, expected, softRetry? } | null
//   busy             — true while parent is committing a result

const PROMPT_LABEL = {
  read_aloud: "Have the student read this word out loud:",
  cold_passage: "Have the student read this word from the passage:",
  phoneme_blend: "Play the phonemes; the student says the whole word:",
  phoneme_segment: "Say the word; the student segments it:",
  phoneme_isolate_initial: "Say the word; the student says the first sound:",
  phoneme_isolate_final: "Say the word; the student says the last sound:",
  phoneme_isolate_medial: "Say the word; the student says the middle vowel sound:",
  phoneme_delete_initial: "Say the word; the student says it without the first sound:",
  phoneme_delete_final: "Say the word; the student says it without the last sound:",
  phoneme_substitute: "Say the change; the student says the new word:",
  letter_sound: "Have the student name the sound for this letter:",
};

const STUDENT_INSTRUCTIONS = {
  read_aloud: "Read the word.",
  phoneme_blend: "Listen, then say the whole word.",
  phoneme_delete_initial: "Listen, then say the new word.",
  phoneme_delete_final: "Listen, then say the new word.",
  phoneme_substitute: "Listen, then say the new word.",
};

const SILENT_ASSESSMENTS = new Set([
  "read_aloud",
  "cold_passage",
  "letter_sound",
]);

function speakPhonemes(phonemes, gapMs = 350) {
  if (!Array.isArray(phonemes) || !phonemes.length) return;
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  phonemes.forEach((p, i) => {
    setTimeout(() => speakWord(p, { rate: 0.7 }), i * gapMs);
  });
}

function playStimulus(node, item) {
  if (!node || !item) return;
  if (SILENT_ASSESSMENTS.has(node.assessment)) return;

  if (node.assessment === "phoneme_blend" && Array.isArray(item.phonemes)) {
    speakPhonemes(item.phonemes);
    return;
  }
  if (
    node.assessment === "phoneme_substitute" ||
    node.assessment === "phoneme_delete_initial" ||
    node.assessment === "phoneme_delete_final"
  ) {
    if (item.instruction) {
      speakWord(item.instruction, { rate: 0.85 });
      return;
    }
  }
  // Default: speak the prompt word once.
  if (item.prompt) speakWord(item.prompt, { rate: 0.85 });
}

export default function DiagnosticItem({
  node,
  item,
  onScore,
  isStudent = false,
  teacherMode = false,
  speechSupported = false,
  listening = false,
  onMicTap,
  lastResult = null,
  busy = false,
}) {
  const expected = item.answer && item.answer !== item.prompt ? item.answer : null;
  const playedKeyRef = useRef(null);

  // Auto-play TTS once per item.
  useEffect(() => {
    const key = `${node?.id}|${item?.prompt}`;
    if (playedKeyRef.current === key) return;
    playedKeyRef.current = key;
    const t = setTimeout(() => playStimulus(node, item), 250);
    return () => clearTimeout(t);
  }, [node, item]);

  const replay = () => playStimulus(node, item);

  // ---- Comprehension MCQ (Phase A/B): tap-to-pick, no mic. ----
  // Renders for student AND teacher modes — these items are
  // self-scoring (the choice the student taps IS the verdict).
  if (COMPREHENSION_ASSESSMENTS.has(node?.assessment)) {
    return (
      <DiagnosticComprehension item={item} onScore={onScore} busy={busy} />
    );
  }

  // ---- Morpheme split (Phase C): tap-the-gap word segmenting. ----
  if (node?.assessment === "morpheme_split") {
    return (
      <DiagnosticMorphemeSplit item={item} onScore={onScore} busy={busy} />
    );
  }

  // ---- Student + teacher-scored: friendly "teacher check" panel. ----
  // Defensive — the autonomous filter excludes these, but if a teacher
  // mid-session manually flips the URL or the data changes, never show a
  // student a Correct/Incorrect button.
  if (isStudent && !teacherMode && isTeacherScored(node?.assessment)) {
    return (
      <div className="ra-diag-item">
        <div style={{ fontSize: 36, lineHeight: 1, marginBottom: 8 }} aria-hidden>
          🧑‍🏫
        </div>
        <h3 className="ra-card-title" style={{ marginTop: 0 }}>
          Teacher check
        </h3>
        <p className="ra-card-sub">
          A grown-up checks this one with you in person. You can skip it
          now — your placement keeps going on the parts you can do on
          your own.
        </p>
        <div className="ra-actions" style={{ marginTop: 18 }}>
          <button
            type="button"
            className="ra-btn ra-btn-primary"
            onClick={() => onScore?.(false)}
            disabled={busy}
          >
            Skip and keep going
          </button>
        </div>
      </div>
    );
  }

  // ---- Student, auto-scorable: mic-driven scoring. ----
  if (isStudent && !teacherMode) {
    const studentInstruction =
      STUDENT_INSTRUCTIONS[node.assessment] || "Say it out loud.";
    const verdict = lastResult
      ? lastResult.softRetry
        ? "retry"
        : lastResult.correct
          ? "correct"
          : "incorrect"
      : null;
    // M16-J2: never show the prompt word for phoneme blending — the
    // prompt IS the answer, and showing it turns the task into a read
    // test. Filter excludes phoneme_blend from autonomous mode anyway,
    // but be defensive in case it ever leaks through.
    const hidePromptWord = node?.assessment === "phoneme_blend";
    const phonemeLabels = Array.isArray(item?.phonemeLabels)
      ? item.phonemeLabels.join(" ")
      : null;
    return (
      <div className="ra-diag-item">
        <p className="ra-card-sub" style={{ marginTop: 0 }}>
          {studentInstruction}
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
        {!hidePromptWord && (
          <div className="ra-drill-prompt" aria-label="prompt">
            {item.prompt}
          </div>
        )}
        {hidePromptWord && phonemeLabels && (
          <div
            style={{
              textAlign: "center",
              fontSize: 32,
              letterSpacing: 4,
              color: "#666",
              margin: "20px 0",
            }}
          >
            {phonemeLabels}
          </div>
        )}
        {!SILENT_ASSESSMENTS.has(node.assessment) && (
          <div className="ra-drill-helpers" style={{ marginTop: 8 }}>
            <button type="button" className="ra-link" onClick={replay}>
              ▶︎ Replay
            </button>
          </div>
        )}

        {speechSupported ? (
          <MicButton
            listening={listening}
            disabled={busy}
            onTap={onMicTap}
          />
        ) : (
          <div className="ra-drill-fallback-note">
            The microphone isn't ready yet. Ask an adult for help.
          </div>
        )}

        {verdict === "retry" && (
          <div className="ra-drill-feedback retry">
            <div
              className="ra-drill-feedback-row"
              style={{ color: "#666", fontSize: 14 }}
            >
              I didn't hear you. Tap the mic and try again.
            </div>
          </div>
        )}
        {verdict === "correct" && (
          <div className="ra-drill-feedback correct">
            <div className="ra-drill-feedback-row">
              <strong>Got it!</strong>
            </div>
          </div>
        )}
        {verdict === "incorrect" && (
          <div className="ra-drill-feedback incorrect">
            <div className="ra-drill-feedback-row">
              <strong>Not quite — moving on.</strong>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---- Teacher mode (or anonymous-non-student debug): legacy card. ----
  const instruction = PROMPT_LABEL[node.assessment] || "Have the student respond:";
  return (
    <div className="ra-diag-item">
      <p className="ra-diag-instruction">{instruction}</p>
      <div className="ra-diag-prompt" aria-label="prompt">
        {item.prompt}
      </div>
      {!SILENT_ASSESSMENTS.has(node.assessment) && (
        <div className="ra-drill-helpers" style={{ marginTop: 8 }}>
          <button type="button" className="ra-link" onClick={replay}>
            ▶︎ Replay
          </button>
        </div>
      )}
      {expected && (
        <p className="ra-diag-expected">
          Expected: <strong>{expected}</strong>
        </p>
      )}
      <div className="ra-diag-actions">
        <button
          type="button"
          className="ra-btn ra-btn-incorrect"
          onClick={() => onScore(false)}
          disabled={busy}
        >
          Incorrect
        </button>
        <button
          type="button"
          className="ra-btn ra-btn-correct"
          onClick={() => onScore(true)}
          disabled={busy}
        >
          Correct
        </button>
      </div>
    </div>
  );
}
