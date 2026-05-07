import React from "react";

export default function ProgressSummary({ counts }) {
  const pct = (counts.pct * 100).toFixed(0);

  return (
    <section className="ra-card">
      <div className="ra-eyebrow">Progress</div>

      <div className="ra-progress-grid">
        <div className="ra-progress-cell">
          <strong>{counts.mastered}</strong>
          <span>mastered</span>
        </div>
        <div className="ra-progress-cell">
          <strong>{counts.inProgress}</strong>
          <span>in progress</span>
        </div>
        <div className="ra-progress-cell">
          <strong>{counts.unlocked}</strong>
          <span>unlocked</span>
        </div>
        <div className="ra-progress-cell">
          <strong>{counts.locked}</strong>
          <span>locked</span>
        </div>
      </div>

      <div className="ra-progress-bar">
        <div className="ra-progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="ra-progress-pct">
        {pct}% complete · {counts.total} total nodes
      </p>
    </section>
  );
}
