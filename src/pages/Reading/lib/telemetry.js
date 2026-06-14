// Reading Academy telemetry — legacy facade.
//
// As of M4-A this file is a back-compat shim. The canonical telemetry
// pipeline lives in src/lib/telemetry/. Every legacy convenience call
// here forwards into the canonical emitters so events land in the
// localStorage queue with the proper envelope (event, ts, schema,
// appId, studentId, sessionId, clientId, payload).
//
// The legacy console.info("[reading.telemetry] …") line is preserved
// for dev-tools muscle memory: open devtools and the same tag still
// shows up.

import {
  emit as canonicalEmit,
  responseSubmitted,
  responseCorrect,
  responseIncorrect,
  itemCompleted,
  itemStarted,
  masteryAwarded,
  masteryRevoked,
  passageStarted,
  passageCompleted,
  fluencyRecorded,
  sessionStarted,
} from "../../../lib/telemetry/index";
import { recordAttempt, recordPassage } from "../../../lib/mastery/bridge";

const TAG = "[reading.telemetry]";

const MASTERED_STATES = new Set([
  "mastered_for_acquisition",
  "in_automaticity_zone",
  "automatic",
  "mastered", // legacy alias used by existing readingState.js
]);

function legacyLog(event, payload) {
  // Pretty-print in dev tools; flat enough for Sentry-equivalent ingestion later.
  console.info(`${TAG} ${event}`, { event, ts: Date.now(), ...payload });
}

/**
 * Generic legacy emit. Names use dotted form (e.g. "fluency.attempt").
 * Canonical events use snake_case ("response_correct"). We map the
 * common dotted aliases below; everything else is logged as legacy
 * only and does NOT enter the canonical queue (which by design only
 * accepts the v1 taxonomy).
 */
export function emit(event, fields = {}) {
  const payload = { ...fields };
  legacyLog(event, payload);

  switch (event) {
    case "diagnostic.completed":
    case "diagnostic.cancelled":
      // No canonical equivalent yet — diagnostic-specific events live
      // in the legacy log; M5 may add diagnostic_started/completed.
      return payload;

    case "fluency.drill_started":
      // Fluency drill is a session-level slice; we map this to a
      // session_started so analytics can bucket fluency attempts.
      sessionStarted({
        route: "/reading/fluency",
        cold_start: false,
      });
      return payload;

    case "fluency.attempt":
      // A reading-facts word attempt. Most fields are present.
      if (fields.nodeId && fields.itemId != null) {
        responseSubmitted({
          nodeId: fields.nodeId,
          itemId: String(fields.itemId),
          expected: fields.expected ?? "",
          transcript: fields.transcript ?? "",
          latency_ms: fields.latencyMs ?? 0,
          confidence: fields.confidence,
          scoringSrc: fields.scoringSource ?? "asr",
        });
        if (fields.correct) {
          responseCorrect({
            nodeId: fields.nodeId,
            itemId: String(fields.itemId),
            latency_ms: fields.latencyMs ?? 0,
            attempt_n: fields.attempt_n ?? 1,
          });
        } else {
          responseIncorrect({
            nodeId: fields.nodeId,
            itemId: String(fields.itemId),
            latency_ms: fields.latencyMs ?? 0,
            attempt_n: fields.attempt_n ?? 1,
            errorClass: fields.errorClass,
          });
        }
        itemCompleted({
          nodeId: fields.nodeId,
          itemId: String(fields.itemId),
          correct: !!fields.correct,
          latency_ms: fields.latencyMs ?? 0,
          hint_count: fields.hintCount ?? 0,
          xp_awarded: fields.xpAwarded ?? 0,
        });
        // Mirror into the canonical StudentModel.
        try {
          recordAttempt({
            nodeId: fields.nodeId,
            itemId: String(fields.itemId),
            correct: !!fields.correct,
            latencyMs: fields.latencyMs ?? 0,
            hintCount: fields.hintCount ?? 0,
            surface: "reading_facts",
          });
        } catch (e) {
          console.warn("[reading.telemetry] bridge recordAttempt failed", e);
        }
      }
      return payload;

    case "fluency.drill_complete":
      if (fields.nodeId) {
        fluencyRecorded({
          nodeId: fields.nodeId,
          surface: "reading_facts",
          wcpm: fields.wcpm ?? 0,
          accuracy: fields.accuracy ?? 0,
          latency_ms: fields.medianLatencyMs ?? 0,
          personal_best: !!fields.personalBest,
        });
      }
      return payload;

    case "passage.drill_started":
      if (fields.passageId && fields.gateId) {
        passageStarted({
          passageId: fields.passageId,
          gateId: fields.gateId,
          isCold: !!fields.isCold,
          targetWordCount: fields.targetWordCount ?? 0,
        });
      }
      return payload;

    case "passage.drill_complete":
      if (fields.passageId && fields.gateId) {
        passageCompleted({
          passageId: fields.passageId,
          gateId: fields.gateId,
          isCold: !!fields.isCold,
          wcpm: fields.wcpm ?? 0,
          accuracy: fields.accuracy ?? 0,
          errors: fields.errors ?? 0,
          duration_ms: fields.durationMs ?? 0,
          selfCorrections: fields.selfCorrections,
        });
        try {
          recordPassage({
            passageId: fields.passageId,
            gateId: fields.gateId,
            isCold: !!fields.isCold,
            wcpm: fields.wcpm ?? 0,
            accuracy: fields.accuracy ?? 0,
          });
        } catch (e) {
          console.warn("[reading.telemetry] bridge recordPassage failed", e);
        }
      }
      return payload;

    default:
      // Unknown events stay in the legacy log only.
      return payload;
  }
}

