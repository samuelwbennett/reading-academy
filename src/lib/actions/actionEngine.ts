// src/lib/actions/actionEngine.ts
//
// Teacher Action Engine.
//
// The Insights engine (M6-C) emits *observations*. The Action engine
// emits *prescriptions* — what the teacher should DO, in plain
// language, with a duration estimate and an evidence trail.
//
// This is the surface that saves teacher cognition. Instead of:
//
//   "Sam: PA_06 status practicing, 12 attempts, 73% accuracy,
//    forgetting risk 0.42, last practiced 4 days ago…"
//
// the teacher sees:
//
//   "Pull Sam for 5 min phoneme-segmentation practice
//    before today's session — they've stalled at PA_06."
//
// Pure function. No I/O. Same model + same now → same actions.
// LLM polish is layered on top in api/action-narration.js per the
// LLM boundary rule (the engine itself stays deterministic).
//
// Spec: docs/architecture/llm-boundary.md (engine layer)
// Inputs: M3 StudentModel + skill graph
// Outputs: Action[] sorted by urgency + impact

import type { StudentModel, NodeState } from "../mastery/studentModel";
import { calculateForgettingRisk } from "../mastery/masteryEngine";
import { generateInsights, type Insight } from "../insights";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ActionKind =
  | "pull_aside"        // direct teacher intervention, short focused session
  | "advance"           // promote student to next skill / gate
  | "review_block"      // spaced-review batch needed before today's lesson
  | "monitor"           // no action, but watch this signal
  | "refer";            // diagnostic / specialist referral

export type ActionUrgency = "today" | "this_week" | "monitor";

export interface ActionEvidence {
  source: "insight" | "forgetting" | "ready_advance" | "low_engagement";
  insightId?: string;
  rule?: string;
  nodeId?: string;
  metric?: string;
  value?: number;
}

export interface Action {
  /** Stable id derived from rule + node + week — idempotent across renders. */
  id: string;
  kind: ActionKind;
  urgency: ActionUrgency;
  /** Short imperative sentence the teacher can act on. */
  headline: string;
  /** 1-2 sentence detail with the why and the suggested approach. */
  detail: string;
  /** Estimated minutes of teacher attention this action needs. */
  durationMinutes: number;
  /** Optional skill node the action centers on. */
  nodeId?: string;
  /** Audit trail. */
  evidence: ActionEvidence;
}

interface MinimalNodeDef {
  id: string;
  topic?: string;
  skill?: string;
  strand?: string;
  module?: string;
}

// ---- helpers ----

function nodeLabel(graph: MinimalNodeDef[], nodeId: string): string {
  const def = graph.find((n) => n.id === nodeId);
  return def?.topic ?? def?.skill ?? nodeId;
}

function isoWeek(now: number): string {
  const d = new Date(now);
  const year = d.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - start) / DAY_MS + 1) / 7);
  return `${year}W${String(week).padStart(2, "0")}`;
}

function deterministicId(rule: string, nodeId: string | undefined, now: number): string {
  return `act:${rule}:${nodeId ?? "global"}:${isoWeek(now)}`;
}

// ---- rule → action transforms ----

function actionFromInsight(
  insight: Insight,
  graph: MinimalNodeDef[],
  now: number,
): Action | null {
  const id = deterministicId(insight.rule, insight.nodeId, now);

  switch (insight.rule) {
    case "stalled": {
      const label = insight.nodeId ? nodeLabel(graph, insight.nodeId) : "this skill";
      return {
        id,
        kind: "pull_aside",
        urgency: insight.severity === "urgent" ? "today" : "this_week",
        headline: `Pull aside for ${label} — 5 min`,
        detail:
          `${label} hasn't moved in ${(insight.evidence as Record<string, unknown>).idleDays ?? "several"} days. ` +
          "Spend 5 minutes modeling the strategy explicitly, then send the student back to the drill.",
        durationMinutes: 5,
        nodeId: insight.nodeId,
        evidence: { source: "insight", insightId: insight.id, rule: insight.rule, nodeId: insight.nodeId },
      };
    }
    case "latency_drift": {
      const label = insight.nodeId ? nodeLabel(graph, insight.nodeId) : "this skill";
      return {
        id,
        kind: "review_block",
        urgency: insight.severity === "urgent" ? "today" : "this_week",
        headline: `Slow-paced review of ${label}`,
        detail:
          `Recent attempts on ${label} are getting slower, not faster. ` +
          "Run a short review block at half normal pace to reset the strategy before the next push.",
        durationMinutes: 4,
        nodeId: insight.nodeId,
        evidence: { source: "insight", insightId: insight.id, rule: insight.rule, nodeId: insight.nodeId },
      };
    }
    case "cold_read_regression":
      return {
        id,
        kind: "review_block",
        urgency: "today",
        headline: `Confidence reset before next cold read`,
        detail:
          "Re-read a recent practiced passage at this gate before the next cold attempt. " +
          "The drop is likely word-level, and a confidence reset usually fixes it.",
        durationMinutes: 6,
        nodeId: insight.nodeId,
        evidence: { source: "insight", insightId: insight.id, rule: insight.rule, nodeId: insight.nodeId },
      };
    case "forgetting_cluster": {
      const ev = insight.evidence as { nodeIds?: string[] };
      const count = ev.nodeIds?.length ?? 0;
      return {
        id,
        kind: "review_block",
        urgency: "today",
        headline: `Surface ${count}-skill review block at session start`,
        detail:
          `${count} mastered skills are at forgetting risk. ` +
          "Open today's session with a 5-minute review pass before the new lesson.",
        durationMinutes: 5,
        evidence: { source: "forgetting", insightId: insight.id, rule: insight.rule },
      };
    }
    case "ready_to_advance": {
      const label = insight.nodeId ? nodeLabel(graph, insight.nodeId) : "this skill";
      return {
        id,
        kind: "advance",
        urgency: "this_week",
        headline: `Promote past ${label}`,
        detail:
          `Accuracy and fluency are both at threshold on ${label}. ` +
          "Mark mastered manually if the engine hasn't yet, then move to the next node in sequence.",
        durationMinutes: 2,
        nodeId: insight.nodeId,
        evidence: { source: "ready_advance", insightId: insight.id, rule: insight.rule, nodeId: insight.nodeId },
      };
    }
    case "diagnostic_gap":
      return {
        id,
        kind: "pull_aside",
        urgency: "today",
        headline: "Run placement walk together",
        detail:
          "The student hasn't been placed yet — until the placement runs, the engine is choosing skills blind. " +
          "Sit with the student for the 5–8 minute placement check.",
        durationMinutes: 8,
        evidence: { source: "insight", insightId: insight.id, rule: insight.rule },
      };
    default:
      return null;
  }
}

