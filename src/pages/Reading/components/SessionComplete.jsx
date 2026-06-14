// src/pages/Reading/components/SessionComplete.jsx (M16-E6)
//
// End-of-session screen for students. Renders when the bounded
// drill session hits its target (or the node reaches mastery).
// One primary action: Back to Today. Teachers/admins also get a
// "Practice more" secondary so the bounded contract doesn't get
// in the way of debugging.

import React from "react";
import { Link } from "react-router-dom";
import { ROUTES } from "../../../config/routes.js";

export default function SessionComplete({
  done,
  target,
  reason = "target_reached",
  onPracticeMore,
  showPracticeMore = false,
}) {
  const headlineByReason = {
    target_reached: "Nice work — you're done for now.",
    mastery_reached: "You've got this skill down — great job!",
  };
  const subByReason = {
    target_reached: `${done} of ${target} done. Come back tomorrow for more.`,
    mastery_reached: "We'll move you to a new skill next time.",
  };

  return (
    <div
      style={{
        textAlign: "center",
        padding: "32px 20px",
      }}
    >
      <div style={{ fontSize: 44, lineHeight: 1 }} aria-hidden>
        ✨
      </div>
      <h2
        className="ra-card-title"
        style={{ margin: "14px 0 6px", fontSize: 22 }}
      >
        {headlineByReason[reason] || headlineByReason.target_reached}
      </h2>
      <p
        className="ra-card-sub"
        style={{ margin: "0 0 24px", fontSize: 15 }}
      >
        {subByReason[reason] || subByReason.target_reached}
      </p>
      <div
        className="ra-actions"
        style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "stretch" }}
      >
        <Link
          to={ROUTES.READING}
          className="ra-btn ra-btn-primary"
          style={{
            display: "inline-block",
            padding: "14px 28px",
            fontSize: 17,
            textDecoration: "none",
          }}
        >
          Back to Today
        </Link>
        {showPracticeMore && (
          <button
            type="button"
            className="ra-btn ra-btn-secondary"
            onClick={onPracticeMore}
            style={{ fontSize: 13 }}
          >
            Practice more (teacher)
          </button>
        )}
      </div>
    </div>
  );
}
