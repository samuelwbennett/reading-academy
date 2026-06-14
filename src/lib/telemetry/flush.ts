// src/lib/telemetry/flush.ts
//
// Drains the localStorage telemetry queue into Supabase tables.
//
// Routing rules (matches docs/data/supabase-schema-v1.md):
//   - response_correct + response_incorrect → skill_attempts
//   - passage_completed                     → passage_attempts
//   - mastery_awarded + mastery_revoked     → mastery_snapshots
//   - everything else                        → telemetry_events
//   - response_submitted                    → telemetry_events (the
//       canonical pair lives in skill_attempts; the raw transcript is
//       informational)
//
// Idempotency: every row's primary key is generated client-side as a
// UUID v4 derived from `event + ts + sessionId + nodeId/itemId`. Two
// retries of the same envelope are no-ops at the database layer.
//
// Concurrency: flush() is guarded by an in-memory lock so overlapping
// timer ticks don't double-post. Failures put the failed batch back at
// the head of the queue; success removes it.
//
// SSR / no-localStorage: silently no-ops.

import { peekAll, drain, enqueue, size as queueSize } from "./queue";
import type {
  AnyEnvelope,
  EventName,
  ItemCompletedPayload,
  MasteryAwardedPayload,
  MasteryRevokedPayload,
  PassageCompletedPayload,
  ResponseCorrectPayload,
  ResponseIncorrectPayload,
} from "./types";
import { supabase } from "../../services/supabase.js";

const APP_SLUG = "reading_academy";

let flushing = false;
let appIdCache: string | null = null;
let studentIdCache: string | null = null;

// ---- helpers ----

function deriveUuid(seed: string): string {
  // Stable v4-like UUID from a string seed using simple FNV hash → hex.
  // Not cryptographic; just deterministic so retries dedupe.
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xcafebabe >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h1 ^= seed.charCodeAt(i);
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 ^= (seed.charCodeAt(i) + 0x9e3779b9) >>> 0;
    h2 = Math.imul(h2, 2246822519) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  const a = hex(h1);
  const b = hex(h2);
  // Pad with sessionId-derived bytes; we have only 16 hex chars so far,
  // duplicate to reach 32 then format. Set version 4 + variant bits.
  let raw = (a + b + a + b).slice(0, 32);
  const v4 = raw.slice(0, 12) + "4" + raw.slice(13, 16);
  const variant =
    ((parseInt(raw[16], 16) & 0x3) | 0x8).toString(16) + raw.slice(17, 20);
  return (
    v4.slice(0, 8) + "-" +
    v4.slice(8, 12) + "-" +
    v4.slice(12, 16) + "-" +
    variant + "-" +
    raw.slice(20, 32)
  );
}

async function getAppId(): Promise<string | null> {
  if (appIdCache) return appIdCache;
  const { data, error } = await supabase
    .from("learning_apps")
    .select("id")
    .eq("slug", APP_SLUG)
    .maybeSingle();
  if (error) {
    console.warn("[telemetry.flush] learning_apps lookup failed:", error.message);
    return null;
  }
  appIdCache = data?.id ?? null;
  return appIdCache;
}

async function getStudentId(): Promise<string | null> {
  if (studentIdCache) return studentIdCache;
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData?.user?.id;
  if (!uid) return null;
  const { data, error } = await supabase
    .from("students")
    .select("id")
    .eq("auth_user_id", uid)
    .maybeSingle();
  if (error) {
    console.warn("[telemetry.flush] students lookup failed:", error.message);
    return null;
  }
  studentIdCache = data?.id ?? null;
  return studentIdCache;
}

// ---- payload routers ----

interface Bucketed {
  skill_attempts: Array<Record<string, unknown>>;
  passage_attempts: Array<Record<string, unknown>>;
  mastery_snapshots: Array<Record<string, unknown>>;
  telemetry_events: Array<Record<string, unknown>>;
}

const ATTEMPT_TERMINAL: ReadonlySet<EventName> = new Set([
  "response_correct",
  "response_incorrect",
]);

