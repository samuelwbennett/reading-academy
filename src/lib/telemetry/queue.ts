// src/lib/telemetry/queue.ts
//
// localStorage-backed FIFO queue for telemetry envelopes. Designed so
// that the hot-path emit() never blocks and never throws — failures
// (quota exceeded, disabled storage) are swallowed and surfaced via
// console.warn so operations can spot them.
//
// The queue is the seam between the client and the orchestration
// layer's `skill_attempts` ingestor. M3 scope is the queue; the flush
// path lands in M5 along with the Supabase wiring.

import type { AnyEnvelope } from "./types";

const QUEUE_KEY = "reading-academy:telemetry-queue:v1";
const MAX_QUEUE_BYTES = 256 * 1024; // 256KB hard cap; oldest entries dropped above this.
const MAX_ENTRIES = 2000;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

function getStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    // Probe to detect Safari private mode et al.
    localStorage.setItem("__probe__", "1");
    localStorage.removeItem("__probe__");
    return localStorage;
  } catch {
    return null;
  }
}

function readAll(storage: Storage): AnyEnvelope[] {
  try {
    const raw = storage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AnyEnvelope[]) : [];
  } catch (err) {
    console.warn("[telemetry] queue parse failed; resetting", err);
    storage.removeItem(QUEUE_KEY);
    return [];
  }
}

function writeAll(storage: Storage, queue: AnyEnvelope[]): void {
  // Trim from the head (oldest) until under both budgets.
  let body = JSON.stringify(queue);
  while (
    queue.length > MAX_ENTRIES ||
    body.length > MAX_QUEUE_BYTES
  ) {
    queue.shift();
    if (queue.length === 0) break;
    body = JSON.stringify(queue);
  }
  try {
    storage.setItem(QUEUE_KEY, body);
  } catch (err) {
    console.warn("[telemetry] queue write failed", err);
  }
}

export function enqueue(env: AnyEnvelope): void {
  const storage = getStorage();
  if (!storage) return; // SSR or storage-disabled — drop silently.
  const queue = readAll(storage);
  queue.push(env);
  writeAll(storage, queue);
}

export function peekAll(): AnyEnvelope[] {
  const storage = getStorage();
  if (!storage) return [];
  return readAll(storage);
}

export function drain(): AnyEnvelope[] {
  const storage = getStorage();
  if (!storage) return [];
  const queue = readAll(storage);
  storage.removeItem(QUEUE_KEY);
  return queue;
}

export function clear(): void {
  const storage = getStorage();
  if (storage) storage.removeItem(QUEUE_KEY);
}

export function size(): number {
  return peekAll().length;
}