// ---- engagement / referral signals ----

function lowEngagementAction(
  model: StudentModel,
  now: number,
): Action | null {
  // Trigger if the student has been inactive for >7 days but has
  // any non-locked node — they were here, then dropped off.
  let lastTs = 0;
  let hasProgress = false;
  for (const ns of Object.values(model.nodes)) {
    if (ns.status !== "locked") hasProgress = true;
    if (ns.lastPracticedAt && ns.lastPracticedAt > lastTs) lastTs = ns.lastPracticedAt;
  }
  if (!hasProgress || lastTs === 0) return null;
  const idleDays = (now - lastTs) / DAY_MS;
  if (idleDays < 7) return null;
  return {
    id: deterministicId("low_engagement", undefined, now),
    kind: "monitor",
    urgency: idleDays > 14 ? "today" : "this_week",
    headline: `Inactive for ${Math.round(idleDays)} days`,
    detail:
      "No practice logged in over a week. A short check-in (or a parent note) usually resumes the streak; " +
      "if it persists, consider whether the difficulty curve is the issue.",
    durationMinutes: 3,
    evidence: { source: "low_engagement", metric: "days_idle", value: Math.round(idleDays) },
  };
}

function referralAction(model: StudentModel, now: number): Action | null {
  // Heuristic: low intervention responsiveness + multiple stalled
  // mastered-but-decaying nodes → diagnostic referral suggestion.
  // Real signal from M11+ telemetry; v1 uses forgetting-risk count.
  let highRiskCount = 0;
  for (const ns of Object.values(model.nodes)) {
    if (
      ns.status !== "mastered_for_acquisition" &&
      ns.status !== "in_automaticity_zone" &&
      ns.status !== "automatic"
    ) continue;
    if (calculateForgettingRisk(ns, now) > 0.85) highRiskCount += 1;
  }
  if (highRiskCount < 8) return null;
  return {
    id: deterministicId("refer", undefined, now),
    kind: "refer",
    urgency: "this_week",
    headline: "Consider diagnostic referral",
    detail:
      `${highRiskCount} mastered skills are at very high forgetting risk. ` +
      "Repeated rapid forgetting across many skills is a flag worth surfacing to the literacy specialist.",
    durationMinutes: 5,
    evidence: { source: "low_engagement", metric: "high_risk_count", value: highRiskCount },
  };
}

// ---- main ----

const URGENCY_ORDER: Record<ActionUrgency, number> = {
  today: 0,
  this_week: 1,
  monitor: 2,
};
const KIND_PRIORITY: Record<ActionKind, number> = {
  refer: 0,
  pull_aside: 1,
  review_block: 2,
  advance: 3,
  monitor: 4,
};

/**
 * Generate the action queue for one student. Pure function; same
 * inputs always produce the same output.
 */
export function generateActions(
  model: StudentModel,
  graph: MinimalNodeDef[],
  now: number = Date.now(),
): Action[] {
  const insights = generateInsights(model, graph, undefined, now);
  const actions: Action[] = [];

  for (const i of insights) {
    const a = actionFromInsight(i, graph, now);
    if (a) actions.push(a);
  }
  const eng = lowEngagementAction(model, now);
  if (eng) actions.push(eng);
  const ref = referralAction(model, now);
  if (ref) actions.push(ref);

  // Dedupe by stable id (a node could surface in multiple insight rules).
  const seen = new Set<string>();
  const unique: Action[] = [];
  for (const a of actions) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    unique.push(a);
  }

  unique.sort((a, b) => {
    const u = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (u !== 0) return u;
    return KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
  });

  return unique;
}

export const ACTION_CONSTANTS = {
  URGENCY_ORDER,
  KIND_PRIORITY,
} as const;