// Pair the most recent item_started/response_submitted with its terminal
// event so skill_attempts gets the full picture. We do this in a single
// pass by indexing on (sessionId, itemId) for items in the same batch.
function bucketize(
  envelopes: AnyEnvelope[],
  studentId: string,
  appId: string,
): Bucketed {
  const out: Bucketed = {
    skill_attempts: [],
    passage_attempts: [],
    mastery_snapshots: [],
    telemetry_events: [],
  };

  // Index supplemental fields by (sessionId|itemId) so we can enrich
  // skill_attempts rows with transcript/expected/confidence/hint_count.
  const enrich = new Map<
    string,
    {
      transcript?: string;
      expected?: string;
      confidence?: number;
      hint_count?: number;
      xp_awarded?: number;
    }
  >();

  for (const env of envelopes) {
    const key = `${env.sessionId}|${
      (env.payload as unknown as Record<string, unknown>).itemId ?? ""
    }`;
    const p = env.payload as unknown as Record<string, unknown>;
    if (env.event === "response_submitted") {
      const cur = enrich.get(key) ?? {};
      cur.transcript = (p.transcript as string) ?? cur.transcript;
      cur.expected = (p.expected as string) ?? cur.expected;
      cur.confidence = (p.confidence as number) ?? cur.confidence;
      enrich.set(key, cur);
    } else if (env.event === "hint_used") {
      const cur = enrich.get(key) ?? {};
      cur.hint_count = (cur.hint_count ?? 0) + 1;
      enrich.set(key, cur);
    } else if (env.event === "item_completed") {
      const ic = p as unknown as ItemCompletedPayload;
      const cur = enrich.get(key) ?? {};
      cur.hint_count = ic.hint_count ?? cur.hint_count;
      cur.xp_awarded = ic.xp_awarded ?? cur.xp_awarded;
      enrich.set(key, cur);
    }
  }

  for (const env of envelopes) {
    const p = env.payload as unknown as Record<string, unknown>;
    const seedBase = `${env.event}|${env.ts}|${env.sessionId}|${p.itemId ?? p.passageId ?? p.nodeId ?? ""}`;

    if (ATTEMPT_TERMINAL.has(env.event)) {
      const rc = p as unknown as ResponseCorrectPayload | ResponseIncorrectPayload;
      const itemKey = `${env.sessionId}|${rc.itemId}`;
      const meta = enrich.get(itemKey) ?? {};
      out.skill_attempts.push({
        attempt_id: deriveUuid("att|" + seedBase),
        student_id: studentId,
        app_id: appId,
        node_id: rc.nodeId,
        item_id: rc.itemId,
        correct: env.event === "response_correct",
        latency_ms: rc.latency_ms,
        hint_count: meta.hint_count ?? 0,
        surface: "drill",
        attempt_n: rc.attempt_n,
        session_id: env.sessionId,
        xp_awarded: meta.xp_awarded ?? 0,
        transcript: meta.transcript ?? null,
        expected: meta.expected ?? null,
        confidence: meta.confidence ?? null,
        client_ts: new Date(env.ts).toISOString(),
      });
      continue;
    }

    if (env.event === "passage_completed") {
      const pc = p as unknown as PassageCompletedPayload;
      out.passage_attempts.push({
        passage_attempt_id: deriveUuid("pas|" + seedBase),
        student_id: studentId,
        app_id: appId,
        passage_id: pc.passageId,
        gate_id: pc.gateId,
        is_cold: pc.isCold,
        wcpm: pc.wcpm,
        accuracy: pc.accuracy,
        errors: pc.errors,
        duration_ms: pc.duration_ms,
        self_corrections: pc.selfCorrections ?? null,
        session_id: env.sessionId,
        client_ts: new Date(env.ts).toISOString(),
      });
      continue;
    }

    if (env.event === "mastery_awarded" || env.event === "mastery_revoked") {
      const ms = p as unknown as MasteryAwardedPayload | MasteryRevokedPayload;
      out.mastery_snapshots.push({
        snapshot_id: deriveUuid("mas|" + seedBase),
        student_id: studentId,
        app_id: appId,
        node_id: ms.nodeId,
        from_status: ms.from,
        to_status: ms.to,
        reason:
          env.event === "mastery_awarded"
            ? "acquisition"
            : (p as unknown as MasteryRevokedPayload).reason,
        evidence:
          env.event === "mastery_awarded"
            ? (p as unknown as MasteryAwardedPayload).evidence
            : null,
        transitioned_at: new Date(env.ts).toISOString(),
      });
      continue;
    }

    // Catch-all → telemetry_events.
    out.telemetry_events.push({
      event_id: deriveUuid("evt|" + seedBase + "|" + env.event),
      student_id: studentId,
      app_id: appId,
      event: env.event,
      payload: p,
      session_id: env.sessionId,
      client_ts: new Date(env.ts).toISOString(),
    });
  }

  return out;
}

// ---- public API ----

export interface FlushResult {
  attempted: number;
  flushed: number;
  skill_attempts: number;
  passage_attempts: number;
  mastery_snapshots: number;
  telemetry_events: number;
  reason?: string;
}

