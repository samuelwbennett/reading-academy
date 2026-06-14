// src/pages/Reading/components/KnowledgeGraph.jsx
//
// SVG knowledge-graph viewer for the K–2 skill DAG. Math Academy-style:
// foundation skills sit at the bottom, gates at the top, prereqs flow
// upward.
//
// Features:
//   - Color-coded by 8-state mastery (locked → automatic).
//   - Pan: mouse drag or single-finger touch drag.
//   - Zoom: scroll wheel (ctrl+wheel = trackpad pinch on Mac), pinch
//     gesture on touch devices.
//   - Click a node → side panel with status, accuracy, latency, prereqs.
//   - Search box highlights matching nodes (dims everything else).
//
// Rendering is one SVG with a translate/scale transform applied to a
// `<g>` so layout never recomputes during pan/zoom — only the matrix
// changes, which the browser handles cheaply.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { computeLayout } from "../../../lib/graph";

// ---- color palette (matches dashboard pills) ----
const STATUS_COLORS = {
  locked: { fill: "#e5e5e5", stroke: "#ccc", text: "#888" },
  unlocked: { fill: "#e6f0fa", stroke: "#7aa", text: "#246" },
  active: { fill: "#bfe1c7", stroke: "#2a7", text: "#143" },
  practicing: { fill: "#fae3c1", stroke: "#a72", text: "#542" },
  mastered_for_acquisition: { fill: "#bcd9f2", stroke: "#27a", text: "#124" },
  in_automaticity_zone: { fill: "#c2bff0", stroke: "#52d", text: "#102" },
  automatic: { fill: "#d8c2ec", stroke: "#a4d", text: "#202" },
  regressed: { fill: "#f4c5c5", stroke: "#c33", text: "#411" },
  // Legacy "mastered" is treated as mastered_for_acquisition.
  mastered: { fill: "#bcd9f2", stroke: "#27a", text: "#124" },
};

const NODE_W = 150;
const NODE_H = 56;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;

export default function KnowledgeGraph({ nodes, model }) {
  // Compute layout once per node graph change (rare).
  const layout = useMemo(() => computeLayout(nodes), [nodes]);

  // View transform.
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [zoom, setZoom] = useState(0.7);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const containerRef = useRef(null);
  const isPanningRef = useRef(false);
  const lastPointRef = useRef(null);
  const lastPinchDistRef = useRef(null);

  // Center the graph on first mount.
  useEffect(() => {
    if (!containerRef.current || !layout.width) return;
    const rect = containerRef.current.getBoundingClientRect();
    const cx = (rect.width - layout.width * zoom) / 2;
    const cy = (rect.height - layout.height * zoom) / 2;
    setTx(cx);
    setTy(cy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.width, layout.height]);

  // Wheel zoom (trackpad pinch comes through as ctrl+wheel on macOS).
  function handleWheel(e) {
    e.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.001);
    const next = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    // Zoom around the cursor.
    const k = next / zoom;
    setTx(mx - k * (mx - tx));
    setTy(my - k * (my - ty));
    setZoom(next);
  }

  // Mouse / single-touch drag-pan.
  function handlePointerDown(e) {
    if (e.target.closest(".kg-node-hit")) return; // node clicks handled separately
    isPanningRef.current = true;
    lastPointRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function handlePointerMove(e) {
    if (!isPanningRef.current || !lastPointRef.current) return;
    const dx = e.clientX - lastPointRef.current.x;
    const dy = e.clientY - lastPointRef.current.y;
    lastPointRef.current = { x: e.clientX, y: e.clientY };
    setTx((x) => x + dx);
    setTy((y) => y + dy);
  }
  function handlePointerUp(e) {
    isPanningRef.current = false;
    lastPointRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }

  function fitView() {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const sx = rect.width / layout.width;
    const sy = rect.height / layout.height;
    const z = Math.min(sx, sy) * 0.9;
    setZoom(z);
    setTx((rect.width - layout.width * z) / 2);
    setTy((rect.height - layout.height * z) / 2);
  }

  const selectedNode = selected
    ? nodes.find((n) => n.id === selected)
    : null;
  const selectedState = selectedNode
    ? model.nodes[selectedNode.id]
    : null;

  // Filter highlighting.
  const search_ = search.trim().toLowerCase();
  function isHighlighted(id) {
    if (!search_) return true;
    const def = nodes.find((n) => n.id === id);
    const hay = `${id} ${def?.topic ?? ""} ${def?.skill ?? ""}`.toLowerCase();
    return hay.includes(search_);
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", height: "100%", gap: 0 }}>
      {/* Graph canvas */}
      <div
        ref={containerRef}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        style={{
          position: "relative",
          background: "linear-gradient(180deg, #fafbff 0%, #f1f3f8 100%)",
          overflow: "hidden",
          touchAction: "none",
          cursor: isPanningRef.current ? "grabbing" : "grab",
          userSelect: "none",
        }}
      >
        {/* Toolbar */}
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            display: "flex",
            gap: 8,
            zIndex: 2,
          }}
        >
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search skill or id…"
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #ccc",
              fontSize: 13,
              width: 220,
              background: "white",
            }}
          />
          <button type="button" onClick={fitView} style={ToolBtn}>Fit</button>
          <button type="button" onClick={() => { setZoom(1); setTx(0); setTy(0); }} style={ToolBtn}>Reset</button>
          <span style={{ alignSelf: "center", color: "#888", fontSize: 12 }}>
            {Math.round(zoom * 100)}%
          </span>
        </div>

        <Legend />

        <svg
          width="100%"
          height="100%"
          style={{ display: "block" }}
          aria-label="Reading Academy knowledge graph"
        >
          <defs>
            <marker
              id="kg-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#9aa" />
            </marker>
          </defs>
          <g transform={`translate(${tx} ${ty}) scale(${zoom})`}>
            {/* Edges */}
            {layout.edges.map((e, i) => (
              <line
                key={i}
                x1={e.fromX}
                y1={e.fromY}
                x2={e.toX}
                y2={e.toY}
                stroke="#9aa"
                strokeWidth={1.2}
                opacity={isHighlighted(e.from) || isHighlighted(e.to) ? 0.55 : 0.1}
                markerEnd="url(#kg-arrow)"
              />
            ))}
            {/* Nodes */}
            {nodes.map((n) => {
              const pos = layout.nodes.get(n.id);
              if (!pos) return null;
              const status = model.nodes[n.id]?.status || "locked";
              const colors = STATUS_COLORS[status] || STATUS_COLORS.locked;
              const dim = isHighlighted(n.id) ? 1 : 0.2;
              return (
                <g
                  key={n.id}
                  transform={`translate(${pos.x - NODE_W / 2} ${pos.y - NODE_H / 2})`}
                  className="kg-node-hit"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(n.id);
                  }}
                  style={{ cursor: "pointer", opacity: dim }}
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={10}
                    fill={colors.fill}
                    stroke={
                      selected === n.id ? "#222" : colors.stroke
                    }
                    strokeWidth={selected === n.id ? 2.5 : 1.5}
                  />
                  <text
                    x={NODE_W / 2}
                    y={22}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={600}
                    fill={colors.text}
                  >
                    {truncate(n.topic || n.skill || n.id, 22)}
                  </text>
                  <text
                    x={NODE_W / 2}
                    y={40}
                    textAnchor="middle"
                    fontSize={9}
                    fill={colors.text}
                    opacity={0.7}
                  >
                    {n.id}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {/* Side panel */}
      <aside
        style={{
          borderLeft: "1px solid #e5e5e5",
          background: "white",
          padding: 16,
          overflowY: "auto",
        }}
      >
        {!selectedNode ? (
          <div style={{ color: "#888", fontSize: 13 }}>
            Click a node to inspect.
          </div>
        ) : (
          <NodeDetail node={selectedNode} state={selectedState} nodes={nodes} />
        )}
      </aside>
    </div>
  );
}

