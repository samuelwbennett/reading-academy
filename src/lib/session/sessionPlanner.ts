// src/lib/session/sessionPlanner.ts
//
// Daily session orchestrator. Pure: (model, graph, now) → SessionPlan.
//
// Plan structure (in surface order, what the learner sees first to last):
//   1. Reviews — at most R nodes from the spaced-review queue.
//   2. Active practice — the next not-yet-mastered node selected by
//      the mastery engine's notion of "active" (lowest practiced of
//      the unlocked frontier).
//   3. Fluency drill — reading-facts at the most recently mastered tier.
//   4. Cold passage — when the active fluency gate has been provisionally
//      mastered and at least one cold passage in that gate hasn't been
//      attempted recently.
//
// The planner does NOT block. If a section has no available items,
// it returns an empty list for that section and the UI skips it.
//
// Integration shape mirrors `Today.jsx`'s expectations: each block
// has a stable kind, a heading string, an optional subtitle, and a
// list of opaque "intents" the route already knows how to render.

import type { StudentModel, NodeState, FluencyGate } from "../mastery/studentModel";
import { buildReviewQueue } from "../review/reviewScheduler";
import { calculateForgettingRisk, type NodeConfig } from "../mastery/masteryEngine";
import { isTeacherScored } from "../assessment";

export interface SessionConfig {
  /** Max review items to surface today. */
  maxReviews: number;
  /** Max active-practice nodes to surface today. */
  maxActiveNodes: number;
  /** Min cold-passage gap (days) before re-surfacing a gate cold-read. */
  coldPassageCooldownDays: number;
  /** Forgetting risk above which a node is auto-promoted into the queue. */
  forgettingRiskFloor: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  maxReviews: 5,
  // 2026-05-19: bumped from 1 → 4. The student-facing Today screen
  // now renders a list (Math-Academy-style), and a 1-item list reads
  // as "you have no choice." Four gives the student a sense of agency
  // (pick which one to start with) while still keeping the day's
  // surface area tight. Interleaving across strands is enforced in
  // pickActiveNodes below.
  maxActiveNodes: 4,
  coldPassageCooldownDays: 3,
  forgettingRiskFloor: 0.7,
};

export type IntentKind =
  | "review"
  | "drill"
  | "fluency"
  | "cold_passage";

export interface SessionIntent {
  kind: IntentKind;
  nodeId?: string;
  gateId?: FluencyGate;
  reason: string;
  forgettingRisk?: number;
}

export interface SessionBlock {
  kind: IntentKind;
  heading: string;
  subtitle?: string;
  intents: SessionIntent[];
}

export interface SessionPlan {
  generatedAt: number;
  blocks: SessionBlock[];
  /** Total intent count, all blocks combined. */
  totalIntents: number;
  /** True iff there's nothing for the learner to do (rare). */
  empty: boolean;
}

