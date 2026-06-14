// src/lib/telemetry/validate.ts
//
// Lightweight runtime validators. We don't pull in zod/ajv yet — the
// payload contracts are small enough that a hand-written checker is
// more readable and zero-dep. Validators are pure: they return a list
// of error strings (empty array = valid).

import type { AnyEnvelope, EventName } from "./types";

type Errors = string[];

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function inRange(v: number, lo: number, hi: number): boolean {
  return v >= lo && v <= hi;
}

const REQUIRED_PAYLOAD_FIELDS: Record<EventName, string[]> = {
  session_started: ["route", "cold_start"],
  session_ended: ["duration_ms", "items_attempted", "xp_earned"],
  item_started: ["nodeId", "itemId", "attempt_n", "surface"],
  response_submitted: [
    "nodeId",
    "itemId",
    "expected",
    "transcript",
    "latency_ms",
    "scoringSrc",
  ],
  response_correct: ["nodeId", "itemId", "latency_ms", "attempt_n"],
  response_incorrect: ["nodeId", "itemId", "latency_ms", "attempt_n"],
  hint_used: ["nodeId", "itemId", "hintLevel"],
  item_completed: [
    "nodeId",
    "itemId",
    "correct",
    "latency_ms",
    "hint_count",
    "xp_awarded",
  ],
  mastery_awarded: ["nodeId", "from", "to", "evidence"],
  mastery_revoked: ["nodeId", "from", "to", "reason"],
  passage_started: ["passageId", "gateId", "isCold", "targetWordCount"],
  passage_completed: [
    "passageId",
    "gateId",
    "isCold",
    "wcpm",
    "accuracy",
    "errors",
    "duration_ms",
  ],
  fluency_recorded: [
    "nodeId",
    "surface",
    "wcpm",
    "accuracy",
    "latency_ms",
    "personal_best",
  ],
};

const VALID_EVENTS: ReadonlySet<EventName> = new Set(
  Object.keys(REQUIRED_PAYLOAD_FIELDS) as EventName[],
);

const VALID_SURFACES = new Set([
  "drill",
  "diagnostic",
  "fluency",
  "passage",
  "review",
  "reading_facts",
]);

/**
 * Validate an envelope. Returns a (possibly empty) list of issues.
 * Never throws — designed to run in production hot paths.
 */
export function validateEnvelope(env: unknown): Errors {
  const errs: Errors = [];

  if (!env || typeof env !== "object") {
    errs.push("envelope: not an object");
    return errs;
  }
  const e = env as Record<string, unknown>;

  if (!isString(e.event)) errs.push("envelope.event: must be non-empty string");
  else if (!VALID_EVENTS.has(e.event as EventName)) {
    errs.push(`envelope.event: unknown event "${e.event}"`);
  }

  if (!isNumber(e.ts) || (e.ts as number) <= 0) {
    errs.push("envelope.ts: must be positive number");
  }
  if (e.schema !== "telemetry/v1") {
    errs.push(`envelope.schema: expected "telemetry/v1", got "${e.schema}"`);
  }
  if (e.appId !== "reading-academy") {
    errs.push(
      `envelope.appId: expected "reading-academy", got "${e.appId}"`,
    );
  }
  if (!isString(e.sessionId)) errs.push("envelope.sessionId: required");
  if (e.studentId != null && !isString(e.studentId)) {
    errs.push("envelope.studentId: must be string or null");
  }
  if (e.payload == null || typeof e.payload !== "object") {
    errs.push("envelope.payload: must be object");
    return errs;
  }

  const payload = e.payload as Record<string, unknown>;
  const required = REQUIRED_PAYLOAD_FIELDS[e.event as EventName];
  if (required) {
    for (const f of required) {
      if (!(f in payload)) {
        errs.push(`payload.${f}: required for ${e.event}`);
      }
    }
  }

  // Per-event semantic checks.
  switch (e.event) {
    case "item_started": {
      if (!VALID_SURFACES.has(payload.surface as string)) {
        errs.push(`payload.surface: invalid "${payload.surface}"`);
      }
      if (!isNumber(payload.attempt_n) || (payload.attempt_n as number) < 1) {
        errs.push("payload.attempt_n: must be ≥ 1");
      }
      break;
    }
    case "response_submitted":
    case "response_correct":
    case "response_incorrect": {
      if (!isNumber(payload.latency_ms) || (payload.latency_ms as number) < 0) {
        errs.push("payload.latency_ms: must be ≥ 0");
      }
      break;
    }
    case "passage_completed":
    case "fluency_recorded": {
      const acc = payload.accuracy as number | undefined;
      if (acc != null && !inRange(acc, 0, 1)) {
        errs.push("payload.accuracy: must be in [0,1]");
      }
      const wcpm = payload.wcpm as number | undefined;
      if (wcpm != null && (!isNumber(wcpm) || wcpm < 0)) {
        errs.push("payload.wcpm: must be ≥ 0");
      }
      break;
    }
    case "mastery_revoked": {
      const reason = payload.reason;
      if (
        reason !== "forgetting" &&
        reason !== "accuracy_drop" &&
        reason !== "latency_drift"
      ) {
        errs.push(`payload.reason: invalid "${reason}"`);
      }
      break;
    }
  }

  return errs;
}

/** Throwing variant for tests. */
export function assertEnvelope(env: AnyEnvelope): void {
  const errs = validateEnvelope(env);
  if (errs.length > 0) {
    throw new Error("invalid telemetry envelope:\n  " + errs.join("\n  "));
  }
}
