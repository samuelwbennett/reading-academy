// src/pages/Reading/routes/CourseTreePage.jsx
//
// Standalone Course Tree page. Linked from the Today dashboard via
// the "Course tree" button. Strands open collapsed by default — click
// each to expand.

import React from "react";
import { Link } from "react-router-dom";
import skillNodesData from "../../../data/skill_nodes.json";
import { ROUTES } from "../../../config/routes.js";
import {
  loadState,
  getActiveNodeId,
  getProgressCounts,
} from "../lib/readingState.js";
import CourseTree from "../components/CourseTree.jsx";
import ProgressSummary from "../components/ProgressSummary.jsx";

export default function CourseTreePage() {
  const state = React.useMemo(() => loadState(), []);
  const activeNodeId = React.useMemo(() => getActiveNodeId(state), [state]);
  const counts = React.useMemo(() => getProgressCounts(state), [state]);

  return (
    <div className="ra-app">
      <div className="ra-app-inner">
        <header className="ra-header">
          <Link to={ROUTES.READING} className="ra-header-back">
            ← Reading Academy
          </Link>
          <h1 className="ra-header-title">Course tree</h1>
          <p className="ra-header-status">
            All {skillNodesData.length} K–2 skills, grouped by strand. Tap a strand to expand.
          </p>
        </header>

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
