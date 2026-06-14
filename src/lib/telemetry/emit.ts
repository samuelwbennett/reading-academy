// src/lib/telemetry/emit.ts
//
// Canonical telemetry emitter. Three guarantees:
//   1. emit() is sync and never throws — telemetry must not break a
//      drill, even if storage is full or the call is malformed.
//   2. Validation runs in dev (vite mode `development`); in prod the
//      checker runs but only logs warnings.
//   3. Every event is written to (a) console.info under [reading.telemetry]
//      and (b) the localStorage queue for later flush.

import type {
  AnyEnvelope,
  Envelope,
  EventName,
  FluencyRecordedPayload,
  HintUsedPayload,
  ItemCompletedPayload,
  ItemStartedPayload,
  MasteryAwardedPayload,
  MasteryRevokedPayload,
  PassageCompletedPayload,
  PassageStartedPayload,
  ResponseCorrectPayload,
  ResponseIncorrectPayload,
  ResponseSubmittedPayload,
  SessionEndedPayload,
  SessionStartedPayload,
} from "./types";
import { APP_ID, TELEMETRY_SCHEMA_VERSION } from "./types";
import { enqueue } from "./queue";
import { getClientId, getOrRollSessionId } from "./session";
import { validateEnvelope } from "./validate";

const TAG = "[reading.telemetry]";

let currentStudentId: string | null = null;

export function setStudentId(studentId: string | null): void {
  currentStudentId = studentId;
}

export function getStudentId(): string | null {
  return currentStudentId;
}

interface EmitOptions {
  studentId?: string | null;
  /** Optional override; default is current sessionId. */
  sessionId?: string;
  /** Optional override; default is Date.now(). */
  ts?: number;
}

function buildEnvelope<P extends Record<string, unknown>>(
  event: EventName,
  payload: P,
  opts: EmitOptions = {},
): Envelope<P> {
  const { sessionId } = getOrRollSessionId(opts.ts);
  return {
    event,
    ts: opts.ts ?? Date.now(),
    schema: TELEMETRY_SCHEMA_VERSION,
    appId: APP_ID,
    studentId: opts.studentId ?? currentStudentId,
    sessionId: opts.sessionId ?? sessionId,
    clientId: getClientId(),
    payload,
  };
}

/**
 * Low-level emitter. Prefer the typed convenience functions below for
 * call-site safety.
 */
export function emit<P extends Record<string, unknown>>(
  event: EventName,
  payload: P,
  opts: EmitOptions = {},
): Envelope<P> {
  const env = buildEnvelope(event, payload, opts);
  const errs = validateEnvelope(env);
  if (errs.length > 0) {
    console.warn(`${TAG} INVALID ${event}`, errs, env);
  } else {
    console.info(`${TAG} ${event}`, env);
  }
  enqueue(env as unknown as AnyEnvelope);
  return env;
}

// ---------- Typed convenience emitters ----------

export const sessionStarted = (p: SessionStartedPayload, o?: EmitOptions) =>
  emit("session_started", p as unknown as Record<string, unknown>, o);

export const sessionEnded = (p: SessionEndedPayload, o?: EmitOptions) =>
  emit("session_ended", p as unknown as Record<string, unknown>, o);

export const itemStarted = (p: ItemStartedPayload, o?: EmitOptions) =>
  emit("item_started", p as unknown as Record<string, unknown>, o);

export const responseSubmitted = (
  p: ResponseSubmittedPayload,
  o?: EmitOptions,
) => emit("response_submitted", p as unknown as Record<string, unknown>, o);

export const responseCorrect = (p: ResponseCorrectPayload, o?: EmitOptions) =>
  emit("response_correct", p as unknown as Record<string, unknown>, o);

export const responseIncorrect = (
  p: ResponseIncorrectPayload,
  o?: EmitOptions,
) => emit("response_incorrect", p as unknown as Record<string, unknown>, o);

export const hintUsed = (p: HintUsedPayload, o?: EmitOptions) =>
  emit("hint_used", p as unknown as Record<string, unknown>, o);

export const itemCompleted = (p: ItemCompletedPayload, o?: EmitOptions) =>
  emit("item_completed", p as unknown as Record<string, unknown>, o);

export const masteryAwarded = (p: MasteryAwardedPayload, o?: EmitOptions) =>
  emit("mastery_awarded", p as unknown as Record<string, unknown>, o);

export const masteryRevoked = (p: MasteryRevokedPayload, o?: EmitOptions) =>
  emit("mastery_revoked", p as unknown as Record<string, unknown>, o);

export const passageStarted = (p: PassageStartedPayload, o?: EmitOptions) =>
  emit("passage_started", p as unknown as Record<string, unknown>, o);

export const passageCompleted = (p: PassageCompletedPayload, o?: EmitOptions) =>
  emit("passage_completed", p as unknown as Record<string, unknown>, o);

export const fluencyRecorded = (p: FluencyRecordedPayload, o?: EmitOptions) =>
  emit("fluency_recorded", p as unknown as Record<string, unknown>, o);