interface MinimalNodeDef {
  id: string;
  prereqs?: string[];
  course?: string;
  unit?: string;
  module?: string;
  topic?: string;
  assessment?: string;
  strand?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FLUENCY_GATES: ReadonlyArray<FluencyGate> = [
  "FL_01_cvc_fluency",
  "FL_02_blend_digraph_fluency",
  "FL_03_silent_e_fluency",
  "FL_04_grade2_fluency",
];

const MASTERED_STATES = new Set([
  "mastered_for_acquisition",
  "in_automaticity_zone",
  "automatic",
]);

// 2026-05-19 audit fix #1: nodes in any of these states are already
// done and should not be candidates for "Today's plan." Everything else
// — including the implicit default "locked" — is a candidate IF its
// prereqs are mastered. This decouples the planner from the legacy
// cascadeUnlock pipeline: a node doesn't need its own status
// explicitly bumped to "unlocked" to be eligible; it just needs its
// prereqs satisfied. Fixes the G2-style symptom where a student who
// just mastered the upstream phonics saw only one lesson because no
// downstream "unlocked" status had been written yet.
const DONE_STATES = new Set([
  ...MASTERED_STATES,
  "review",
  "regressed",
]);

// ---------- helpers ----------

function isUnlocked(node: MinimalNodeDef, model: StudentModel): boolean {
  const prereqs = node.prereqs ?? [];
  if (prereqs.length === 0) return true;
  return prereqs.every((p) => {
    const pn = model.nodes[p];
    return pn != null && MASTERED_STATES.has(pn.status);
  });
}

function sortByGraphOrder(
  nodes: MinimalNodeDef[],
  graph: MinimalNodeDef[],
): MinimalNodeDef[] {
  const orderById = new Map<string, number>();
  graph.forEach((n, i) => orderById.set(n.id, i));
  return [...nodes].sort(
    (a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0),
  );
}

// Phase A (2026-05-19): when status ranks tie (e.g., a fresh student where
// every unlocked node is at "unlocked" with no progress), prefer the
// Comprehension strand, then Fluency, then everything else (Foundation
// phonics). This makes RA's primary identity — comprehension — surface
// first for new learners, while students already mid-stream in phonics
// (rank "practicing" or "active") still keep their existing flow because
// status rank beats strand rank.
function strandPriority(strand: string | undefined): number {
  if (strand === "Comprehension") return 0;
  if (strand === "Knowledge Arcs") return 1;
  if (strand === "Morphology") return 2;
  if (strand === "Fluency") return 3;
  return 4;
}

function pickActiveNodes(
  model: StudentModel,
  graph: MinimalNodeDef[],
  limit: number,
): MinimalNodeDef[] {
  const candidates: MinimalNodeDef[] = [];
  for (const def of graph) {
    if (def.assessment === "cold_passage") continue;
    // M16-B: never assign teacher-scored skills to a student in
    // normal mode. The Drill route would route them to the
    // TeacherLedPanel anyway, so skipping here keeps the action
    // queue honest about what the student can actually complete.
    if (isTeacherScored(def.assessment)) continue;
    const ns = model.nodes[def.id];
    const status = ns?.status ?? "locked";
    // 2026-05-19 audit fix: a node is a candidate if its prereqs are
    // mastered AND it isn't already done. The explicit status field
    // is no longer required to be active/practicing/unlocked — that
    // turns the planner into a self-sufficient frontier finder and
    // closes the post-diagnostic dead-zone for new students.
    if (!DONE_STATES.has(status) && isUnlocked(def, model)) {
      candidates.push(def);
    }
  }
  // Sort by:
  //   1. status rank (practicing > active > unlocked) — don't disrupt
  //      students mid-stream;
  //   2. strand priority (Comprehension > Fluency > everything else) —
  //      RA's primary identity surfaces first for tied statuses;
  //   3. graph order — stable, predictable within a strand.
  candidates.sort((a, b) => {
    const sa = model.nodes[a.id]?.status ?? "locked";
    const sb = model.nodes[b.id]?.status ?? "locked";
    const rank = (s: string) =>
      s === "practicing" ? 0 : s === "active" ? 1 : s === "unlocked" ? 2 : 3;
    if (rank(sa) !== rank(sb)) return rank(sa) - rank(sb);
    const pa = strandPriority(a.strand);
    const pb = strandPriority(b.strand);
    if (pa !== pb) return pa - pb;
    return graph.findIndex((g) => g.id === a.id) -
      graph.findIndex((g) => g.id === b.id);
  });

  // Interleave: take the top candidate, then prefer the next candidate
  // from a strand we haven't surfaced yet. This stops the list from
  // looking like four-in-a-row of the same strand. Falls back to graph
  // order when we run out of fresh strands.
  const out: MinimalNodeDef[] = [];
  const seenStrands = new Set<string>();
  const pool = [...candidates];
  while (out.length < limit && pool.length > 0) {
    let pickIdx = pool.findIndex(
      (c) => !seenStrands.has(c.strand || "_other"),
    );
    if (pickIdx === -1) pickIdx = 0; // exhausted fresh strands
    const [picked] = pool.splice(pickIdx, 1);
    out.push(picked);
    seenStrands.add(picked.strand || "_other");
  }
  return out;
}

// Back-compat single-node entry point. Used by anything that wants the
// "top recommended" pick (e.g., the legacy teacher dashboard's active
// node card).
function pickActiveNode(
  model: StudentModel,
  graph: MinimalNodeDef[],
): MinimalNodeDef | null {
  return pickActiveNodes(model, graph, 1)[0] ?? null;
}

function activeFluencyGate(
  model: StudentModel,
  graph: MinimalNodeDef[],
): FluencyGate | null {
  // The active gate is the lowest gate whose prereqs are all mastered
  // but whose own status is not yet `automatic`.
  for (const gateId of FLUENCY_GATES) {
    const def = graph.find((n) => n.id === gateId);
    if (!def) continue;
    if (!isUnlocked(def, model)) continue;
    const ns = model.nodes[gateId];
    const status = ns?.status ?? "locked";
    if (status !== "automatic") return gateId;
  }
  return null;
}

function shouldOfferColdPassage(
  model: StudentModel,
  gateId: FluencyGate,
  config: SessionConfig,
  now: number,
): boolean {
  const gateNode = model.nodes[gateId];
  // Gate must be at least at unlocked + practicing band.
  if (
    !gateNode ||
    gateNode.status === "locked"
  ) {
    return false;
  }
  const fluency = model.fluency[gateId];
  // Need at least one practice attempt before a cold-read makes sense.
  if (!fluency || fluency.passageAttempts === 0) return false;
  // Cooldown: don't re-surface a cold passage within the cooldown window.
  if (
    fluency.lastAttemptAt &&
    now - fluency.lastAttemptAt < config.coldPassageCooldownDays * DAY_MS
  ) {
    return false;
  }
  return true;
}

function autoEscalateForgottenNodes(
  model: StudentModel,
  config: SessionConfig,
  now: number,
): NodeState[] {
  // Any mastered node whose forgetting risk has crossed the floor but
  // whose `reviewDueAt` hasn't been set should be auto-surfaced today.
  const out: NodeState[] = [];
  for (const ns of Object.values(model.nodes)) {
    if (!MASTERED_STATES.has(ns.status)) continue;
    if (ns.reviewDueAt != null && ns.reviewDueAt <= now) continue;
    const risk = calculateForgettingRisk(ns, now);
    if (risk >= config.forgettingRiskFloor) out.push({ ...ns, forgettingRisk: risk });
  }
  return out;
}

// ---------- main ----------

/**
 * Build today's plan. `graph` is the array of skill node defs from
 * `src/data/skill_nodes.json`.
 */
export function planSession(
  model: StudentModel,
  graph: MinimalNodeDef[],
  configIn: Partial<SessionConfig> = {},
  now: number = Date.now(),
): SessionPlan {
  const config: SessionConfig = { ...DEFAULT_SESSION_CONFIG, ...configIn };
  const blocks: SessionBlock[] = [];

  // 1. Reviews.
  const dueQueue = buildReviewQueue(Object.values(model.nodes), now);
  const escalated = autoEscalateForgottenNodes(model, config, now);
  const seen = new Set(dueQueue.map((n) => n.nodeId));
  const reviews = [...dueQueue, ...escalated.filter((n) => !seen.add(n.nodeId))]
    .slice(0, config.maxReviews);

  if (reviews.length > 0) {
    blocks.push({
      kind: "review",
      heading: "Quick reviews",
      subtitle: "A few skills to keep sharp before today's lesson.",
      intents: reviews.map((n) => ({
        kind: "review",
        nodeId: n.nodeId,
        reason:
          n.reviewDueAt != null && n.reviewDueAt <= now
            ? "due"
            : "forgetting_risk",
        forgettingRisk: n.forgettingRisk,
      })),
    });
  }

  // 2. Active practice — surface multiple candidates so the student
  //    has a choice. The first is the strongest recommendation; the
  //    rest are interleaved across strands for variety.
  const activeNodes = pickActiveNodes(model, graph, config.maxActiveNodes);
  if (activeNodes.length > 0) {
    blocks.push({
      kind: "drill",
      heading: "Today's lessons",
      subtitle: activeNodes[0].topic ?? activeNodes[0].module ?? "Active practice",
      intents: activeNodes.map((n) => ({
        kind: "drill",
        nodeId: n.id,
        reason: "active_frontier",
      })),
    });
  }

  // 3. Fluency drill at the active gate's underlying skills (reading facts).
  const gateId = activeFluencyGate(model, graph);
  if (gateId) {
    blocks.push({
      kind: "fluency",
      heading: "Reading facts",
      subtitle: "Fast and accurate — build automaticity.",
      intents: [
        {
          kind: "fluency",
          gateId,
          nodeId: gateId, // the engine reads facts inventory off the gate id
          reason: "active_gate",
        },
      ],
    });
  }

  // 4. Cold passage — only when the gate is ready.
  if (gateId && shouldOfferColdPassage(model, gateId, config, now)) {
    blocks.push({
      kind: "cold_passage",
      heading: "Cold read",
      subtitle: "A new passage you haven't seen before.",
      intents: [
        {
          kind: "cold_passage",
          gateId,
          reason: "transfer_check",
        },
      ],
    });
  }

  const totalIntents = blocks.reduce((acc, b) => acc + b.intents.length, 0);
  return {
    generatedAt: now,
    blocks,
    totalIntents,
    empty: totalIntents === 0,
  };
}

/** Convenience: turn a plan into a flat ordered list of intents. */
export function flattenPlan(plan: SessionPlan): SessionIntent[] {
  return plan.blocks.flatMap((b) => b.intents);
}

export type { NodeConfig };
