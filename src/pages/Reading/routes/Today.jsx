import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import skillNodesData from "../../../data/skill_nodes.json";
import { validateGraph, logValidation } from "../../../lib/graphValidator.js";
import {
  loadState,
  saveState,
  getActiveNodeId,
  getProgressCounts,
  getPrereqProgress,
} from "../lib/readingState.js";
import { load as loadModel } from "../../../lib/mastery/storage";
import { planSession } from "../../../lib/session/sessionPlanner";
import { useStudentMode } from "../../../lib/auth/useStudentMode.js";
import ReadingHeader from "../components/ReadingHeader.jsx";
import TodayPlan from "../components/TodayPlan.jsx";
import TodaySession from "../components/TodaySession.jsx";
import ProgressSummary from "../components/ProgressSummary.jsx";
import StudentToday from "../components/StudentToday.jsx";

// Today route. Two modes (M16-D3):
//   - Student / anonymous: minimal StudentToday — one Start CTA + a
//     small progress strip. No dashboards, no node ids, no Explore.
//   - Teacher / admin:     full dashboard with TodayPlan + legacy
//     TodaySession + ProgressSummary + Explore links.

export default function Today() {
  const validation = useMemo(() => validateGraph(skillNodesData), []);
  const isStudent = useStudentMode();

  useEffect(() => {
    logValidation(validation, { tag: "[reading]" });
  }, [validation]);

  const [state, setState] = useState(() => loadState());
  const [model, setModel] = useState(() => loadModel());

  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    const onFocus = () => setModel(loadModel());
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  const plan = useMemo(
    () => planSession(model, skillNodesData),
    [model],
  );

  const activeNodeId = useMemo(() => getActiveNodeId(state), [state]);
  const activeNode = useMemo(
    () => (activeNodeId ? skillNodesData.find((n) => n.id === activeNodeId) : null),
    [activeNodeId],
  );
  const activeNodeStatus = activeNodeId
    ? state.nodes?.[activeNodeId]?.status || null
    : null;
  const prereqProgress = useMemo(
    () => getPrereqProgress(state, activeNode),
    [state, activeNode],
  );
  const counts = useMemo(() => getProgressCounts(state), [state]);

  // Build a fast {id → node} lookup so StudentToday can label each
  // intent with the node's real topic name + strand.
  const nodeIndex = useMemo(() => {
    const idx = {};
    for (const n of skillNodesData) idx[n.id] = n;
    return idx;
  }, []);

  // Local XP totals — pulled from the same daily_progress store the
  // session-bridge writes to. For now we read a lightweight local
  // mirror; the server-side daily_progress remains the source of
  // truth for cross-app XP rollups. Empty / first-run reads as 0.
  const { todayXp, weekXp } = useReadingXp();

  return (
    <div className="ra-app">
      <div className="ra-app-inner">
        <ReadingHeader
          nodeCount={validation.stats.nodeCount}
          valid={validation.valid}
        />
        {isStudent ? (
          <StudentToday
            plan={plan}
            diagnosticComplete={!!state.diagnosticComplete}
            counts={counts}
            nodeIndex={nodeIndex}
            todayXp={todayXp}
            weekXp={weekXp}
          />
        ) : (
          <>
            <TodayPlan plan={plan} model={model} />
            <TodaySession
              activeNode={activeNode}
              activeNodeStatus={activeNodeStatus}
              prereqProgress={prereqProgress}
              diagnosticComplete={!!state.diagnosticComplete}
            />
            <ProgressSummary counts={counts} />
            <ExploreCard />
          </>
        )}
      </div>
    </div>
  );
}

// Pulls daily / weekly XP from the local mirror written when the
// student finishes a drill. Defaults to 0 / 0 if nothing has been
// recorded yet. Kept inline here to avoid a separate service file
// for what is currently a one-call helper.
function useReadingXp() {
  const [v, setV] = useState({ todayXp: 0, weekXp: 0 });
  useEffect(() => {
    function read() {
      try {
        const raw = localStorage.getItem("ra:xp:v1");
        if (!raw) return;
        const data = JSON.parse(raw);
        const today = new Date().toISOString().slice(0, 10);
        const todayXp = Number(data?.byDay?.[today] || 0);
        // Sum the last 7 days.
        let weekXp = 0;
        const now = new Date();
        for (let i = 0; i < 7; i++) {
          const d = new Date(now);
          d.setDate(now.getDate() - i);
          const key = d.toISOString().slice(0, 10);
          weekXp += Number(data?.byDay?.[key] || 0);
        }
        setV({ todayXp, weekXp });
      } catch {
        // ignore; surface as 0/0
      }
    }
    read();
    const onFocus = () => read();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);
  return v;
}

function ExploreCard() {
  return (
    <section className="ra-card">
      <div className="ra-eyebrow">Explore</div>
      <p className="ra-card-sub" style={{ marginTop: 4 }}>
        Browse the full curriculum or see how skills connect.
      </p>
      <div
        className="ra-actions"
        style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}
      >
        <Link to="/reading/course-tree" className="ra-btn ra-btn-primary">
          Course tree
        </Link>
        <Link to="/reading/graph" className="ra-btn ra-btn-secondary">
          Knowledge graph
        </Link>
      </div>
    </section>
  );
}
