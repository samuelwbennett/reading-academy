import React, { useEffect, useRef, useState } from "react";

/**
 * MorphemeSplitItem — Phase C tap-to-split word-segmenting renderer.
 *
 * The student breaks an (often unseen) word into its morphemes by
 * tapping the gaps between letters. This is the "novel-word probe" the
 * Science-of-Reading design canon calls for: morphology mastery means
 * decomposing unseen words by rule, not picking a meaning from a list.
 *
 * Item shape: { word: "unhelpful", parts: ["un", "help", "ful"] }
 *   parts.join("") must equal word — the surface spelling is the plain
 *   concatenation of the morphemes (no spelling-change words here).
 *
 * Behaviour:
 *   - Tap a gap to place / remove a split. Multi-tap, then "Check".
 *   - Single-shot: once checked, the verdict is locked (matches the
 *     mastery engine's no-retry expectation). The reveal shows the
 *     student's splits against the correct boundaries.
 *
 * Props:
 *   item         — { word, parts }
 *   onAdultScore — (correct, latencyMs) => void  (same contract as
 *                  ComprehensionItem — reuses the Drill scoring path)
 *   busy         — debounce while committing
 */
export default function MorphemeSplitItem({ item, onAdultScore, busy }) {
  const presentedAtRef = useRef(Date.now());
  const [splits, setSplits] = useState(() => new Set());
  const [verdict, setVerdict] = useState(null); // { correct } once checked

  const word = item?.word || "";
  const parts = Array.isArray(item?.parts) ? item.parts : [];

  // Expected split positions = running letter counts between parts.
  // parts ["un","help","ful"] → splits at 2 and 6.
  const expected = new Set();
  {
    let acc = 0;
    for (let i = 0; i < parts.length - 1; i += 1) {
      acc += parts[i].length;
      expected.add(acc);
    }
  }

  // Reset whenever the word changes (parent remounts via key, but guard
  // anyway so an in-place item swap can't carry stale splits).
  useEffect(() => {
    presentedAtRef.current = Date.now();
    setSplits(new Set());
    setVerdict(null);
  }, [item?.word]);

  const checked = verdict != null;

  function toggleGap(pos) {
    if (busy || checked) return;
    setSplits((prev) => {
      const next = new Set(prev);
      if (next.has(pos)) next.delete(pos);
      else next.add(pos);
      return next;
    });
  }

  function handleCheck() {
    if (busy || checked) return;
    const latencyMs = Date.now() - presentedAtRef.current;
    const correct =
      splits.size === expected.size &&
      [...expected].every((p) => splits.has(p));
    setVerdict({ correct });
    onAdultScore?.(correct, latencyMs);
  }

  const letters = word.split("");

  return (
    <div className="ra-mseg-item">
      <p className="ra-mseg-instruction">
        Tap between the letters to break this word into its parts.
      </p>

      <div className="ra-mseg-word" aria-label={`Word: ${word}`}>
        {letters.map((ch, i) => {
          const gapPos = i + 1; // gap sits after letter i
          const isLast = i === letters.length - 1;
          let gapCls = "ra-mseg-gap";
          if (splits.has(gapPos)) gapCls += " split";
          if (checked) {
            if (expected.has(gapPos)) gapCls += " expected";
            if (splits.has(gapPos) && !expected.has(gapPos)) gapCls += " wrong";
          }
          return (
            <React.Fragment key={i}>
              <span className="ra-mseg-letter">{ch}</span>
              {!isLast && (
                <button
                  type="button"
                  className={gapCls}
                  onClick={() => toggleGap(gapPos)}
                  disabled={busy || checked}
                  aria-label={`Split after letter ${i + 1}`}
                >
                  <span className="ra-mseg-gap-bar" />
                </button>
              )}
            </React.Fragment>
          );
        })}
      </div>

      {!checked && (
        <div className="ra-actions" style={{ marginTop: 18 }}>
          <button
            type="button"
            className="ra-btn ra-btn-primary"
            onClick={handleCheck}
            disabled={busy}
          >
            Check
          </button>
        </div>
      )}

      {checked && (
        <div
          className={`ra-comp-feedback ${verdict.correct ? "correct" : "incorrect"}`}
        >
          {verdict.correct ? (
            <strong>Right! {parts.join(" + ")}</strong>
          ) : (
            <>
              <strong>Not quite.</strong> The parts are{" "}
              <em>{parts.join(" + ")}</em>.
            </>
          )}
        </div>
      )}
    </div>
  );
}
