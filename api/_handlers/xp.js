// =============================================================
// READING ACADEMY — /api/xp
//
// Implements the v1.0 VPA Orchestration Contract's /api/xp.
// Returns Reading Academy's XP across multiple time windows for
// the given student so the launcher can roll up unified totals.
//
// XP comes from two sources:
//   - per-attempt XP (xpPerItem on each correct answer)
//   - per-mastery XP (xpOnMastery when a node first transitions)
//
// Both are encoded in skill_nodes.json. We compute by walking the
// student's persisted state and the appended skill_attempts table.
// =============================================================

import { createClient } from "@supabase/supabase-js";
import skillNodes from "../../src/data/skill_nodes.json" with { type: "json" };

const APP_SLUG = "reading_academy";
const CONTRACT_VERSION = "1.0";
const TZ = "America/Denver";
const DAY_MS = 24 * 60 * 60 * 1000;

function localDateStartUtc(daysAgo = 0, tz = TZ) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  // Anchor at 06:00 UTC ≈ midnight Denver (avoids DST jitter for our
  // pilot windows; matches the snapshot endpoint's convention).
  return Date.UTC(y, m - 1, d, 6, 0, 0) - daysAgo * DAY_MS;
}

const xpPerItemById = new Map(
  skillNodes.map((n) => [n.id, n.xpPerItem ?? 1]),
);
const xpOnMasteryById = new Map(
  skillNodes.map((n) => [n.id, n.xpOnMastery ?? 0]),
);

/**
 * Sum XP for the student inside [sinceMs, untilMs).
 *
 * Two signals:
 *   - The persisted state's per-node attempts (legacy + modelV2)
 *     contribute xpPerItem per correct attempt with ts in window.
 *   - The mastery_snapshots table's transitions to a "mastered"
 *     family contribute xpOnMastery if transitioned_at is in window.
 */
function xpFromState(state, sinceMs, untilMs) {
  let xp = 0;
  const legacy = state?.nodes || {};
  const m3 = state?.modelV2?.nodes || {};
  const all = { ...legacy };
  // modelV2 wins on overlap.
  for (const k of Object.keys(m3)) all[k] = m3[k];

  for (const [id, ns] of Object.entries(all)) {
    if (!ns) continue;
    const xpPer = xpPerItemById.get(id) ?? 1;
    const xpMast = xpOnMasteryById.get(id) ?? 0;

    // Legacy attempts shape: array on `attempts`. M3 shape: array on `history`.
    const attempts = Array.isArray(ns.attempts)
      ? ns.attempts
      : Array.isArray(ns.history)
      ? ns.history
      : [];

    for (const a of attempts) {
      if (!a?.correct) continue;
      const ts = a.ts ?? 0;
      if (ts >= sinceMs && ts < untilMs) xp += xpPer;
    }

    if (ns.lastMasteredAt && ns.lastMasteredAt >= sinceMs && ns.lastMasteredAt < untilMs) {
      xp += xpMast;
    } else if (ns.masteredAt && ns.masteredAt >= sinceMs && ns.masteredAt < untilMs) {
      xp += xpMast;
    }
  }
  return xp;
}

function lastEarnedAt(state) {
  let latest = 0;
  const legacy = state?.nodes || {};
  const m3 = state?.modelV2?.nodes || {};
  const all = { ...legacy };
  for (const k of Object.keys(m3)) all[k] = m3[k];
  for (const ns of Object.values(all)) {
    if (!ns) continue;
    const attempts = Array.isArray(ns.attempts)
      ? ns.attempts
      : Array.isArray(ns.history)
      ? ns.history
      : [];
    for (const a of attempts) {
      if (a?.correct && (a.ts ?? 0) > latest) latest = a.ts;
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-VPA-Contract-Version", CONTRACT_VERSION);
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
        today: 0, yesterday: 0, thisWeek: 0, lastWeek: 0,
        thisMonth: 0, allTime: 0, lastEarnedAt: null,
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

    const startToday = localDateStartUtc(0);
    const startYesterday = localDateStartUtc(1);
    const startThisWeek = localDateStartUtc(6);
    const startLastWeek = localDateStartUtc(13);
    const startThisMonth = localDateStartUtc(29);
    const now = Date.now() + DAY_MS; // generous upper bound

    return res.status(200).json({
      studentId,
      appId: APP_SLUG,
      today: xpFromState(state, startToday, now),
      yesterday: xpFromState(state, startYesterday, startToday),
      thisWeek: xpFromState(state, startThisWeek, now),
      lastWeek: xpFromState(state, startLastWeek, startThisWeek),
      thisMonth: xpFromState(state, startThisMonth, now),
      allTime: xpFromState(state, 0, now),
      lastEarnedAt: lastEarnedAt(state),
    });
  } catch (err) {
    return res.status(500).json({ error: "xp fetch failed", details: err.message });
  }
}
