// ============================================================
// Daily-progress writer for Reading Academy.
//
// Reading Academy doesn't have discrete "sessions" with a known XP
// delta — XP accumulates inside state.modelV2.nodes (and the legacy
// state.nodes) as the student answers items. So we use a SET pattern:
// every time the state is saved, recompute today's RA XP from scratch
// and SET per_app.reading_academy.xp = that value.
//
// SET (not increment) is safe + idempotent for our slot. The OTHER
// per_app slots (math_facts, reading_facts) are preserved unchanged
// in the merge — we only touch our own slot. Race with concurrent
// Math Facts writes is the worst case, and even then the next call
// from either side corrects it.
//
// Mirrors math-facts-trainer-react/reading-facts-app/src/dailyProgress.js
// in shape; the difference is SET vs INCREMENT and where today's XP
// comes from.
// ============================================================

import { supabase } from "./supabase.js";
import skillNodes from "../data/skill_nodes.json";

const APP_SLUG = "reading_academy";
const DAY_MS = 24 * 60 * 60 * 1000;

function todayInDenver() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function startOfDenverDayMs() {
  const today = todayInDenver();
  const [y, m, d] = today.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 6, 0, 0);
}

// Mirror /api/xp.js's xpFromState but scoped to today's window.
// xpPerItem on each correct attempt + xpOnMastery when transitioned
// today.
function xpEarnedToday(state) {
  let xp = 0;
  const legacy = state?.nodes || {};
  const m3 = state?.modelV2?.nodes || {};
  const all = { ...legacy };
  for (const k of Object.keys(m3)) all[k] = m3[k];

  const since = startOfDenverDayMs();
  const xpPerItemById = new Map(skillNodes.map((n) => [n.id, n.xpPerItem ?? 1]));
  const xpOnMasteryById = new Map(skillNodes.map((n) => [n.id, n.xpOnMastery ?? 0]));

  for (const [id, ns] of Object.entries(all)) {
    if (!ns) continue;
    const xpPer = xpPerItemById.get(id) ?? 1;
    const xpMast = xpOnMasteryById.get(id) ?? 0;
    const attempts = Array.isArray(ns.attempts)
      ? ns.attempts
      : Array.isArray(ns.history)
      ? ns.history
      : [];
    for (const a of attempts) {
      if (a?.correct && (a.ts ?? 0) >= since) xp += xpPer;
    }
    const masteredAt = ns.lastMasteredAt ?? ns.masteredAt;
    if (masteredAt && masteredAt >= since) xp += xpMast;
  }
  return xp;
}

/**
 * Recompute today's RA XP from `state` and upsert daily_progress.
 * Only mutates per_app.reading_academy — other apps' slots are
 * preserved. total_xp is recomputed as the sum across all per_app.
 *
 * Fire-and-forget from the caller; failure is non-fatal because
 * the underlying state save already succeeded.
 */
export async function syncDailyProgress({ studentId, state }) {
  if (!studentId || !state) return;
  const xp = xpEarnedToday(state);
  // No-op when nothing has been earned today — avoids creating
  // empty rows that read-paths would then have to filter out.
  if (xp <= 0) return;

  const day = todayInDenver();

  const { data: existing, error: readErr } = await supabase
    .from("daily_progress")
    .select("total_xp, total_active_seconds, per_app")
    .eq("student_id", studentId)
    .eq("day", day)
    .maybeSingle();
  if (readErr && readErr.code !== "PGRST116") {
    console.warn("[dailyProgress] read failed:", readErr.message);
    return;
  }

  const perApp = existing?.per_app || {};
  // SET — replace our slot wholesale with the freshly-computed value.
  perApp[APP_SLUG] = {
    ...(perApp[APP_SLUG] || {}),
    xp: Math.round(xp * 10) / 10,
  };

  let total_xp = 0;
  for (const v of Object.values(perApp)) {
    total_xp += Number(v?.xp) || 0;
  }
  total_xp = Math.round(total_xp * 100) / 100;

  const { error: writeErr } = await supabase
    .from("daily_progress")
    .upsert(
      {
        student_id: studentId,
        day,
        total_xp,
        // Preserve existing total_active_seconds — RA doesn't have a
        // clean per-app active-seconds counter, so we leave it alone.
        total_active_seconds: existing?.total_active_seconds || 0,
        per_app: perApp,
      },
      { onConflict: "student_id,day" },
    );
  if (writeErr) {
    console.warn("[dailyProgress] write failed:", writeErr.message);
  }
}
