import React from "react";
import { Link } from "react-router-dom";
import { ROUTES } from "../../../config/routes.js";

// Today's session card. Shows the active node and four action buttons.
// Diagnostic activates in M1-B; the others stay disabled until their
// milestones land (M1-C drill, M1-D Reading Facts, M1-E passage).

const STATUS_LABEL = {
  mastered: "Mastered",
  practicing: "In progress",
  active: "In progress",
  unlocked: "Ready to start",
  locked: "Locked",
};

export default function TodaySession({
  activeNode,
  activeNodeStatus,
  prereqProgress,
  diagnosticComplete,
}) {
  if (!activeNode) {
    return (
      <section className="ra-card">
        <div className="ra-eyebrow">Today's session</div>
        <h2 className="ra-card-title">All caught up</h2>
        <p className="ra-card-sub">
          Every available node is mastered. New material will appear as the
          graph grows.
        </p>
      </section>
    );
  }

  const statusLabel = STATUS_LABEL[activeNodeStatus] || activeNodeStatus || "Unknown";
  const diagnosticBadge = diagnosticComplete ? "Re-take placement" : "Start placement";

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
        <Link
          to={`${ROUTES.READING}/diagnostic`}
          className="ra-btn"
          role="button"
        >
          {diagnosticBadge}
        </Link>
        <Link
          to={`${ROUTES.READING}/drill`}
          className="ra-btn"
          role="button"
        >
          Start Drill
        </Link>
        <Link
          to={`${ROUTES.READING}/fluency`}
          className="ra-btn ra-btn-primary"
          role="button"
        >
          Reading Facts
        </Link>
        <Link
          to={`${ROUTES.READING}/passage`}
          className="ra-btn"
          role="button"
        >
          Passage
        </Link>
      </div>
      <p className="ra-actions-note">
        Diagnostic, Drill, Reading Facts, and Passage are all live.
      </p>
    </section>
  );
}
