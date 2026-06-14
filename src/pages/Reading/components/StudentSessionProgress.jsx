// src/pages/Reading/components/StudentSessionProgress.jsx (M16-E5)
//
// Student-facing "Today's work" indicator. One value, one bar, no
// jargon. Shown above the active drill item.

import React from "react";

export default function StudentSessionProgress({ done, target }) {
  const safeTarget = Math.max(1, Number(target) || 0);
  const safeDone = Math.max(0, Math.min(safeTarget, Number(done) || 0));
  const pct = Math.round((safeDone / safeTarget) * 100);
  return (
    <div
      style={{
        marginBottom: 14,
        padding: "10px 14px",
        background: "#f6f7fa",
        borderRadius: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          fontSize: 13,
          color: "#444",
          marginBottom: 6,
        }}
      >
        <span style={{ fontWeight: 600 }}>Today's work</span>
        <span style={{ color: "#666" }}>
          {safeDone} of {safeTarget}
        </span>
      </div>
      <div
        style={{
          height: 8,
          background: "#e5e7eb",
          borderRadius: 999,
          overflow: "hidden",
        }}
        aria-label={`${pct}% of today's work`}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "linear-gradient(90deg, #d4af37, #f0c452)",
            transition: "width 280ms ease-out",
          }}
        />
      </div>
    </div>
  );
}
