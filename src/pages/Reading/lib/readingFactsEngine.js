// Reading Facts engine — v1.0 (M1-D MVP).
//
// Implements the load-bearing pieces of docs/fluency/reading-facts-engine-v1.0.md:
//   - DRILL_DURATION_MS hard cap
//   - pickFocalNode    — v1 just returns the active node; #4 spec calls for
//                        priority order (in_zone > spaced_review_due > stalest)
//                        but those need state machine extensions deferred to
//                        M1-Z. Active node is the right v1 fallback.
//   - buildItemQueue   — v1 shuffles items for the focal node. The 70/30
//                        focal/review interleave from the spec lands in a
//                        later milestone when more nodes have item banks.
//   - itemIsAutomatic  — true when latency ≤ automaticity floor (or proxy).
//   - scoreDrill       — drill-aggregate WCPM + accuracy + automaticity rate.
//   - applyDrillResult — updates state.fluency personal-best blob.
//
// Pure functions. No side effects. Engine code in src/lib/* is unchanged.

import { selectActiveNode } from "../../../lib/masteryEngine.js";

export const DRILL_DURATION_MS = 60_000;
export const FLUENCY_NODE_IS_DRILLABLE = (assessment) =>
  assessment === "read_aloud" || assessment === "cold_passage";

// Pick the focal node for this drill.
// v1: the existing active node (selectActiveNode already picks practicing >
// active > unlocked-in-graph-order). When the automaticity-zone state
// machine extension lands, this gets replaced with the priority order spec.
export function pickFocalNode(state, nodeDefs) {
  const id = selectActiveNode(state, nodeDefs);
  if (!id) return null;
  return nodeDefs.find((n) => n.id === id) || null;
}

// Build the queue of items the drill cycles through.
// v1: shuffled focal-node items. No interleave with prereqs yet — that
// requires authored item banks for the prereq nodes (M2 work).
export function buildItemQueue(focalNode, itemBank) {
  if (!focalNode) return [];
  const pool = (itemBank?.[focalNode.id] || []).slice();
  // Fisher-Yates shuffle for variety across drill sessions.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

// Automaticity check for one item.
// Uses the node's automaticity_target_latency_ms when present (PA_06,
// LS_01–04 in v1.1). Otherwise proxies to read_latency_ms × 0.5 — a
// half-acquisition-latency rule of thumb until the field is populated
// across all nodes.
export function itemIsAutomatic(latencyMs, nodeMasteryConfig) {
  if (!Number.isFinite(latencyMs)) return false;
  const target =
    nodeMasteryConfig?.automaticity_target_latency_ms ??
    (nodeMasteryConfig?.read_latency_ms
      ? Math.round(nodeMasteryConfig.read_latency_ms * 0.5)
      : null);
  if (!target) return false;
  return latencyMs <= target;
}

// Score the entire drill.
// Inputs: array of attempts ({ correct, latencyMs, withinAutomaticity }) and
// the actual drill duration (may be slightly more or less than 60s in
// practice because of mic state at the buzzer).
export function scoreDrill(attempts, drillDurationMs) {
  const total = attempts.length;
  const correct = attempts.filter((a) => a.correct).length;
  const automatic = attempts.filter((a) => a.correct && a.withinAutomaticity).length;
  const minutes = Math.max(drillDurationMs / 60_000, 1 / 60); // avoid /0
  const wcpm = correct / minutes;
  return {
    wordsAttempted: total,
    wordsCorrect: correct,
    wordsAutomatic: automatic,
    wcpm: Math.round(wcpm),
    accuracy: total > 0 ? correct / total : 0,
    automaticityRate: total > 0 ? automatic / total : 0,
    durationMs: drillDurationMs,
  };
}

// Read personal-best snapshots from state without mutating.
export function getPersonalBest(state, focalNodeId) {
  const fb = state?.fluency?.personalBests || {};
  return {
    overall: fb.overall?.wcpm ?? 0,
    forNode: fb.byNode?.[focalNodeId]?.wcpm ?? 0,
  };
}

// Commit a drill result to state.fluency. Updates per-node and overall
// personal bests. Returns { state, isNewOverall, isNewForNode } so the UI
// can announce a new best.
export function applyDrillResult(state, focalNodeId, drillScore) {
  const next = structuredClone(state);
  if (!next.fluency) {
    next.fluency = {
      personalBests: { overall: null, byNode: {} },
      totalDrillsCompleted: 0,
      lastDrillAt: null,
      rollingDailyWcpm: [],
    };
  }
  if (!next.fluency.personalBests) {
    next.fluency.personalBests = { overall: null, byNode: {} };
  }
  if (!next.fluency.personalBests.byNode) {
    next.fluency.personalBests.byNode = {};
  }

  const wcpm = drillScore.wcpm;
  const ts = Date.now();

  let isNewOverall = false;
  let isNewForNode = false;

  const overall = next.fluency.personalBests.overall;
  if (!overall || wcpm > overall.wcpm) {
    next.fluency.personalBests.overall = { wcpm, ts, focalNodeId };
    isNewOverall = true;
  }

  const forNode = next.fluency.personalBests.byNode[focalNodeId];
  if (!forNode || wcpm > forNode.wcpm) {
    next.fluency.personalBests.byNode[focalNodeId] = { wcpm, ts };
    isNewForNode = true;
  }

  next.fluency.totalDrillsCompleted = (next.fluency.totalDrillsCompleted || 0) + 1;
  next.fluency.lastDrillAt = ts;

  // Append to rolling 14-day WCPM window (1 entry per drill, oldest first).
  next.fluency.rollingDailyWcpm = [
    ...(next.fluency.rollingDailyWcpm || []),
    { wcpm, ts },
  ].slice(-100); // hard cap to keep state size sane

  return { state: next, isNewOverall, isNewForNode };
}
