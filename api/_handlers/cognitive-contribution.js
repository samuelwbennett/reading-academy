// =============================================================
// READING ACADEMY — /api/cognitive-contribution
//
// Implements the v1 Cognitive Profile contributor protocol.
// Returns Reading Academy's per-dimension evidence for the given
// student. The orchestration layer calls this and merges with
// other apps' contributions.
//
// Architecture rule: Reading Academy CONTRIBUTES, never owns the
// final profile. The orchestration layer is the source of truth for
// the merged dimensions.
//
// Spec: docs/architecture/cognitive-profile-v1.md
// Math:  src/lib/cognitive/contribution.ts (TS, browser-safe)
//
// This file mirrors the TS math because Vercel functions don't
// share a tsconfig with the SPA bundle. Keep them in sync — the
// validator will eventually grow a parity check.
// =============================================================

import { createClient } from "@supabase/supabase-js";

const APP_SLUG = "reading_academy";
const SCHEMA_VERSION = "cognitive-profile/v1";
const CONTRACT_VERSION = "1.0";

const MASTERED_STATES = new Set([
  "mastered",
  "mastered_for_acquisition",
  "in_automaticity_zone",
  "automatic",
]);

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
function confidenceFromSamples(n, scale = 50) {
  if (n <= 0) return 0;
  return clamp01(1 - Math.exp(-n / scale)) * 0.9;
}
function nodeMap(state) {
  const legacy = state?.nodes || {};
  const m3 = state?.modelV2?.nodes || {};
  const out = { ...legacy };
  for (const k of Object.keys(m3)) out[k] = m3[k];
  return out;
}
function attemptsArray(ns) {
  if (Array.isArray(ns?.history)) return ns.history;
  if (Array.isArray(ns?.attempts)) return ns.attempts;
  return [];
}
function totalAttempts(nodes) {
  let n = 0;
  for (const ns of Object.values(nodes)) n += attemptsArray(ns).length;
  return n;
}

// ---- per-dimension derivations (mirrors contribution.ts) ----

function deriveAutomaticity(nodes) {
  const cards = [];
  for (const ns of Object.values(nodes)) {
    if (ns?.fsrsCard && ns.fsrsCard.reps >= 2) cards.push(ns.fsrsCard);
  }
  if (cards.length === 0) return null;
  const STABILITY_TARGET_DAYS = 30;
  const meanStability = cards.reduce((a, c) => a + c.stability, 0) / cards.length;
  const value = clamp01(meanStability / STABILITY_TARGET_DAYS);
  const samples = cards.reduce((a, c) => a + c.reps, 0);
  return {
    dimension: "automaticity",
    value,
    confidence: confidenceFromSamples(samples, 80),
    samples,
    evidence: {
      method: "fsrs_stability_aggregate",
      details: `Mean FSRS stability ${meanStability.toFixed(1)}d across ${cards.length} nodes (${samples} reviews).`,
    },
  };
}

function deriveWorkingPace(nodes) {
  const all = [];
  for (const ns of Object.values(nodes)) {
    for (const a of attemptsArray(ns)) {
      if (Number.isFinite(a?.ts) && Number.isFinite(a?.latencyMs) && a.latencyMs > 0) {
        all.push(a);
      }
    }
  }
  if (all.length < 8) return null;
  const meanLatencyMs = all.reduce((a, x) => a + x.latencyMs, 0) / all.length;
  if (meanLatencyMs <= 0) return null;
  const ipm = 60_000 / meanLatencyMs;
  const value = clamp01(ipm / 6);
  return {
    dimension: "workingPace",
    value,
    confidence: confidenceFromSamples(all.length, 100),
    samples: all.length,
    evidence: {
      method: "items_per_minute_window",
      details: `Mean response latency ${Math.round(meanLatencyMs)}ms → ${ipm.toFixed(2)} items/min (target 6).`,
    },
  };
}

function derivePersistence(nodes) {
  const events = [];
  for (const ns of Object.values(nodes)) {
    for (const a of attemptsArray(ns)) {
      if (Number.isFinite(a?.ts) && typeof a?.correct === "boolean") {
        events.push({ ts: a.ts, correct: a.correct });
      }
    }
  }
  if (events.length < 6) return null;
  events.sort((a, b) => a.ts - b.ts);
  const FIVE_MIN = 5 * 60 * 1000;
  let wrong = 0;
  let continued = 0;
  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].correct) continue;
    wrong += 1;
    if (events[i + 1].ts - events[i].ts < FIVE_MIN) continued += 1;
  }
  if (wrong < 3) return null;
  return {
    dimension: "persistence",
    value: clamp01(continued / wrong),
    confidence: confidenceFromSamples(wrong, 20),
    samples: wrong,
    evidence: {
      method: "post_failure_continuation_ratio",
      details: `${continued}/${wrong} incorrect attempts had a follow-up within 5 minutes.`,
    },
  };
}

function deriveForgettingSlope(nodes) {
  let totalReps = 0;
  let totalLapses = 0;
  let cardCount = 0;
  for (const ns of Object.values(nodes)) {
    const c = ns?.fsrsCard;
    if (!c || c.reps < 3) continue;
    totalReps += c.reps;
    totalLapses += c.lapses;
    cardCount += 1;
  }
  if (cardCount === 0 || totalReps < 6) return null;
  const lapseRate = totalLapses / totalReps;
  return {
    dimension: "forgettingSlope",
    value: clamp01(lapseRate / 0.5),
    confidence: confidenceFromSamples(totalReps, 60),
    samples: totalReps,
    evidence: {
      method: "fsrs_lapse_rate",
      details: `${totalLapses}/${totalReps} reviews ended in 'again'.`,
    },
  };
}

