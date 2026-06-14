// src/lib/mastery/bridge.ts
//
// Bridge between the legacy UI state (src/data/student_state.json shape,
// kept under localStorage key "reading-academy:student-state:v1") and
// the canonical StudentModel introduced in M3-B.
//
// Why a bridge instead of a rewrite?
//   - The UI layer (Drill, Diagnostic, Fluency, Passage routes) reads
//     from the legacy shape. Rewriting all of them at once is risky
//     and unnecessary.
//   - The orchestration layer needs the canonical StudentModel.
//   - Both representations are derivable from the same underlying
//     telemetry stream.
//
// The bridge keeps both views consistent: every legacy attempt
// recorded by `recordAttempt` is also fed into the StudentModel via
// the canonical mastery engine, persisted to its own storage key, and
// available to the M3 review scheduler and forgetting-risk model.
//
// Pure where possible. The only side effect is the optional
// load/save through src/lib/mastery/storage.ts.

import skillNodes from "../../data/skill_nodes.json";
import {
  type FluencyGate,
  type StudentModel,
  setNode,
  setFluency,
  getNode,
  getFluency,
} from "./studentModel";
import {
  updateNodeMastery,
  updateFluencyState,
  type NodeConfig,
} from "./masteryEngine";
import { load, save } from "./storage";
import {
  masteryAwarded,
  masteryRevoked,
} from "../telemetry/emit";
import type { Surface } from "../telemetry/types";
import { schedulePush } from "./sync";
import { scheduleReviewFsrs } from "../review/reviewScheduler";

const FLUENCY_GATES: ReadonlySet<string> = new Set([
  "FL_01_cvc_fluency",
  "FL_02_blend_digraph_fluency",
  "FL_03_silent_e_fluency",
  "FL_04_grade2_fluency",
]);

// Build a quick lookup table of node configs from the curriculum json.
const NODE_CONFIGS: Record<string, NodeConfig> = (() => {
  const out: Record<string, NodeConfig> = {};
  for (const n of skillNodes as Array<Record<string, unknown>>) {
    const id = n.id as string;
    if (!id) continue;
    out[id] = {
      id,
      mastery: n.mastery as NodeConfig["mastery"],
      automaticity_target_latency_ms:
        n.automaticity_target_latency_ms as number | undefined,
      mastery_accuracy_floor: n.mastery_accuracy_floor as number | undefined,
    };
  }
  return out;
})();

const MASTERED_STATES = new Set([
  "mastered_for_acquisition",
  "in_automaticity_zone",
  "automatic",
]);

export interface RecordAttemptInput {
  nodeId: string;
  itemId: string;
  correct: boolean;
  latencyMs: number;
  hintCount?: number;
  surface?: Surface;
  ts?: number;
}

/**
 * Record an item attempt in the canonical StudentModel and persist.
 * Emits canonical mastery_awarded / mastery_revoked events on
 * threshold transitions. Returns the next student-model snapshot.
 */
export function recordAttempt(
  input: RecordAttemptInput,
  modelIn?: StudentModel,
): StudentModel {
  const model = modelIn ?? load();
  const config = NODE_CONFIGS[input.nodeId] ?? { id: input.nodeId };
  const prior = getNode(model, input.nodeId);

  const { next, transitioned, from, to } = updateNodeMastery(
    prior,
    {
      itemId: input.itemId,
      correct: input.correct,
      latencyMs: input.latencyMs,
      hintCount: input.hintCount ?? 0,
      surface: input.surface ?? "drill",
      ts: input.ts,
    },
    config,
  );

  // FSRS card update — runs on every attempt and provides the
  // canonical reviewDueAt for the spaced-review queue.
  const fsrs = scheduleReviewFsrs({
    card: prior.fsrsCard,
    attempt: {
      correct: input.correct,
      latencyMs: input.latencyMs,
      targetLatencyMs: config.automaticity_target_latency_ms,
    },
    now: input.ts,
  });
  next.fsrsCard = fsrs.card;
  next.reviewDueAt = fsrs.reviewDueAt;

  const updated = setNode(model, next);
  save(updated);
  schedulePush();

  if (transitioned) {
    const goingUp = !MASTERED_STATES.has(from) && MASTERED_STATES.has(to);
    const goingDown = MASTERED_STATES.has(from) && !MASTERED_STATES.has(to);
    if (goingUp) {
      masteryAwarded({
        nodeId: input.nodeId,
        from,
        to,
        evidence: {
          accuracy: next.rollingAccuracy,
          avgLatencyMs: next.rollingLatencyMs,
          attempts: next.attempts,
        },
      });
    } else if (goingDown) {
      const reason: "forgetting" | "accuracy_drop" | "latency_drift" =
        to === "regressed" ? "forgetting" : "accuracy_drop";
      masteryRevoked({
        nodeId: input.nodeId,
        from,
        to,
        reason,
      });
    }
  }

  return updated;
}

export interface RecordPassageInput {
  passageId: string;
  gateId: string;
  isCold: boolean;
  wcpm: number;
  accuracy: number;
  ts?: number;
}

/**
 * Record a passage attempt and update the relevant fluency-gate state.
 * Returns the updated StudentModel; persists it.
 */
export function recordPassage(
  input: RecordPassageInput,
  modelIn?: StudentModel,
): StudentModel {
  if (!FLUENCY_GATES.has(input.gateId)) {
    console.warn(`[bridge] unknown gateId "${input.gateId}"; skipping`);
    return modelIn ?? load();
  }
  const model = modelIn ?? load();
  const gateId = input.gateId as FluencyGate;
  const prior = getFluency(model, gateId);
  const next = updateFluencyState(
    prior,
    {
      passageId: input.passageId,
      isCold: input.isCold,
      wcpm: input.wcpm,
      accuracy: input.accuracy,
      ts: input.ts,
    },
    gateId,
  );
  const updated = setFluency(model, next);
  save(updated);
  schedulePush();
  return updated;
}

/**
 * Re-export the storage layer so callers don't need a second import.
 */
export { load as loadModel, save as saveModel } from "./storage";
