// src/pages/Reading/components/FluencyChart.jsx
//
// Tiny inline SVG line chart for cold-vs-practiced WCPM over time.
// Zero deps. Sized for a teacher dashboard card; no axis labels for
// values that vary too much from gate to gate — just a labeled X
// axis (chronological) and Y axis tick at the personal best.

import React, { useMemo } from "react";

const W = 560;
const H = 180;
const PAD = { top: 16, right: 16, bottom: 28, left: 36 };

export default function FluencyChart({ history, personalBest }) {
  const points = useMemo(() => {
    if (!Array.isArray(history) || history.length === 0) return null;
    const xs = history.map((_, i) => i);
    const ys = history.map((h) => h.wcpm ?? 0);
    const max = Math.max(personalBest ?? 0, ...ys, 60);
    const min = 0;
    const xScale = (i) =>
      PAD.left +
      (i * (W - PAD.left - PAD.right)) / Math.max(1, history.length - 1);
    const yScale = (v) =>
      H - PAD.bottom - ((v - min) * (H - PAD.top - PAD.bottom)) / Math.max(1, max - min);
    return { xs, ys, max, xScale, yScale };
  }, [history, personalBest]);

  if (!points) {
    return (
      <div style={{ color: "#999", fontStyle: "italic", padding: 12 }}>
        no passage attempts yet
      </div>
    );
  }

  const { xScale, yScale, max } = points;
  const path = history
    .map((h, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(h.wcpm)}`)
    .join(" ");
  const pbY = yScale(personalBest ?? 0);

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      style={{ maxWidth: W, display: "block" }}
      role="img"
      aria-label="Fluency over time"
    >
      {/* axes */}
      <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} stroke="#ddd" />
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} stroke="#ddd" />

      {/* personal best line */}
      {personalBest > 0 && (
        <>
          <line
            x1={PAD.left}
            y1={pbY}
            x2={W - PAD.right}
            y2={pbY}
            stroke="#a4d"
            strokeDasharray="4 3"
          />
          <text x={W - PAD.right} y={pbY - 4} fontSize="10" fill="#a4d" textAnchor="end">
            best {Math.round(personalBest)} WCPM
          </text>
        </>
      )}

      {/* trend line */}
      <path d={path} fill="none" stroke="#27a" strokeWidth="2" />

      {/* points (cold = filled, practiced = hollow) */}
      {history.map((h, i) => (
        <circle
          key={i}
          cx={xScale(i)}
          cy={yScale(h.wcpm)}
          r={4}
          fill={h.isCold ? "#27a" : "white"}
          stroke="#27a"
          strokeWidth={2}
        />
      ))}

      {/* y-axis ticks */}
      {[0, Math.round(max / 2), Math.round(max)].map((v) => (
        <g key={v}>
          <line x1={PAD.left - 3} x2={PAD.left} y1={yScale(v)} y2={yScale(v)} stroke="#aaa" />
          <text x={PAD.left - 6} y={yScale(v) + 3} fontSize="10" fill="#888" textAnchor="end">
            {v}
          </text>
        </g>
      ))}

      {/* x-axis label */}
      <text x={(W - PAD.right + PAD.left) / 2} y={H - 6} fontSize="10" fill="#888" textAnchor="middle">
        attempt → most recent →
      </text>

      {/* legend */}
      <g transform={`translate(${PAD.left + 6}, ${PAD.top + 6})`}>
        <circle cx={4} cy={4} r={4} fill="#27a" />
        <text x={12} y={7} fontSize="10" fill="#666">cold</text>
        <circle cx={50} cy={4} r={4} fill="white" stroke="#27a" strokeWidth={2} />
        <text x={58} y={7} fontSize="10" fill="#666">practiced</text>
      </g>
    </svg>
  );
}