/**
 * Drain the telemetry queue and POST to Supabase. Safe to call
 * frequently — guarded by an in-memory lock.
 */
export async function flush(): Promise<FlushResult> {
  const empty: FlushResult = {
    attempted: 0,
    flushed: 0,
    skill_attempts: 0,
    passage_attempts: 0,
    mastery_snapshots: 0,
    telemetry_events: 0,
  };
  if (flushing) return { ...empty, reason: "in_progress" };

  const queueLen = queueSize();
  if (queueLen === 0) return empty;

  const studentId = await getStudentId();
  if (!studentId) return { ...empty, reason: "no_student" };
  const appId = await getAppId();
  if (!appId) return { ...empty, reason: "no_app" };

  flushing = true;
  let pulled: AnyEnvelope[] = [];
  try {
    pulled = drain();
    if (pulled.length === 0) return empty;

    const buckets = bucketize(pulled, studentId, appId);
    const inserts: PromiseLike<{ error: unknown }>[] = [];
    if (buckets.skill_attempts.length) {
      inserts.push(
        supabase
          .from("reading_skill_attempts")
          .upsert(buckets.skill_attempts, { onConflict: "attempt_id" })
          .then((r: { error: unknown }) => ({ error: r.error })),
      );
    }
    if (buckets.passage_attempts.length) {
      inserts.push(
        supabase
          .from("reading_passage_attempts")
          .upsert(buckets.passage_attempts, { onConflict: "passage_attempt_id" })
          .then((r: { error: unknown }) => ({ error: r.error })),
      );
    }
    if (buckets.mastery_snapshots.length) {
      inserts.push(
        supabase
          .from("reading_mastery_snapshots")
          .upsert(buckets.mastery_snapshots, { onConflict: "snapshot_id" })
          .then((r: { error: unknown }) => ({ error: r.error })),
      );
    }
    if (buckets.telemetry_events.length) {
      inserts.push(
        supabase
          .from("reading_telemetry_events")
          .upsert(buckets.telemetry_events, { onConflict: "event_id" })
          .then((r: { error: unknown }) => ({ error: r.error })),
      );
    }

    const results = await Promise.all(inserts);
    const firstErr = results.find((r) => r.error)?.error as
      | { message?: string }
      | undefined;
    if (firstErr) {
      // Put everything back at the head of the queue and bail.
      for (const env of pulled) enqueue(env);
      console.warn(
        "[telemetry.flush] insert failed; re-queued",
        pulled.length,
        firstErr.message,
      );
      return { ...empty, reason: `insert_failed:${firstErr.message ?? "unknown"}` };
    }

    return {
      attempted: pulled.length,
      flushed: pulled.length,
      skill_attempts: buckets.skill_attempts.length,
      passage_attempts: buckets.passage_attempts.length,
      mastery_snapshots: buckets.mastery_snapshots.length,
      telemetry_events: buckets.telemetry_events.length,
    };
  } catch (err) {
    for (const env of pulled) enqueue(env);
    console.warn("[telemetry.flush] threw; re-queued", pulled.length, err);
    return { ...empty, reason: `threw:${(err as Error).message}` };
  } finally {
    flushing = false;
  }
}

// ---- auto-flush scheduling ----

const TIMER_MS = 30_000;
let timerId: number | null = null;

/**
 * Start the auto-flush worker. Idempotent. Safe to call from a React
 * effect or once at module import time.
 */
export function startAutoFlush(): () => void {
  if (typeof window === "undefined") return () => {};
  if (timerId != null) return stopAutoFlush;

  const tick = () => {
    flush().catch(() => {});
  };

  timerId = window.setInterval(tick, TIMER_MS);

  // Also flush opportunistically when the tab becomes hidden (user is
  // about to leave).
  const onVis = () => {
    if (document.visibilityState === "hidden") tick();
  };
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("pagehide", tick);

  // Reset caches on auth change so a sign-out + sign-in re-resolves.
  const { data: sub } = supabase.auth.onAuthStateChange(() => {
    appIdCache = null;
    studentIdCache = null;
    tick();
  });

  return () => {
    if (timerId != null) {
      window.clearInterval(timerId);
      timerId = null;
    }
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("pagehide", tick);
    sub?.subscription?.unsubscribe();
  };
}

export function stopAutoFlush(): void {
  if (timerId != null && typeof window !== "undefined") {
    window.clearInterval(timerId);
    timerId = null;
  }
}

/**
 * Reset the in-memory caches. Useful from a sign-in/out flow.
 */
export function resetFlushCaches(): void {
  appIdCache = null;
  studentIdCache = null;
}

// Re-export for convenience.
export { peekAll as peekQueue, queueSize };
