import React, { useMemo, useState } from "react";

// Course tree grouped by strand. Each node row shows status dot, topic name,
// node id, prereq count, and human-readable status. Strands collapse on
// click; default state is all-expanded so a fresh page shows the full graph.

const STATUS_LABEL = {
  mastered: "Mastered",
  practicing: "In progress",
  active: "In progress",
  unlocked: "Unlocked",
  locked: "Locked",
};

export default function CourseTree({ nodes, state, activeNodeId }) {
  // Group by strand, preserving the order nodes appear in the data file.
  const grouped = useMemo(() => {
    const order = [];
    const byStrand = new Map();
    for (const n of nodes) {
      const k = n.strand || "Other";
      if (!byStrand.has(k)) {
        byStrand.set(k, []);
        order.push(k);
      }
      byStrand.get(k).push(n);
    }
    return order.map((strand) => ({ strand, nodes: byStrand.get(strand) }));
  }, [nodes]);

  const [expanded, setExpanded] = useState(
    () => new Set(grouped.map((g) => g.strand)),
  );

  const toggle = (strand) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(strand)) next.delete(strand);
      else next.add(strand);
      return next;
    });
  };

  return (
    <section className="ra-card">
      <div className="ra-eyebrow">Course tree</div>

      <div className="ra-tree">
        {grouped.map(({ strand, nodes: strandNodes }) => {
          const isOpen = expanded.has(strand);
          const masteredCount = strandNodes.filter(
            (n) => state.nodes?.[n.id]?.status === "mastered",
          ).length;

          return (
            <div key={strand} className="ra-strand">
              <button
                type="button"
                className="ra-strand-head"
                onClick={() => toggle(strand)}
                aria-expanded={isOpen}
              >
                <span className="ra-strand-caret">{isOpen ? "▾" : "▸"}</span>
                <span className="ra-strand-name">{strand}</span>
                <span className="ra-strand-count">
                  {masteredCount}/{strandNodes.length}
                </span>
              </button>

              {isOpen && (
                <ul className="ra-node-list">
                  {strandNodes.map((n) => {
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
                          <span className="ra-node-name">
                            {n.topic || n.skill}
                          </span>
                          <span className="ra-node-meta">
                            <code className="ra-id">{n.id}</code> ·{" "}
                            {n.prereqs.length} prereq
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
        })}
      </div>
    </section>
  );
}
