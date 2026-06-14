import React, { useEffect, useRef, useState } from "react";
import { useStudentMode } from "../../../lib/auth/useStudentMode.js";

/**
 * ComprehensionItem — the Phase A renderer for tap-to-pick MCQ items.
 *
 * Handles four assessment families introduced in Phase A:
 *   - vocab_in_context  → just question + 4 choices
 *   - literal_recall    → passage + question + 4 choices
 *   - inference         → passage + question + 4 choices
 *   - bg_knowledge      → short reading + question + 4 choices
 *
 * Behavioral notes:
 *   - No ASR. No mic. Pure tap.
 *   - Latency is measured from item-present to first-tap.
 *   - Wrong choice → red ring + bouncing the right answer; student
 *     can NOT retry — we record the verdict and advance, consistent
 *     with the mastery engine's single-shot expectation.
 *   - Item shape: { passage?, question, choices: [string, ...], answer: string }
 *     answer must exactly equal one of the choices.
 *
 * Props:
 *   item        — the current MCQ item
 *   onAdultScore  — (correct, latencyMs) => void  (same name as DrillItem
 *                 to reuse Drill route's scoring callback)
 *   lastResult  — { correct, latencyMs } from prior attempt, or null
 *   busy        — debounce while committing
 */
export default function ComprehensionItem({
  item,
  onAdultScore,
  lastResult,
  busy,
}) {
  const isStudent = useStudentMode();
  const presentedAtRef = useRef(Date.now());
  const [picked, setPicked] = useState(null);

  // Reset on item change.
  useEffect(() => {
    presentedAtRef.current = Date.now();
    setPicked(null);
  }, [item?.question]);

  function handlePick(choice) {
    if (busy || picked) return;
    const latencyMs = Date.now() - presentedAtRef.current;
    setPicked(choice);
    const correct = choice === item.answer;
    onAdultScore?.(correct, latencyMs);
  }

  return (
    <div className="ra-comp-item">
      {item.passage && (
        <div className="ra-comp-passage" aria-label="Passage to read">
          {item.passage}
        </div>
      )}

      <div className="ra-comp-question">{item.question}</div>

      <div className="ra-comp-choices">
        {(item.choices || []).map((choice, i) => {
          let cls = "ra-comp-choice";
          if (picked === choice) {
            cls += choice === item.answer ? " correct" : " incorrect";
          } else if (picked && choice === item.answer) {
            cls += " correct-reveal";
          }
          return (
            <button
              key={i}
              type="button"
              className={cls}
              onClick={() => handlePick(choice)}
              disabled={!!picked || busy}
            >
              {choice}
            </button>
          );
        })}
      </div>

      {lastResult && (
        <div className={`ra-comp-feedback ${lastResult.correct ? "correct" : "incorrect"}`}>
          {lastResult.correct ? (
            <strong>Right!</strong>
          ) : (
            <>
              <strong>Not quite.</strong>{" "}
              The answer is <em>{item.answer}</em>.
            </>
          )}
          {Number.isFinite(lastResult.latencyMs) && !isStudent && (
            <span className="ra-comp-feedback-latency">
              {" "}{(lastResult.latencyMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      )}
    </div>
  );
}
