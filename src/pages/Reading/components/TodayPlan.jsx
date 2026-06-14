// src/pages/Reading/components/TodayPlan.jsx
//
// Renders the session orchestrator's plan as the primary content of
// Today. Each block is a card with a heading, a subtitle, and a single
// "Start" action that routes to the right surface.
//
// Empty state collapses gracefully — Today falls back to the legacy
// TodaySession card below.

import React from "react";
import { Link } from "react-router-dom";

const ROUTE_FOR_KIND = {
  review: "/reading/drill",
  drill: "/reading/drill",
  fluency: "/reading/fluency",
  cold_passage: "/reading/passage",
};

const ICON_FOR_KIND = {
  review: "↻",
  drill: "📖",
  fluency: "⚡",
  cold_passage: "🧊",
};

const REASON_LABEL = {
  due: "Review due",
  forgetting_risk: "At risk of forgetting",
  active_frontier: "Today's lesson",
  active_gate: "Active fluency gate",
  transfer_check: "Cold-read transfer check",
};

function pctLabel(p) {
  if (p == null) return null;
  return `${Math.round(p * 100)}%`;
}

export default function TodayPlan({ plan, model }) {
  if (!plan || plan.empty) return null;

  return (
    <section className="ra-card" style={{ marginBottom: 16 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 className="ra-card-title">Today's session</h2>
        <span className="ra-card-sub" style={{ margin: 0 }}>
          {plan.totalIntents} {plan.totalIntents === 1 ? "task" : "tasks"} · {plan.blocks.length} {plan.blocks.length === 1 ? "block" : "blocks"}
        </span>
      </header>

      <ol style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 10 }}>
        {plan.blocks.map((block, i) => (
          <li key={i}>
            <BlockCard block={block} model={model} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function BlockCard({ block, model }) {
  const route = ROUTE_FOR_KIND[block.kind] ?? "/reading";
  const icon = ICON_FOR_KIND[block.kind] ?? "•";

  return (
    <div
      style={{
        border: "1px solid #e2e2e2",
        borderRadius: 12,
        padding: "14px 16px",
        background: "white",
        display: "flex",
        gap: 14,
        alignItems: "center",
      }}
    >
      <div
        aria-hidden
        style={{
          fontSize: 24,
          width: 36,
          height: 36,
          borderRadius: 8,
          background: "#f4f4f5",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {icon}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>{block.heading}</div>
        {block.subtitle && (
          <div style={{ color: "#666", fontSize: 13, marginTop: 2 }}>
            {block.subtitle}
          </div>
        )}
        {block.intents.length > 0 && (
          <div style={{ marginTop: 6, color: "#888", fontSize: 12 }}>
            {block.intents.map((it, j) => (
              <span key={j}>
                {j > 0 && " · "}
                {it.nodeId && <code className="ra-id">{it.nodeId}</code>}
                {it.reason && (
                  <span style={{ marginLeft: 6 }}>
                    {REASON_LABEL[it.reason] ?? it.reason}
                    {it.forgettingRisk != null && ` (${pctLabel(it.forgettingRisk)})`}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      <Link
        to={route}
        className="ra-btn ra-btn-primary"
        style={{ flexShrink: 0, textDecoration: "none" }}
      >
        Start
      </Link>
    </div>
  );
}
