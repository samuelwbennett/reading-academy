// src/lib/graph/layout.ts
//
// Layered DAG layout for the Reading Academy knowledge graph.
//
// Algorithm (Sugiyama-style, simplified):
//   1. Assign each node a layer = longest path from any root.
//   2. Within each layer, order nodes to minimize edge crossings
//      with adjacent layers (barycenter heuristic, two passes).
//   3. Position nodes on a grid: layer index → y, slot → x.
//
// Pure function. Deterministic for any given input. No external deps.
//
// Inputs:  array of { id, prereqs: string[] } (skill_nodes.json shape).
// Outputs: { nodes: Map<id, {x, y, layer, slot}>, edges: Edge[],
//            width, height, layerCount }.

export interface NodeInput {
  id: string;
  prereqs?: string[];
}

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  layer: number;
  slot: number;
}

export interface Edge {
  from: string;
  to: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export interface LayoutResult {
  nodes: Map<string, PositionedNode>;
  edges: Edge[];
  width: number;
  height: number;
  layerCount: number;
}

export interface LayoutOptions {
  /** Horizontal spacing between adjacent slot columns (px). */
  slotSpacing: number;
  /** Vertical spacing between adjacent layers (px). */
  layerSpacing: number;
  /** Side padding inside the viewBox. */
  padding: number;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  slotSpacing: 180,
  layerSpacing: 110,
  padding: 60,
};

// ---- step 1: layer assignment ----

function computeLayers(nodes: NodeInput[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const layer = new Map<string, number>();

  // Memoized longest-path-from-root.
  function depth(id: string, seen: Set<string>): number {
    const cached = layer.get(id);
    if (cached != null) return cached;
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const def = byId.get(id);
    const prereqs = def?.prereqs ?? [];
    if (prereqs.length === 0) {
      layer.set(id, 0);
      return 0;
    }
    let max = 0;
    for (const p of prereqs) {
      if (!byId.has(p)) continue;
      max = Math.max(max, depth(p, seen) + 1);
    }
    layer.set(id, max);
    return max;
  }

  for (const n of nodes) depth(n.id, new Set());
  return layer;
}

// ---- step 2: within-layer ordering via barycenter ----

function barycenterPass(
  layers: string[][],
  prereqsById: Map<string, string[]>,
  childrenById: Map<string, string[]>,
  direction: "down" | "up",
): string[][] {
  // Down pass: order each layer L by mean position of its prereqs
  // in layer L-1. Up pass: reverse.
  const start = direction === "down" ? 1 : layers.length - 2;
  const end = direction === "down" ? layers.length : -1;
  const step = direction === "down" ? 1 : -1;

  for (let i = start; i !== end; i += step) {
    const ref = layers[i + (direction === "down" ? -1 : 1)];
    const refPos = new Map<string, number>();
    ref.forEach((id, idx) => refPos.set(id, idx));

    const items = layers[i].map((id) => {
      const neighbors =
        direction === "down"
          ? prereqsById.get(id) ?? []
          : childrenById.get(id) ?? [];
      const positions = neighbors
        .map((nid) => refPos.get(nid))
        .filter((p): p is number => p != null);
      const bary =
        positions.length > 0
          ? positions.reduce((a, b) => a + b, 0) / positions.length
          : Number.MAX_SAFE_INTEGER;
      return { id, bary };
    });
    items.sort((a, b) => a.bary - b.bary || a.id.localeCompare(b.id));
    layers[i] = items.map((it) => it.id);
  }
  return layers;
}

// ---- main ----

export function computeLayout(
  nodes: NodeInput[],
  optsIn: Partial<LayoutOptions> = {},
): LayoutResult {
  const opts: LayoutOptions = { ...DEFAULT_LAYOUT_OPTIONS, ...optsIn };

  if (nodes.length === 0) {
    return {
      nodes: new Map(),
      edges: [],
      width: 0,
      height: 0,
      layerCount: 0,
    };
  }

  // Layer assignment.
  const layerById = computeLayers(nodes);
  const layerCount = Math.max(...layerById.values()) + 1;

  // Bucket node IDs by layer.
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const n of nodes) {
    const l = layerById.get(n.id) ?? 0;
    layers[l].push(n.id);
  }
  // Initial within-layer ordering: alphabetical so the layout is stable.
  for (const layer of layers) layer.sort();

  // Adjacency lookup tables.
  const prereqsById = new Map(nodes.map((n) => [n.id, n.prereqs ?? []]));
  const childrenById = new Map<string, string[]>();
  for (const n of nodes) {
    for (const p of n.prereqs ?? []) {
      const arr = childrenById.get(p) ?? [];
      arr.push(n.id);
      childrenById.set(p, arr);
    }
  }

  // Two barycenter passes for crossing reduction.
  let ordered = layers.map((l) => [...l]);
  ordered = barycenterPass(ordered, prereqsById, childrenById, "down");
  ordered = barycenterPass(ordered, prereqsById, childrenById, "up");
  ordered = barycenterPass(ordered, prereqsById, childrenById, "down");

  // Position each node.
  // Layout from bottom up so prereq=0 (PA_01) sits at the BOTTOM and
  // gates (FL_04) sit at the TOP — mirrors Math Academy's foundation-up
  // visualization the user is referencing.
  const maxLayerWidth = Math.max(...ordered.map((l) => l.length));
  const positioned = new Map<string, PositionedNode>();

  for (let l = 0; l < ordered.length; l++) {
    const layer = ordered[l];
    const yFromTop = (layerCount - 1 - l) * opts.layerSpacing + opts.padding;
    const layerWidth = layer.length * opts.slotSpacing;
    const xOffset =
      opts.padding +
      ((maxLayerWidth - layer.length) * opts.slotSpacing) / 2;
    for (let s = 0; s < layer.length; s++) {
      positioned.set(layer[s], {
        id: layer[s],
        x: xOffset + s * opts.slotSpacing + opts.slotSpacing / 2,
        y: yFromTop + opts.layerSpacing / 2,
        layer: l,
        slot: s,
      });
    }
  }

  // Compute edges.
  const edges: Edge[] = [];
  for (const n of nodes) {
    const target = positioned.get(n.id);
    if (!target) continue;
    for (const p of n.prereqs ?? []) {
      const source = positioned.get(p);
      if (!source) continue;
      edges.push({
        from: p,
        to: n.id,
        fromX: source.x,
        fromY: source.y,
        toX: target.x,
        toY: target.y,
      });
    }
  }

  const width = maxLayerWidth * opts.slotSpacing + opts.padding * 2;
  const height = layerCount * opts.layerSpacing + opts.padding * 2;

  return { nodes: positioned, edges, width, height, layerCount };
}
