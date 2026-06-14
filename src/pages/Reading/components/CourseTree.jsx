import React, { useMemo, useState } from "react";

// Course tree grouped by strand. Each node row shows status dot, topic name,
// node id, prereq count, and human-readable status. Strands collapse on
// click; default state is all-collapsed so a fresh page shows the structure.
//
// Phase A reorganization (2026-05-18): three-track layout.
//   - "Comprehension" lead strands surface at the top (reading-to-learn).
//   - "Fluency" is its own track.
//   - All phonics-style strands (decoding, sight words, etc.) are grouped
//     under a collapsible "Foundation" track (learning-to-read).
// Why: per the Reading Facts / Reading Academy split, RA's primary
// identity is comprehension. Phonics stays as a Foundation review track
// for early or struggling readers.

const STATUS_LABEL = {
  mastered: "Mastered",
  practicing: "In progress",
  active: "In progress",
  unlocked: "Unlocked",
  locked: "Locked",
};

// Strands that compose the Foundation (word-recognition / decoding) track.
// Anything not in this set and not in TOP_LEVEL_ORDER falls into Foundation
// by default, so adding a new phonics strand doesn't require a CourseTree
// edit — the worst case is mis-categorization for a brand-new track, which
// is easy to spot.
const FOUNDATION_STRANDS = new Set([
  "Phonemic Awareness",
  "Letter-Sound Foundations",
  "CVC",
  "High-Frequency Words",
  "Initial Blends",
  "Final Blends",
  "Digraph",
  "Trigraph",
  "Inflectional Endings",
  "Silent-e",
  "Vowel Teams",
  "R-Controlled",
  "Soft C/G",
  "Multisyllabic",
]);

// Top-level (non-Foundation) tracks render in this order. Strands listed
// here appear as siblings of the Foundation group. Order matters — first
// strand surfaces at the top of the Course Tree page.
const TOP_LEVEL_ORDER = ["Comprehension", "Knowledge Arcs", "Morphology", "Fluency"];

export default function CourseTree({ nodes, state, activeNodeId }) {
  // Group nodes by strand, then bucket strands into the 3-track layout.
  const layout = useMemo(() => {
    const byStrand = new Map();
    for (const n of nodes) {
      const k = n.strand || "Other";
      if (!byStrand.has(k)) byStrand.set(k, []);
      byStrand.get(k).push(n);
    }

    const topLevel = [];
    for (const name of TOP_LEVEL_ORDER) {
      if (byStrand.has(name)) {
        topLevel.push({ strand: name, nodes: byStrand.get(name) });
      }
    }

    // Foundation: phonics strands in the order they first appear in the
    // data file (so it still tracks scope-and-sequence).
    const foundationStrands = [];
    const seen = new Set();
    for (const n of nodes) {
      const k = n.strand || "Other";
      if (seen.has(k)) continue;
      seen.add(k);
      if (FOUNDATION_STRANDS.has(k) || (!TOP_LEVEL_ORDER.includes(k) && k !== "Other")) {
        foundationStrands.push({ strand: k, nodes: byStrand.get(k) });
      }
    }

    return { topLevel, foundationStrands };
  }, [nodes]);

  // Default state: everything collapsed.
  const [expanded, setExpanded] = useState(() => new Set());
  const [foundationOpen, setFoundationOpen] = useState(false);

  const toggle = (strand) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(strand)) next.delete(strand);
      else next.add(strand);
      return next;
    });
  };

  const foundationMastered = layout.foundationStrands.reduce(
    (acc, g) =>
      acc +
      g.nodes.filter((n) => state.nodes?.[n.id]?.status === "mastered").length,
    0,
  );
  const foundationTotal = layout.foundationStrands.reduce(
    (acc, g) => acc + g.nodes.length,
    0,
  );

  return (
    <section className="ra-card">
      <div className="ra-eyebrow">Course tree</div>

      <div className="ra-tree">
        {layout.topLevel.map(({ strand, nodes: strandNodes }) => (
          <StrandGroup
            key={strand}
            strand={strand}
            nodes={strandNodes}
            state={state}
            activeNodeId={activeNodeId}
            isOpen={expanded.has(strand)}
            onToggle={() => toggle(strand)}
          />
        ))}

        {layout.foundationStrands.length > 0 && (
          <div className="ra-strand ra-strand-foundation">
            <button
              type="button"
              className="ra-strand-head ra-strand-head-track"
              onClick={() => setFoundationOpen((v) => !v)}
              aria-expanded={foundationOpen}
            >
              <span className="ra-strand-caret">
                {foundationOpen ? "▾" : "▸"}
              </span>
              <span className="ra-strand-name">
                Foundation
                <span className="ra-strand-sub">
                  {" "}
                  · word recognition (review track)
                </span>
              </span>
              <span className="ra-strand-count">
                {foundationMastered}/{foundationTotal}
              </span>
            </button>

            {foundationOpen && (
              <div className="ra-strand-children">
                {layout.foundationStrands.map(
                  ({ strand, nodes: strandNodes }) => (
                    <StrandGroup
                      key={strand}
                      strand={strand}
                      nodes={strandNodes}
                      state={state}
                      activeNodeId={activeNodeId}
                      isOpen={expanded.has(strand)}
                      onToggle={() => toggle(strand)}
                      nested
                    />
                  ),
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function StrandGroup({
  strand,
  nodes,
  state,
  activeNodeId,
  isOpen,
  onToggle,
  nested = false,
}) {
  const masteredCount = nodes.filter(
    (n) => state.nodes?.[n.id]?.status === "mastered",
  ).length;

  return (
    <div className={`ra-strand${nested ? " ra-strand-nested" : ""}`}>
      <button
        type="button"
        className="ra-strand-head"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <span className="ra-strand-caret">{isOpen ? "▾" : "▸"}</span>
        <span className="ra-strand-name">{strand}</span>
        <span className="ra-strand-count">
          {masteredCount}/{nodes.length}
        </span>
      </button>

      {isOpen && (
        <ul className="ra-node-list">
          {nodes.map((n) => {
            const ns = state.nodes?.[n.id];
            const status = ns?.status || "locked";
            const isActive = n.id === activeNodeId;
            return (
              <li
                key={n.id}
                className={`ra-node ${status} ${isActive ? "current" : ""}`}
              >
                <span
                  className={`ra-dot ra-dot-${status}`}
                  aria-hidden="true"
                />
                <span className="ra-node-text">
                  <span className="ra-node-name">{n.topic || n.skill}</span>
                  <span className="ra-node-meta">
                    <code className="ra-id">{n.id}</code> · {n.prereqs.length}{" "}
                    prereq
                    {n.prereqs.length === 1 ? "" : "s"} ·{" "}
                    {STATUS_LABEL[status] || status}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
