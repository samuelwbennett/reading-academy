// graphValidator.js
//
// Pure-function graph integrity checks. Runs once on app mount, logs to console.
// Never throws — a graph with warnings still loads (we'd rather know about a bad
// edge than crash the app). Errors that DO matter for runtime safety produce
// console.error so they show up in dev tools and Sentry-equivalent monitoring.
//
// Exported:
//   validateGraph(nodes)  → { valid, errors, warnings, stats }
//   logValidation(result) → side-effecting console output
//
// Design constraints (per Build Plan v1.0):
//   - No side effects in validate*
//   - Run on every app load
//   - Costs O(N + E) where N=nodes, E=edges. ~55 + ~80 for K-2.
//   - Must catch: missing prereqs, cycles, orphan leaves (info), >1 root (error).

export function validateGraph(nodes) {
  const result = {
    valid: true,
    errors: [],
    warnings: [],
    info: [],
    stats: {
      nodeCount: nodes.length,
      edgeCount: 0,
      strands: {},
      roots: [],
      leaves: [],
    },
  };

  const ids = new Set(nodes.map((n) => n.id));
  const adj = new Map(nodes.map((n) => [n.id, n.prereqs || []]));

  // 1. Schema sanity: required fields per node
  for (const n of nodes) {
    if (!n.id) {
      result.errors.push(`Node missing 'id' field`);
      result.valid = false;
      continue;
    }
    if (!Array.isArray(n.prereqs)) {
      result.errors.push(`${n.id}: prereqs must be an array`);
      result.valid = false;
    }
    if (!n.mastery || typeof n.mastery !== "object") {
      result.warnings.push(`${n.id}: missing mastery config`);
    }
    if (!n.assessment) {
      result.warnings.push(`${n.id}: missing assessment type`);
    }
    if (!n.strand) {
      result.warnings.push(`${n.id}: missing strand`);
    }
    result.stats.strands[n.strand] = (result.stats.strands[n.strand] || 0) + 1;
    result.stats.edgeCount += (n.prereqs || []).length;
  }

  // 2. Prereq integrity: every prereq points to a real node
  for (const n of nodes) {
    for (const p of n.prereqs || []) {
      if (!ids.has(p)) {
        result.errors.push(`${n.id}: prereq "${p}" does not exist in graph`);
        result.valid = false;
      }
      if (p === n.id) {
        result.errors.push(`${n.id}: self-prerequisite (cycle of length 1)`);
        result.valid = false;
      }
    }
  }

  // 3. DAG check (Tarjan-style three-color DFS)
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...ids].map((id) => [id, WHITE]));
  const cycles = [];

  function dfs(u, path) {
    color.set(u, GRAY);
    for (const v of adj.get(u) || []) {
      if (!ids.has(v)) continue; // already reported above
      if (color.get(v) === GRAY) {
        cycles.push([...path, u, v].join(" → "));
        continue;
      }
      if (color.get(v) === WHITE) dfs(v, [...path, u]);
    }
    color.set(u, BLACK);
  }
  for (const id of ids) {
    if (color.get(id) === WHITE) dfs(id, []);
  }
  if (cycles.length > 0) {
    for (const c of cycles) {
      result.errors.push(`Cycle detected: ${c}`);
    }
    result.valid = false;
  }

  // 4. Roots and leaves
  result.stats.roots = nodes.filter((n) => (n.prereqs || []).length === 0).map((n) => n.id);
  result.stats.leaves = nodes
    .filter((n) => !nodes.some((m) => (m.prereqs || []).includes(n.id)))
    .map((n) => n.id);

  if (result.stats.roots.length === 0) {
    result.errors.push(`No root node (every node has a prereq — graph is unreachable)`);
    result.valid = false;
  } else if (result.stats.roots.length > 1) {
    result.warnings.push(
      `Multiple root nodes (${result.stats.roots.length}): ${result.stats.roots.join(", ")}. ` +
      `K-2 graph design assumes exactly one root.`
    );
  }

  if (result.stats.leaves.length === 0) {
    result.warnings.push(`No leaf node (every node has descendants — unusual)`);
  }

  // 5. Module/topic completeness (info only — used by course tree UI)
  for (const n of nodes) {
    if (!n.module || !n.topic) {
      result.info.push(`${n.id}: missing module/topic; will not appear cleanly in course tree`);
    }
  }

  return result;
}

