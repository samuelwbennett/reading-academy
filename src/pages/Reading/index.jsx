import React, { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import skillNodesData from "../../data/skill_nodes.json";
import { validateGraph, logValidation } from "../../lib/graphValidator.js";
import { ROUTES } from "../../config/routes.js";
import "./styles.css";

// Reading Academy — vertical slice route stub.
//
// Routing wires up here at /reading; engine/components rebuild in M1 of the
// build plan. This stub:
//   - Validates the 55-node graph on mount and logs to console.
//   - Surfaces basic graph stats so we can verify the data file loaded.
//   - Provides a back-link to the launcher.
//
// Engine modules (masteryEngine, graphValidator, services/*) are intentionally
// imported here only — none of the launcher routes touch them. Reading Academy
// runtime is fully isolated under this subtree.

export default function Reading() {
  const validation = useMemo(() => validateGraph(skillNodesData), []);

  useEffect(() => {
    logValidation(validation, { tag: "[reading]", verbose: false });
  }, [validation]);

  return (
    <div className="ra-stub">
      <div className="ra-stub-inner">
        <Link to={ROUTES.HOME} className="ra-stub-back">
          ← VPA Learning OS
        </Link>

        <h1 className="ra-stub-title">Reading Academy</h1>
        <p className="ra-stub-sub">
          Vertical slice rebuild in progress. Routing wired; engine and components mount in M1.
        </p>

        <div className="ra-stub-card">
          <div className="ra-stub-eyebrow">Graph runtime</div>
          <div className="ra-stub-stats">
            <div><strong>{validation.stats.nodeCount}</strong>nodes</div>
            <div><strong>{validation.stats.edgeCount}</strong>edges</div>
            <div><strong>{validation.stats.roots.length}</strong>root</div>
            <div><strong>{validation.stats.leaves.length}</strong>leaf</div>
          </div>
          <div className="ra-stub-strands">
            {Object.entries(validation.stats.strands).map(([s, c]) => (
              <span key={s} className="ra-stub-strand">
                <strong>{c}</strong>{s}
              </span>
            ))}
          </div>
          <div className={`ra-stub-validity ${validation.valid ? "" : "bad"}`}>
            {validation.valid
              ? "✓ DAG verified, prereq integrity OK"
              : `✗ ${validation.errors.length} validation error(s) — see console`}
          </div>
          {validation.warnings.length > 0 && (
            <div className="ra-stub-roots">
              {validation.warnings.length} warning(s) logged to console
            </div>
          )}
        </div>

        <div className="ra-stub-card">
          <div className="ra-stub-eyebrow">Up next</div>
          <p className="ra-stub-next">
            M1 vertical slice rebuilds the diagnostic, drill, Reading Facts engine,
            course tree, and XP ring against the 55-node graph and the existing engine in{" "}
            <code>src/lib/masteryEngine.js</code>. See{" "}
            <code>docs/build-plan/v1.0.md</code> for the day-by-day sequence.
          </p>
        </div>
      </div>
    </div>
  );
}
