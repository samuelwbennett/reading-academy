// src/pages/Reading/components/ActionQueue.jsx
//
// Renders a list of teacher actions with checkbox-style mark-complete
// + skip controls. Reads + writes the reading_action_completions
// table via lib/actions/completions.ts.
//
// Two modes:
//   - Per-student (default): pass `actions` directly. The header
//     shows "{N} actions for {studentName}".
//   - Cohort: pass `actions` as CohortAction[] (with studentId +
//     studentDisplayName); each row labels the student.

import React, { useEffect, useState } from "react";
import { fetchCompletions, markAction } from "../../../lib/actions/completions";

const URGENCY_COLOR = {
  today: "#c33",
  this_week: "#a72",
  monitor: "#888",
};

const KIND_GLYPH = {
  pull_aside: "👤",
  advance: "↑",
  review_block: "↻",
  monitor: "•",
  refer: "⚐",
};

export default function ActionQueue({ actions, studentId, cohort = false, title }) {
  const [completions, setCompletions] = useState({});
  const [busy, setBusy] = useState({});

  useEffect(() => {
    let cancelled = false;
    if (cohort) {
      // For cohort mode, fetch each student's completions; merge.
      const ids = Array.from(new Set(actions.map((a) => a.studentId).filter(Boolean)));
      Promise.all(ids.map((id) => fetchCompletions(id))).then((maps) => {
        if (cancelled) return;
        const merged = {};
        ids.forEach((id, i) => {
          for (const [actionId, row] of Object.entries(maps[i] || {})) {
            merged[`${id}|${actionId}`] = row;
          }
        });
        setCompletions(merged);
      });
    } else if (studentId) {
      fetchCompletions(studentId).then((rows) => {
        if (!cancelled) setCompletions(rows);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [studentId, cohort, JSON.stringify(actions.map((a) => a.id))]);

  function getCompletionKey(action) {
    return cohort ? `${action.studentId}|${action.id}` : action.id;
  }

  async function handleMark(action, status) {
    const sId = cohort ? action.studentId : studentId;
    if (!sId) return;
    const key = getCompletionKey(action);
    setBusy((b) => ({ ...b, [key]: true }));
    const result = await markAction(sId, action, status);
    setBusy((b) => ({ ...b, [key]: false }));
    if (result.ok) {
      setCompletions((c) => ({
        ...c,
        [key]: {
          action_id: action.id,
          status,
          completed_at: new Date().toISOString(),
        },
      }));
    } else {
      alert(`Mark failed: ${result.reason}`);
    }
  }

  if (!actions || actions.length === 0) {
    return (
      <div style={{ color: "#999", fontStyle: "italic", padding: "8px 0" }}>
        no actions right now — keep practicing
      </div>
    );
  }

  return (
    <div>
      {title && (
        <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>
          {title}
        </div>
      )}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {actions.map((action) => {
          const key = getCompletionKey(action);
          const completion = completions[key];
          const isCompleted = completion?.status === "completed";
          const isSkipped = completion?.status === "skipped";
          const isBusy = busy[key];

          return (
            <li
              key={key}
              style={{
                display: "flex",
                gap: 12,
                padding: "10px 0",
                borderBottom: "1px solid #eee",
                opacity: isCompleted || isSkipped ? 0.55 : 1,
                textDecoration: isCompleted ? "line-through" : "none",
              }}
            >
              <span
                aria-hidden
                style={{
                  fontSize: 20,
                  width: 28,
                  textAlign: "center",
                  flexShrink: 0,
                }}
              >
                {KIND_GLYPH[action.kind] || "•"}
              </span>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 14 }}>{action.headline}</strong>
                  <span
                    style={{
                      fontSize: 10,
                      padding: "1px 6px",
                      borderRadius: 999,
                      background: URGENCY_COLOR[action.urgency] || "#888",
                      color: "white",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    {action.urgency.replace("_", " ")}
                  </span>
                  {action.bumpedFromToday && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: "1px 6px",
                        borderRadius: 999,
                        background: "#fae3c1",
                        color: "#542",
                        border: "1px solid #d2a85c",
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                      }}
                      title="Bumped from today to fit your daily budget"
                    >
                      bumped
                    </span>
                  )}
                  <span style={{ color: "#888", fontSize: 11 }}>
                    ~{action.durationMinutes} min
                  </span>
                </div>
                <div style={{ color: "#444", fontSize: 13, marginTop: 4 }}>
                  {action.detail}
                </div>
                <div style={{ color: "#888", fontSize: 11, marginTop: 4 }}>
                  {cohort && action.studentDisplayName && (
                    <span style={{ marginRight: 8 }}>
                      <strong>{action.studentDisplayName}</strong>
                    </span>
                  )}
                  {action.nodeId && <code className="ra-id">{action.nodeId}</code>}
                  {action.evidence?.rule && (
                    <span style={{ marginLeft: 6 }}>· {action.evidence.rule}</span>
                  )}
                </div>
              </div>

              <div style={{ display: "flex", gap: 6, flexShrink: 0, alignSelf: "center" }}>
                {!isCompleted && !isSkipped && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleMark(action, "completed")}
                      disabled={isBusy}
                      style={{
                        ...BtnBase,
                        background: "#27a",
                        color: "white",
                        border: "1px solid #27a",
                      }}
                      title="Mark complete"
                    >
                      ✓ Done
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMark(action, "skipped")}
                      disabled={isBusy}
                      style={{
                        ...BtnBase,
                        background: "white",
                        color: "#666",
                        border: "1px solid #ccc",
                      }}
                      title="Mark skipped"
                    >
                      Skip
                    </button>
                  </>
                )}
                {isCompleted && (
                  <span style={{ fontSize: 11, color: "#27a" }}>
                    ✓ done {new Date(completion.completed_at).toISOString().slice(5, 10)}
                  </span>
                )}
                {isSkipped && (
                  <span style={{ fontSize: 11, color: "#888" }}>
                    skipped
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const BtnBase = {
  fontSize: 12,
  padding: "5px 10px",
  borderRadius: 5,
  cursor: "pointer",
};