function NodeDetail({ node, state, nodes }) {
  const status = state?.status || "locked";
  const colors = STATUS_COLORS[status] || STATUS_COLORS.locked;
  const prereqs = (node.prereqs || []).map((id) =>
    nodes.find((n) => n.id === id),
  ).filter(Boolean);

  return (
    <div>
      <div
        style={{
          display: "inline-block",
          padding: "2px 8px",
          background: colors.fill,
          color: colors.text,
          border: `1px solid ${colors.stroke}`,
          borderRadius: 999,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {status}
      </div>
      <h2 style={{ fontSize: 16, margin: "10px 0 4px" }}>
        {node.topic || node.skill || node.id}
      </h2>
      <code style={{ fontSize: 11, color: "#888" }}>{node.id}</code>

      <dl style={{ marginTop: 14, fontSize: 13 }}>
        <Row k="Strand" v={node.strand || "—"} />
        <Row k="Module" v={node.module || "—"} />
        <Row k="Assessment" v={<code>{node.assessment || "—"}</code>} />
        <Row k="Attempts" v={state?.attempts ?? 0} />
        <Row k="Accuracy" v={`${Math.round((state?.rollingAccuracy ?? 0) * 100)}%`} />
        <Row k="Latency" v={`${Math.round(state?.rollingLatencyMs ?? 0)} ms`} />
        <Row k="Forgetting risk" v={`${Math.round((state?.forgettingRisk ?? 0) * 100)}%`} />
      </dl>

      {prereqs.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>
            Prereqs
          </div>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {prereqs.map((p) => (
              <li key={p.id} style={{ fontSize: 12 }}>
                {p.topic || p.skill || p.id}
              </li>
            ))}
          </ul>
        </div>
      )}

      {node.examples && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>
            Examples
          </div>
          <div style={{ fontSize: 12, color: "#444", marginTop: 4 }}>
            {Array.isArray(node.examples) ? node.examples.join(", ") : node.examples}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #f3f3f3" }}>
      <dt style={{ color: "#888" }}>{k}</dt>
      <dd style={{ margin: 0, fontWeight: 500 }}>{v}</dd>
    </div>
  );
}

function Legend() {
  const items = [
    ["locked", "Locked"],
    ["unlocked", "Unlocked"],
    ["active", "Active"],
    ["practicing", "Practicing"],
    ["mastered_for_acquisition", "Mastered"],
    ["in_automaticity_zone", "Fluent"],
    ["automatic", "Automatic"],
    ["regressed", "Regressed"],
  ];
  return (
    <div
      style={{
        position: "absolute",
        bottom: 12,
        left: 12,
        background: "rgba(255,255,255,0.92)",
        border: "1px solid #e5e5e5",
        borderRadius: 8,
        padding: "8px 12px",
        display: "flex",
        gap: 12,
        flexWrap: "wrap",
        maxWidth: 600,
        zIndex: 2,
        fontSize: 11,
      }}
    >
      {items.map(([k, label]) => (
        <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: 3,
              background: STATUS_COLORS[k].fill,
              border: `1px solid ${STATUS_COLORS[k].stroke}`,
            }}
          />
          {label}
        </span>
      ))}
    </div>
  );
}

const ToolBtn = {
  padding: "6px 12px",
  fontSize: 13,
  border: "1px solid #ccc",
  background: "white",
  borderRadius: 6,
  cursor: "pointer",
};

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
