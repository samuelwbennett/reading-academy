import React from "react";

// Teacher / debug stats bar (M16-E7). Hidden in normal student mode.
// Shows session accuracy + attempts + last latency + a clamped
// mastery-window progress.
//
// M16-E3 fix: nodeAttemptsCount is the lifetime attempt count and
// masteryWindow is the rolling window size — they live on different
// scales. Previously the UI displayed them as `<lifetime>/<window>`
// which produced impossible values like "20 / 10". The numerator now
// shows attempts within the rolling window only, capped at the
// window size.
//
// Props:
//   sessionAttempts   number — attempts in this drill sitting
//   sessionCorrect    number — correct in this drill sitting
//   lastLatencyMs     number | null
//   nodeAttemptsCount number — total attempts on the active node, all-time
//   masteryProgress   number 0..1 — fraction of rolling window achieved
//   masteryWindow     number — rolling window size

export default function DrillStats({
  sessionAttempts,
  sessionCorrect,
  lastLatencyMs,
  nodeAttemptsCount,
  masteryProgress,
  masteryWindow,
}) {
  const sessionAccuracy = sessionAttempts
    ? Math.round((sessionCorrect / sessionAttempts) * 100)
    : 0;
  const safeWindow = Math.max(1, Number(masteryWindow) || 0);
  const safeProgress = Math.max(0, Math.min(1, Number(masteryProgress) || 0));
  const masteryPct = Math.round(safeProgress * 100);
  // Numerator caps at the window size — never displays "20 / 10".
  const windowNumerator = Math.min(
    safeWindow,
    Math.max(0, Math.round(safeProgress * safeWindow)),
  );

  return (
    <div className="ra-drill-stats">
      <div className="ra-drill-stat">
        <div className="ra-drill-stat-num">{sessionAccuracy}%</div>
        <div className="ra-drill-stat-label">Session accuracy</div>
      </div>
      <div className="ra-drill-stat">
        <div className="ra-drill-stat-num">{sessionAttempts}</div>
        <div className="ra-drill-stat-label">Attempts</div>
      </div>
      <div className="ra-drill-stat">
        <div className="ra-drill-stat-num">
          {Number.isFinite(lastLatencyMs) && lastLatencyMs > 0
            ? `${(lastLatencyMs / 1000).toFixed(1)}s`
            : "—"}
        </div>
        <div className="ra-drill-stat-label">Last latency</div>
      </div>
      <div className="ra-drill-stat ra-drill-stat-wide">
        <div className="ra-drill-stat-label" style={{ marginBottom: 6 }}>
          Mastery window — {windowNumerator} / {safeWindow}
          <span style={{ marginLeft: 8, color: "#aaa", fontSize: 11 }}>
            (lifetime: {nodeAttemptsCount})
          </span>
        </div>
        <div className="ra-progress-bar">
          <div
            className="ra-progress-bar-fill"
            style={{ width: `${Math.min(100, masteryPct)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
