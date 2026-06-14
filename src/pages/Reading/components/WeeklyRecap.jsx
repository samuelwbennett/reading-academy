// src/pages/Reading/components/WeeklyRecap.jsx
//
// Fetches /api/recap for the signed-in student and renders the
// AI-generated narrative + the supporting stats. Falls back to the
// deterministic template when no Anthropic key is configured (the
// `llmUsed` flag in the response tells us which).

import React, { useEffect, useState } from "react";

export default function WeeklyRecap({ studentId, days = 7 }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function load() {
    if (!studentId) return;
    setLoading(true);
    setError(null);
    try {
      const url = `/api/recap?student=${encodeURIComponent(studentId)}&days=${days}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`recap returned ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId, days]);

  if (!studentId) {
    return (
      <div style={{ color: "#999", fontStyle: "italic" }}>
        sign in to fetch a weekly recap from your saved telemetry
      </div>
    );
  }
  if (loading) return <div style={{ color: "#888" }}>Generating recap…</div>;
  if (error) {
    return (
      <div style={{ color: "#c33" }}>
        Recap failed: {error}
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            onClick={load}
            style={{
              fontSize: 12,
              padding: "3px 8px",
              border: "1px solid #ccc",
              background: "white",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div>
      <p
        style={{
          margin: "0 0 12px",
          fontSize: 15,
          lineHeight: 1.5,
          color: "#222",
        }}
      >
        {data.recap}
      </p>
      <StatsRow stats={data.stats} />
      <p style={{ fontSize: 11, color: "#999", marginTop: 8 }}>
        last {data.days} days · {data.llmUsed ? "AI-generated" : "deterministic template"} ·{" "}
        <button
          type="button"
          onClick={load}
          style={{
            background: "none",
            border: "none",
            color: "#27a",
            cursor: "pointer",
            padding: 0,
            fontSize: 11,
          }}
        >
          refresh
        </button>
      </p>
    </div>
  );
}

function StatsRow({ stats }) {
  if (!stats) return null;
  const cells = [
    { label: "attempts", value: stats.attempts },
    { label: "correct rate", value: `${Math.round((stats.correctRate ?? 0) * 100)}%` },
    { label: "mastered", value: stats.masteredCount ?? 0 },
    { label: "cold reads", value: stats.coldReadCount ?? 0 },
    { label: "best WCPM", value: stats.fluencyTopWcpm > 0 ? Math.round(stats.fluencyTopWcpm) : "—" },
  ];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(5, 1fr)",
        gap: 8,
        marginTop: 8,
      }}
    >
      {cells.map((c) => (
        <div
          key={c.label}
          style={{
            border: "1px solid #eee",
            borderRadius: 6,
            padding: "6px 8px",
            background: "#fafafa",
          }}
        >
          <div style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>
            {c.label}
          </div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}
