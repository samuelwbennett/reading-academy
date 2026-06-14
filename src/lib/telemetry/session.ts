// src/lib/telemetry/session.ts
//
// Stable sessionId + clientId management. Sessions roll after 30 minutes
// of idle. The clientId is a per-device UUID written once and reused;
// it lets us correlate events even before a studentId is known.

const SESSION_KEY = "reading-academy:session:v1";
const CLIENT_KEY = "reading-academy:client-id:v1";
const SESSION_IDLE_MS = 30 * 60 * 1000;

interface SessionRecord {
  id: string;
  startedAt: number;
  lastTouchedAt: number;
}

function uuid(): string {
  // Prefer crypto.randomUUID; fall back to RFC4122 v4-ish.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function readJson<T>(key: string): T | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* swallow */
  }
}

export function getClientId(): string {
  let id = readJson<string>(CLIENT_KEY);
  if (typeof id === "string" && id.length > 0) return id;
  id = uuid();
  writeJson(CLIENT_KEY, id);
  return id;
}

export function getOrRollSessionId(now: number = Date.now()): {
  sessionId: string;
  rolled: boolean;
} {
  const existing = readJson<SessionRecord>(SESSION_KEY);
  if (existing && now - existing.lastTouchedAt < SESSION_IDLE_MS) {
    const updated: SessionRecord = { ...existing, lastTouchedAt: now };
    writeJson(SESSION_KEY, updated);
    return { sessionId: existing.id, rolled: false };
  }
  const fresh: SessionRecord = {
    id: uuid(),
    startedAt: now,
    lastTouchedAt: now,
  };
  writeJson(SESSION_KEY, fresh);
  return { sessionId: fresh.id, rolled: true };
}

export function endSession(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* swallow */
  }
}

export function peekSession(): SessionRecord | null {
  return readJson<SessionRecord>(SESSION_KEY);
}
