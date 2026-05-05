// ============================================================
// READING ACADEMY — /api/snapshot
//
// Reads the student's Reading Academy state (a JSON blob persisted
// at student_app_accounts.state by the SPA) and computes the same
// snapshot contract the dashboard's other adapters speak:
//
//   GET /api/snapshot?student=<vpa-student-uuid>
//   →  {
//        studentId, date,
//        todayXp, weekXp, dailyGoalXp,
//        nextDrill: { label, path }
//      }
//
// Skill-node metadata (xpPerItem, xpOnMastery, prereqs, topic) is
// bundled with the function via a static import so we don't have to
// teach the schema about Reading Academy's curriculum.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import skillNodes from "../src/data/skill_nodes.json" with { type: "json" };

const APP_SLUG = "reading_academy";
const DAILY_TARGET = 30; // mirrors XP_DAILY_TARGET in masteryEngine.js
const DAY_MS = 24 * 60 * 60 * 1000;

function denverDateISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function startOfDayMs(daysAgo = 0) {
  const today = denverDateISO();
  const [y, m, d] = today.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 6, 0, 0) - daysAgo * DAY_MS;
}

// XP earned by this student inside `windowMs..now`. Mirrors
// getDailyXp from masteryEngine.js but operates over an arbitrary
// window so we can compute today and 7-day in one pass.
function xpEarnedSince(state, sinceMs) {
  let xp = 0;
  for (const def of skillNodes) {
    const ns = state?.nodes?.[def.id];
    if (!ns) continue;
    const xpPerItem = def.xpPerItem ?? 1;
    const xpOnMastery = def.xpOnMastery ?? 0;
    for (const a of ns.attempts || []) {
      if ((a.ts ?? 0) >= sinceMs && a.correct) xp += xpPerItem;
    }
    if (ns.masteredAt && ns.masteredAt >= sinceMs) xp += xpOnMastery;
  }
  return xp;
}

// "Up next" pointer — the node that the SPA's selectActiveNode would
// pick. We resolve it cheaply here (priority: practicing > active >
// unlocked-in-graph-order).
function selectActiveNodeId(state) {
  const order = skillNodes.map((n) => n.id);
  const find = (status) => order.find((id) => state?.nodes?.[id]?.status === status);
  return find("practicing") || find("active") || find("unlocked") || null;
}

function buildNextDrill(state, baseUrl) {
  const id = selectActiveNodeId(state);
  if (!id) {
    return { label: "All caught up — new skills unlock as you grow", path: "/" };
  }
  const def = skillNodes.find((n) => n.id === id);
  return {
    label: def?.topic || def?.skill || "Continue Reading Academy",
    path: "/", // SPA opens to the active node automatically
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const studentId = req.query.student;
  if (!studentId) {
    return res.status(400).json({ error: "missing ?student=<id>" });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Resolve the reading_academy app id, then load the per-student
    // state row.
    const { data: app, error: appErr } = await supabase
      .from("learning_apps")
      .select("id")
      .eq("slug", APP_SLUG)
      .maybeSingle();
    if (appErr) throw appErr;

    if (!app?.id) {
      // Schema doesn't have a reading_academy row yet — render-friendly
      // empty state so the dashboard doesn't error.
      return res.status(200).json({
        studentId,
        date: denverDateISO(),
        todayXp: 0,
        weekXp: 0,
        dailyGoalXp: DAILY_TARGET,
        nextDrill: { label: "Reading Academy not yet provisioned", path: "/" },
        _notProvisioned: true,
      });
    }

    const { data: account, error: accErr } = await supabase
      .from("student_app_accounts")
      .select("state")
      .eq("student_id", studentId)
      .eq("app_id", app.id)
      .maybeSingle();
    if (accErr) throw accErr;

    const state = account?.state || { nodes: {} };

    const todayMs = startOfDayMs(0);
    const weekMs = startOfDayMs(6); // 7-day window inclusive of today

    return res.status(200).json({
      studentId,
      date: denverDateISO(),
      todayXp: xpEarnedSince(state, todayMs),
      weekXp:  xpEarnedSince(state, weekMs),
      dailyGoalXp: DAILY_TARGET,
      nextDrill: buildNextDrill(state),
    });
  } catch (err) {
    return res.status(500).json({
      error: "snapshot fetch failed",
      details: err.message,
    });
  }
}

// Exported for unit testing.
export const __test__ = { xpEarnedSince, selectActiveNodeId, buildNextDrill, DAILY_TARGET };