export function logValidation(result, options = {}) {
  const tag = options.tag || "[graph]";
  if (result.valid && result.errors.length === 0) {
    console.info(
      `${tag} ✓ ${result.stats.nodeCount} nodes, ${result.stats.edgeCount} edges, ` +
      `${result.stats.roots.length} root(s), ${result.stats.leaves.length} leaf/leaves. ` +
      `Strands: ${Object.entries(result.stats.strands).map(([s, c]) => `${s}:${c}`).join(", ")}`
    );
  } else {
    console.error(`${tag} ✗ Graph validation failed`);
    for (const e of result.errors) console.error(`${tag}  error: ${e}`);
  }
  for (const w of result.warnings) console.warn(`${tag}  warn: ${w}`);
  if (options.verbose) {
    for (const i of result.info) console.info(`${tag}  info: ${i}`);
  }
}

// Helper for App.jsx: backfill any nodes from the graph that don't yet have
// state entries. Used after loading a saved state when the graph has grown.
export function backfillNodeState(state, nodes) {
  const next = structuredClone(state);
  if (!next.nodes) next.nodes = {};
  for (const n of nodes) {
    if (!next.nodes[n.id]) {
      next.nodes[n.id] = { status: "locked", attempts: [] };
    }
  }
  return next;
}

// Helper: filter nodes to only those that have items defined in the assessment
// items dictionary. Used by the Diagnostic to avoid hanging on item-less nodes
// in M1, where most nodes have no item bank yet.
export function filterTestableNodes(nodes, items) {
  return nodes.filter((n) => Array.isArray(items[n.id]) && items[n.id].length > 0);
}

// M16-I1 / M16-J1: filter for AUTONOMOUS placement (no teacher in the
// loop). Excludes:
//
//   1. Any node flagged requires_teacher_scoring — these are the
//      single-phoneme answers (PA_01 isolation, PA_06 segmentation,
//      LS_* letter-sound) that ASR can't reliably score.
//
//   2. Any phoneme_* assessment — even ones whose ANSWER is a whole
//      word and ASR-scorable (phoneme_blend, phoneme_delete_*,
//      phoneme_substitute), the STIMULUS for these tasks is a phoneme
//      sound. Browser SpeechSynthesis (the only TTS we ship) speaks
//      single letters as their NAMES ("h" → "aitch", "o" → "oh") so
//      the student hears "aitch-oh-pee" instead of /h//o//p/. The
//      delete/substitute tasks have similar issues with embedded /s/
//      etc. in their instructions. Until we wire Azure Neural TTS
//      with proper SSML phoneme tags, these tasks are pedagogically
//      broken in autonomous mode and must be teacher-administered.
//
// What remains: read_aloud (CVC, blends, digraphs, silent-e, vowel
// teams, r-controlled, multisyllabic, HFW, inflectional) — the
// student sees a written word and reads it aloud. The mic captures
// the read, Azure scores it. This is the canonical autonomous flow.
//
// Teacher mode (?teacher=1 or signed-in teacher/admin) keeps using
// filterTestableNodes so they can still administer the full battery
// in person.
const PHONEME_ASSESSMENT_TYPES = new Set([
  "phoneme_isolate_initial",
  "phoneme_isolate_final",
  "phoneme_isolate_medial",
  "phoneme_blend",
  "phoneme_segment",
  "phoneme_delete_initial",
  "phoneme_delete_final",
  "phoneme_substitute",
  "letter_sound",
]);

export function filterAutonomousTestableNodes(nodes, items) {
  return filterTestableNodes(nodes, items).filter((n) => {
    if (n.requires_teacher_scoring) return false;
    if (PHONEME_ASSESSMENT_TYPES.has(n.assessment)) return false;
    return true;
  });
}
