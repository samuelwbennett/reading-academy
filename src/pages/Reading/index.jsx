import React, { useEffect, useMemo, useState } from "react";
import skillNodesData from "../../data/skill_nodes.json";
import { validateGraph, logValidation } from "../../lib/graphValidator.js";
import {
  loadState,
  saveState,
  getActiveNodeId,
  getProgressCounts,
  getPrereqProgress,
} from "./lib/readingState.js";
import ReadingHeader from "./components/ReadingHeader.jsx";
import TodaySession from "./components/TodaySession.jsx";
import ProgressSummary from "./components/ProgressSummary.jsx";
import CourseTree from "./components/CourseTree.jsx";
import "./styles.css";

// Reading Academy — runtime shell.
//
// M1-A: load the graph, load student state with backfill + cascadeUnlock,
// pick the active node, render the four shell sections (header, today,
// progress, course tree). Action buttons in TodaySession are placeholders;
// real Diagnostic / Drill / Reading Facts / Passage components mount in
// M1-B through M1-E.
//
// State persistence: any state mutation triggers saveState() to localStorage
// under reading-academy:student-state:v1. Mutations don't happen in this
// shell yet — just the initial load + cascadeUnlock — but the wiring is in
// place so future milestones plug in cleanly.

export default function Reading() {
  // Validate graph on mount (logs to console under [reading] tag).
  const validation = useMemo(() => validateGraph(skillNodesData), []);

  useEffect(() => {
    logValidation(validation, { tag: "[reading]" });
  }, [validation]);

  // Load state once on mount; lazy initializer prevents re-running on every render.
  const [state, setState] = useState(() => loadState());

  // Persist on every change.
  useEffect(() => {
    saveState(state);
  }, [state]);

  // Active node + supporting data.
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

  return (
    <div className="ra-app">
      <div className="ra-app-inner">
        <ReadingHeader
          nodeCount={validation.stats.nodeCount}
          valid={validation.valid}
        />
        <TodaySession
          activeNode={activeNode}
          activeNodeStatus={activeNodeStatus}
          prereqProgress={prereqProgress}
        />
        <ProgressSummary counts={counts} />
        <CourseTree
          nodes={skillNodesData}
          state={state}
          activeNodeId={activeNodeId}
        />
      </div>
    </div>
  );
}
