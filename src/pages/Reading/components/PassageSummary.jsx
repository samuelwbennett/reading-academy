import React from "react";

// End-of-drill summary for a passage attempt. Shows WCPM and accuracy with
// a clear pass/fail verdict against the gate's mastery thresholds (when the
// passage is for a fluency gate).
//
// Props:
//   passage     the passage object
//   gateNode    the FL_xx node def or null
//   score       { wcpm, accuracy, correctWords, totalExpected, totalAttempted, durationMs }
//   onContinue  () => void

function formatPct(n) {
  return `${Math.round((n || 0) * 100)}%`;
}

export default function PassageSummary({ passage, gateNode, score, onContinue }) {
  const targetWcpm = gateNode?.mastery?.wcpm_min ?? null;
  const targetAccuracy = gateNode?.mastery?.passage_accuracy ?? null;
  const passes = targetWcpm != null && targetAccuracy != null
    ? score.wcpm >= targetWcpm && score.accuracy >= targetAccuracy
    : null;

  return (
    <div className="ra-passage-summary">
      <div className="ra-eyebrow">{passes === true ? "Gate cleared" : passes === false ? "Below the gate" : "Reading complete"}</div>
      <div className="ra-fluency-wcpm">{score.wcpm}</div>
      <div className="ra-fluency-wcpm-label">WCPM</div>

      <div className="ra-fluency-best-line">
        Accuracy <strong>{formatPct(score.accuracy)}</strong>
        {targetWcpm != null && (
          <> · Target: ≥{targetWcpm} WCPM, ≥{formatPct(targetAccuracy)} accuracy</>
        )}
      </div>

      <div className="ra-fluency-summary-stats">
        <div>
          <strong>{score.correctWords}</strong>
          <span>correct</span>
        </div>
        <div>
          <strong>{score.totalExpected}</strong>
          <span>expected</span>
        </div>
        <div>
          <strong>{score.totalAttempted}</strong>
          <span>spoken</span>
        </div>
      </div>

      <p className="ra-fluency-summary-sub">
        {passage?.topic ? <>"{passage.topic}" · </> : null}
        {gateNode ? <>Gate: <code className="ra-id">{gateNode.id}</code></> : "Practice passage"}
      </p>

      <div className="ra-actions" style={{ marginTop: 18 }}>
        <button
          type="button"
          className="ra-btn ra-btn-primary"
          onClick={onContinue}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
