import React from "react";

// Today's session card. Shows the active node and four placeholder action
// buttons. The buttons are intentionally disabled at M1-A — they become
// real entry points to Diagnostic / Drill / Reading Facts / Passage Reader
// in later milestones.

const STATUS_LABEL = {
  mastered: "Mastered",
  practicing: "In progress",
  active: "In progress",
  unlocked: "Ready to start",
  locked: "Locked",
};

const ACTIONS = [
  { key: "diagnostic", label: "Start Diagnostic", milestone: "M1-B" },
  { key: "drill",       label: "Start Drill",       milestone: "M1-C" },
  { key: "fluency",     label: "Reading Facts",     milestone: "M1-D" },
  { key: "passage",     label: "Passage",           milestone: "M1-E" },
];

export default function TodaySession({ activeNode, activeNodeStatus, prereqProgress }) {
  if (!activeNode) {
    return (
      <section className="ra-card">
        <div className="ra-eyebrow">Today's session</div>
        <h2 className="ra-card-title">All caught up</h2>
        <p className="ra-card-sub">
          Every available node is mastered. New material will appear as the graph grows.
        </p>
      </section>
    );
  }

  const statusLabel = STATUS_LABEL[activeNodeStatus] || activeNodeStatus || "Unknown";

  return (
    <section className="ra-card">
      <div className="ra-eyebrow">Today's session</div>
      <h2 className="ra-card-title">{activeNode.topic || activeNode.skill}</h2>
      <p className="ra-card-sub">
        {activeNode.strand} · <code className="ra-id">{activeNode.id}</code>
      </p>

      <div className="ra-meta-row">
        <div className="ra-meta">
          <div className="ra-meta-label">State</div>
          <div className="ra-meta-value">{statusLabel}</div>
        </div>
        <div className="ra-meta">
          <div className="ra-meta-label">Prereqs</div>
          <div className="ra-meta-value">{prereqProgress.label}</div>
        </div>
        <div className="ra-meta">
          <div className="ra-meta-label">Module</div>
          <div className="ra-meta-value">{activeNode.module || "—"}</div>
        </div>
      </div>

      <div className="ra-actions">
        {ACTIONS.map((a) => (
          <button
            key={a.key}
            className="ra-btn"
            disabled
            title={`${a.label} mounts in ${a.milestone}`}
          >
            {a.label}
          </button>
        ))}
      </div>
      <p className="ra-actions-note">Buttons mount in upcoming milestones (M1-B through M1-E).</p>
    </section>
  );
}
