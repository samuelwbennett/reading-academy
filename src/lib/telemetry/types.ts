// src/lib/telemetry/types.ts
//
// Canonical telemetry envelope and per-event payload types.
// See docs/telemetry/events.md for the full schema.

export const TELEMETRY_SCHEMA_VERSION = "telemetry/v1";
export const APP_ID = "reading-academy";

export type Surface =
  | "drill"
  | "diagnostic"
  | "fluency"
  | "passage"
  | "review"
  | "reading_facts";

export type ScoringSource = "asr" | "self" | "tap" | "text";

export type EventName =
  | "session_started"
  | "session_ended"
  | "item_started"
  | "response_submitted"
  | "response_correct"
  | "response_incorrect"
  | "hint_used"
  | "item_completed"
  | "mastery_awarded"
  | "mastery_revoked"
  | "passage_started"
  | "passage_completed"
  | "fluency_recorded";

export interface Envelope<P = Record<string, unknown>> {
  event: EventName;
  ts: number;
  schema: typeof TELEMETRY_SCHEMA_VERSION;
  appId: typeof APP_ID;
  studentId?: string | null;
  sessionId: string;
  clientId?: string;
  payload: P;
}

// ----- Per-event payload shapes -----

export interface SessionStartedPayload {
  route: string;
  cold_start: boolean;
}

export interface SessionEndedPayload {
  duration_ms: number;
  items_attempted: number;
  xp_earned: number;
}

export interface ItemStartedPayload {
  nodeId: string;
  itemId: string;
  attempt_n: number;
  surface: Surface;
}

export interface ResponseSubmittedPayload {
  nodeId: string;
  itemId: string;
  expected: string;
  transcript: string;
  latency_ms: number;
  confidence?: number;
  scoringSrc: ScoringSource;
}

export interface ResponseCorrectPayload {
  nodeId: string;
  itemId: string;
  latency_ms: number;
  attempt_n: number;
}

export interface ResponseIncorrectPayload {
  nodeId: string;
  itemId: string;
  latency_ms: number;
  attempt_n: number;
  errorClass?: string;
}

export interface HintUsedPayload {
  nodeId: string;
  itemId: string;
  hintLevel: number;
}

export interface ItemCompletedPayload {
  nodeId: string;
  itemId: string;
  correct: boolean;
  latency_ms: number;
  hint_count: number;
  xp_awarded: number;
}

export interface MasteryAwardedPayload {
  nodeId: string;
  from: string;
  to: string;
  evidence: {
    accuracy: number;
    avgLatencyMs: number;
    attempts: number;
  };
}

export interface MasteryRevokedPayload {
  nodeId: string;
  from: string;
  to: string;
  reason: "forgetting" | "accuracy_drop" | "latency_drift";
}

export interface PassageStartedPayload {
  passageId: string;
  gateId: string;
  isCold: boolean;
  targetWordCount: number;
}

export interface PassageCompletedPayload {
  passageId: string;
  gateId: string;
  isCold: boolean;
  wcpm: number;
  accuracy: number;
  errors: number;
  duration_ms: number;
  selfCorrections?: number;
}

export interface FluencyRecordedPayload {
  nodeId: string;
  surface: Surface;
  wcpm: number;
  accuracy: number;
  latency_ms: number;
  personal_best: boolean;
}

// Union for type-safe consumers.
export type AnyEnvelope =
  | Envelope<SessionStartedPayload>
  | Envelope<SessionEndedPayload>
  | Envelope<ItemStartedPayload>
  | Envelope<ResponseSubmittedPayload>
  | Envelope<ResponseCorrectPayload>
  | Envelope<ResponseIncorrectPayload>
  | Envelope<HintUsedPayload>
  | Envelope<ItemCompletedPayload>
  | Envelope<MasteryAwardedPayload>
  | Envelope<MasteryRevokedPayload>
  | Envelope<PassageStartedPayload>
  | Envelope<PassageCompletedPayload>
  | Envelope<FluencyRecordedPayload>;
