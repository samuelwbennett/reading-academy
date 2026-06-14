// src/lib/telemetry/index.ts
//
// Public surface of the telemetry module. Import from here, not from
// the individual files, so the internal layout can change without
// breaking call sites.

export * from "./types";
export {
  emit,
  setStudentId,
  getStudentId,
  sessionStarted,
  sessionEnded,
  itemStarted,
  responseSubmitted,
  responseCorrect,
  responseIncorrect,
  hintUsed,
  itemCompleted,
  masteryAwarded,
  masteryRevoked,
  passageStarted,
  passageCompleted,
  fluencyRecorded,
} from "./emit";
export {
  enqueue,
  peekAll,
  drain,
  clear,
  size as queueSize,
} from "./queue";
export {
  getClientId,
  getOrRollSessionId,
  endSession,
  peekSession,
} from "./session";
export { validateEnvelope, assertEnvelope } from "./validate";
