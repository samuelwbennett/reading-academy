// src/pages/Reading/routes/Graph.jsx
//
// Full-screen knowledge-graph view of the K-2 skill DAG.
// Math Academy-style visualization, colored by mastery state.

import React from "react";
import { Link } from "react-router-dom";
import skillNodes from "../../../data/skill_nodes.json";
import { load as loadModel } from "../../../lib/mastery/storage";
import { ROUTES } from "../../../config/routes.js";
import KnowledgeGraph from "../components/KnowledgeGraph.jsx";

export default function Graph() {
  const model = React.useMemo(() => loadModel(), []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        gridTemplateRows: "auto 1fr",
        background: "white",
      }}
    >
      <header
        style={{
          padding: "12px 20px",
          borderBottom: "1px solid #e5e5e5",
          display: "flex",
          alignItems: "baseline",
          gap: 16,
        }}
      >
        <Link to={ROUTES.READING} style={{ fontSize: 13, color: "#666", textDecoration: "none" }}>
          ← Reading Academy
        </Link>
        <h1 style={{ fontSize: 18, margin: 0 }}>Knowledge graph</h1>
        <span style={{ fontSize: 12, color: "#888" }}>
          {skillNodes.length} skills · pan to explore · click a node for detail
        </span>
      </header>
      <main style={{ overflow: "hidden" }}>
        <KnowledgeGraph nodes={skillNodes} model={model} />
      </main>
    </div>
  );
}
