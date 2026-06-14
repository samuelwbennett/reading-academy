import React from "react";

// Final screen after the diagnostic walk. Lists tested nodes and their
// pass/stop verdict, names the active node, and offers a single Continue
// action that returns to /reading. No re-take in M1-B (kept simple);
// student can re-run diagnostic from the dashboard reset.

export default function PlacementSummary({ results, activeNode, onContinue }) {
  return (
    <div className="ra-diag-summary">
      <p className="ra-eyebrow">Placement complete</p>
      <h2 className="ra-card-title">
        {activeNode
          ? <>Starting at <strong>{activeNode.topic || activeNode.skill}</strong></>
          : "All checks passed"}
      </h2>
      {activeNode ? (
        <p className="ra-card-sub">
          {activeNode.strand} · this is the first skill that needs practice.
        </p>
      ) : (
        <p className="ra-card-sub">
          Every testable skill came back at full marks. The next available
          skill in the graph will be picked up from the dashboard.
        </p>
      )}

      <ul className="ra-diag-results">
        {results.map((r) => {
          const passed = r.correctCount >= r.total;
          return (
            <li key={r.nodeId} className={`ra-diag-result ${passed ? "passed" : "stopped"}`}>
              <span className={`ra-dot ra-dot-${passed ? "mastered" : "active"}`} />
              <span className="ra-diag-result-text">
                <span className="ra-diag-result-name">{r.label}</span>
                <span className="ra-diag-result-score">
                  {r.correctCount}/{r.total} correct · {passed ? "Mastered" : "Placement"}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      <div className="ra-actions" style={{ marginTop: 18 }}>
        <button type="button" className="ra-btn ra-btn-primary" onClick={onContinue}>
          Continue to Reading Academy
        </button>
      </div>
    </div>
  );
}