function deriveDecodingEfficiency(nodes, fluencyMap) {
  const decodingPrefixes = ["CVC_", "BL_", "DG_", "TG_", "SE_", "VT_", "RC_", "LS_"];
  const ids = Object.keys(nodes).filter((id) =>
    decodingPrefixes.some((p) => id.startsWith(p)),
  );
  if (ids.length === 0) return null;
  let masteredCount = 0;
  let accSum = 0;
  let attemptSum = 0;
  for (const id of ids) {
    const ns = nodes[id];
    if (!ns) continue;
    if (MASTERED_STATES.has(ns.status)) masteredCount += 1;
    const acc = ns.rollingAccuracy ?? 0;
    const att =
      typeof ns.attempts === "number"
        ? ns.attempts
        : attemptsArray(ns).length;
    accSum += acc * att;
    attemptSum += att;
  }
  if (attemptSum < 8) return null;
  const meanAccuracy = accSum / attemptSum;
  let coldWcpm = 0;
  let coldAttempts = 0;
  for (const f of Object.values(fluencyMap || {})) {
    if (!f) continue;
    coldWcpm = Math.max(coldWcpm, f.coldWcpm || 0);
    coldAttempts += (f.history || []).filter((h) => h.isCold).length;
  }
  const wcpmComponent = clamp01(coldWcpm / 60);
  const masteryComponent = clamp01(masteredCount / 12);
  const value = clamp01(
    0.4 * meanAccuracy + 0.3 * masteryComponent + 0.3 * wcpmComponent,
  );
  return {
    dimension: "decodingEfficiency",
    value,
    confidence: confidenceFromSamples(attemptSum + coldAttempts * 5, 120),
    samples: attemptSum + coldAttempts,
    evidence: {
      method: "decoding_composite_v1",
      details: `${masteredCount} mastered decoding nodes; mean accuracy ${(meanAccuracy * 100).toFixed(0)}%; best cold WCPM ${Math.round(coldWcpm)}.`,
    },
  };
}

function deriveInterventionResponsiveness(nodes) {
  let lapsedCards = 0;
  let recoveries = 0;
  for (const ns of Object.values(nodes)) {
    const c = ns?.fsrsCard;
    if (!c || c.lapses === 0) continue;
    lapsedCards += 1;
    if (c.stability >= 5) recoveries += 1;
  }
  if (lapsedCards < 2) return null;
  return {
    dimension: "interventionResponsiveness",
    value: clamp01(recoveries / lapsedCards),
    confidence: Math.min(0.5, confidenceFromSamples(lapsedCards, 8)),
    samples: lapsedCards,
    evidence: {
      method: "lapse_recovery_v1_heuristic",
      details: `${recoveries}/${lapsedCards} lapsed cards have current FSRS stability ≥ 5 days. Pre-pilot heuristic — superseded by M11 intervention tagging.`,
    },
  };
}

function deriveMasteryVelocity(nodes) {
  const dayKeys = new Set();
  let masteredNodes = 0;
  for (const ns of Object.values(nodes)) {
    for (const a of attemptsArray(ns)) {
      if (!Number.isFinite(a?.ts)) continue;
      const d = new Date(a.ts);
      dayKeys.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`);
    }
    if (ns?.status && MASTERED_STATES.has(ns.status)) masteredNodes += 1;
  }
  const sessions = dayKeys.size;
  if (sessions < 2) return null;
  const newMasteryPerSession = masteredNodes / sessions;
  return {
    dimension: "masteryVelocity",
    value: clamp01(newMasteryPerSession / 0.5),
    confidence: confidenceFromSamples(totalAttempts(nodes), 150),
    samples: totalAttempts(nodes),
    evidence: {
      method: "mastery_per_session_smoothed",
      details: `${masteredNodes} mastered across ${sessions} active days → ${newMasteryPerSession.toFixed(2)} per session.`,
    },
  };
}

// ---- handler ----

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-VPA-Contract-Version", CONTRACT_VERSION);
  res.setHeader("X-Cognitive-Profile-Version", SCHEMA_VERSION);
  res.setHeader("Cache-Control", "no-cache");
  if (req.method === "OPTIONS") return res.status(204).end();

  const studentId = req.query.student;
  if (!studentId) return res.status(400).json({ error: "missing ?student=<id>" });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "supabase env not configured" });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    const { data: app } = await supabase
      .from("learning_apps")
      .select("id")
      .eq("slug", APP_SLUG)
      .maybeSingle();
    if (!app?.id) {
      return res.status(200).json({
        studentId,
        appId: APP_SLUG,
        schemaVersion: SCHEMA_VERSION,
        computedAt: new Date().toISOString(),
        contributions: [],
        _notProvisioned: true,
      });
    }

    const { data: account } = await supabase
      .from("student_app_accounts")
      .select("state")
      .eq("student_id", studentId)
      .eq("app_id", app.id)
      .maybeSingle();

    const state = account?.state || {};
    const nodes = nodeMap(state);
    const fluencyMap = state?.modelV2?.fluency || {};

    const candidates = [
      deriveAutomaticity(nodes),
      deriveWorkingPace(nodes),
      derivePersistence(nodes),
      deriveForgettingSlope(nodes),
      deriveDecodingEfficiency(nodes, fluencyMap),
      deriveInterventionResponsiveness(nodes),
      deriveMasteryVelocity(nodes),
    ].filter((c) => c && c.confidence >= 0.05);

    return res.status(200).json({
      studentId,
      appId: APP_SLUG,
      schemaVersion: SCHEMA_VERSION,
      computedAt: new Date().toISOString(),
      contributions: candidates,
    });
  } catch (err) {
    return res.status(500).json({
      error: "cognitive contribution failed",
      details: err.message,
    });
  }
}
