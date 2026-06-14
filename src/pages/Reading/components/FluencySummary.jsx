import React from "react";
import { Link } from "react-router-dom";
import { ROUTES } from "../../../config/routes.js";

// End-of-drill summary screen. Personal-best announce is the only
// motivational lever per the Reading Fluency agent's operating principle 5.
// No badges, no streaks, no avatars — just "WCPM" and "personal best".
//
// Props:
//   focalNode        node def (for the small "you drilled this" line)
//   drillScore       { wcpm, accuracy, automaticityRate, wordsAttempted, ... }
//   priorBest        { overall, forNode } before this drill (numbers)
//   isNewOverall     boolean — announce big if true
//   isNewForNode     boolean — announce small if true (and overall not new)
//   onContinue       () => void

export default function FluencySummary({
  focalNode,
  drillScore,
  priorBest,
  isNewOverall,
  isNewForNode,
  onContinue,
}) {
  const headline = isNewOverall
    ? "New personal best"
    : isNewForNode
    ? "New best on this skill"
    : "Drill complete";

  return (
    <div className="ra-fluency-summary">
      <div className="ra-eyebrow">{headline}</div>

      <div className={`ra-fluency-wcpm ${isNewOverall ? "celebrate" : ""}`}>
        {drillScore.wcpm}
      </div>
      <div className="ra-fluency-wcpm-label">WCPM</div>

      <div className="ra-fluency-best-line">
        {isNewOverall && priorBest.overall > 0 && (
          <>Personal best: <strong>{priorBest.overall} → {drillScore.wcpm}</strong></>
        )}
        {isNewOverall && priorBest.overall === 0 && (
          <>Setting your first personal best.</>
        )}
        {!isNewOverall && isNewForNode && priorBest.forNode > 0 && (
          <>Best on this skill: {priorBest.forNode} → {drillScore.wcpm}</>
        )}
        {!isNewOverall && isNewForNode && priorBest.forNode === 0 && (
          <>First drill on this skill.</>
        )}
        {!isNewOverall && !isNewForNode && (
          <>Today: {drillScore.wcpm} WCPM · best {priorBest.overall}</>
        )}
      </div>

      <div className="ra-fluency-summary-stats">
        <div>
          <strong>{drillScore.wordsAttempted}</strong>
          <span>attempted</span>
        </div>
        <div>
          <strong>{drillScore.wordsCorrect}</strong>
          <span>correct</span>
        </div>
        <div>
          <strong>{drillScore.wordsAutomatic}</strong>
          <span>automatic</span>
        </div>
      </div>

      <p className="ra-fluency-summary-sub">
        {focalNode
          ? <>Skill drilled: <code className="ra-id">{focalNode.id}</code> · {focalNode.topic || focalNode.skill}</>
          : "Drill complete."}
      </p>

      <div className="ra-actions" style={{ marginTop: 18 }}>
        <button
          type="button"
          className="ra-btn ra-btn-primary"
          onClick={onContinue}
        >
          Continue
        </button>
        <Link to={ROUTES.READING} className="ra-btn">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