// ---------- Legacy convenience wrappers ----------

export function masteryTransition({ nodeId, from, to, reason }) {
  legacyLog("mastery.transition", { nodeId, from, to, reason });

  const goingUp = !MASTERED_STATES.has(from) && MASTERED_STATES.has(to);
  const goingDown = MASTERED_STATES.has(from) && !MASTERED_STATES.has(to);

  if (goingUp) {
    masteryAwarded({
      nodeId,
      from,
      to,
      evidence: {
        accuracy: reason?.accuracy ?? 0,
        avgLatencyMs: reason?.avgLatencyMs ?? 0,
        attempts: reason?.attempts ?? 0,
      },
    });
  } else if (goingDown) {
    let mappedReason = "accuracy_drop";
    if (typeof reason === "string" && reason.toLowerCase().includes("forget")) {
      mappedReason = "forgetting";
    } else if (
      typeof reason === "string" &&
      reason.toLowerCase().includes("latency")
    ) {
      mappedReason = "latency_drift";
    }
    masteryRevoked({ nodeId, from, to, reason: mappedReason });
  }
  // Mid-tier transitions (e.g. unlocked → active) emit no canonical
  // event by design; only acquisition + regression cross the threshold.
}

export function diagnosticCompleted({
  studentId,
  results,
  activeNodeId,
  durationMs,
}) {
  // No canonical diagnostic_completed yet. Keep legacy log only.
  return canonicalEmit("session_started", {
    route: "/reading/diagnostic",
    cold_start: false,
  }) && legacyLog("diagnostic.completed", {
    studentId,
    activeNodeId,
    nodesTested: results.length,
    nodesPassed: results.filter((r) => r.correctCount >= r.total).length,
    results,
    durationMs,
  });
}

export function drillAttempt({
  studentId,
  nodeId,
  itemId,
  expected,
  transcript,
  correct,
  latencyMs,
  scoringSource,
  confidence,
  attemptN = 1,
  hintCount = 0,
  surface = "drill",
  xpAwarded = 0,
}) {
  legacyLog("drill.attempt", {
    studentId,
    nodeId,
    itemId,
    expected,
    transcript,
    correct,
    latencyMs,
    scoringSource,
    confidence,
  });

  if (!nodeId || itemId == null) return;
  itemStarted({
    nodeId,
    itemId: String(itemId),
    attempt_n: attemptN,
    surface,
  });
  responseSubmitted({
    nodeId,
    itemId: String(itemId),
    expected: expected ?? "",
    transcript: transcript ?? "",
    latency_ms: latencyMs ?? 0,
    confidence,
    scoringSrc: scoringSource ?? "asr",
  });
  if (correct) {
    responseCorrect({
      nodeId,
      itemId: String(itemId),
      latency_ms: latencyMs ?? 0,
      attempt_n: attemptN,
    });
  } else {
    responseIncorrect({
      nodeId,
      itemId: String(itemId),
      latency_ms: latencyMs ?? 0,
      attempt_n: attemptN,
    });
  }
  itemCompleted({
    nodeId,
    itemId: String(itemId),
    correct: !!correct,
    latency_ms: latencyMs ?? 0,
    hint_count: hintCount,
    xp_awarded: xpAwarded,
  });
  try {
    recordAttempt({
      nodeId,
      itemId: String(itemId),
      correct: !!correct,
      latencyMs: latencyMs ?? 0,
      hintCount,
      surface,
    });
  } catch (e) {
    console.warn("[reading.telemetry] bridge recordAttempt failed", e);
  }
}

// M16-H1: speech.recognition_error is a DIAGNOSTIC for the engine,
// not an attempt outcome. The previous version of this wrapper also
// emitted responseIncorrect as a side effect — that produced the
// production sequence:
//   speech.recognition_error → response_incorrect
// even when the recognizer simply couldn't capture audio (no answer
// from the student at all). Soft-retry handling in Drill.handleMicTap
// already prevents commit() / drillAttempt from firing, but this helper
// was leaking a phantom incorrect attempt into the telemetry pipeline.
//
// Fix: emit ONLY the diagnostic event. No responseIncorrect, no
// itemCompleted, no responseSubmitted. The student didn't answer
// wrong — the recognizer failed.
export function speechRecognitionError({ nodeId, itemId, expected, errorCode }) {
  legacyLog("speech.recognition_error", {
    nodeId,
    itemId,
    expected,
    errorCode,
  });
}
