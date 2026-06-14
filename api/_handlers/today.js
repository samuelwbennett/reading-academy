// =============================================================
// READING ACADEMY — /api/today
//
// Implements the v1.0 VPA Orchestration Contract's /api/today
// endpoint. Returns Reading Academy's top recommendation for the
// given student in a launcher-friendly shape.
//
// The session planner runs client-side too; here we re-implement
// just enough of it to answer "what's the priority block right now?"
// without pulling the TS source.
//
// Reads state.modelV2 (M3 shape) when present, falls back to
// state.nodes (legacy shape) so this endpoint works for every
// vintage of student data.
// =============================================================

import { createClient } from "@supabase/supabase-js";
import skillNodes from "../../src/data/skill_nodes.json" with { type: "json" };

const APP_SLUG = "reading_academy";
const CONTRACT_VERSION = "1.0";

const MASTERED_STATES = new Set([
  "mastered",
  "mastered_for_acquisition",
  "in_automaticity_zone",
  "automatic",
]);

function isUnlocked(node, modelNodes) {
  const prereqs = node.prereqs || [];
  if (prereqs.length === 0) return true;
  return prereqs.every((p) => MASTERED_STATES.has(modelNodes[p]?.status));
}

function pickActiveNode(modelNodes) {
  const candidates = [];
  for (const def of skillNodes) {
    if (def.assessment === "cold_passage") continue;
    const ns = modelNodes[def.id];
    const status = ns?.status || "locked";
    if (
      (status === "active" ||
        status === "practicing" ||
        status === "unlocked") &&
      isUnlocked(def, modelNodes)
    ) {
      candidates.push({ def, status });
    }
  }
  candidates.sort((a, b) => {
    const rank = (s) =>
      s === "practicing" ? 0 : s === "active" ? 1 : s === "unlocked" ? 2 : 3;
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return (
      skillNodes.findIndex((n) => n.id === a.def.id) -
      skillNodes.findIndex((n) => n.id === b.def.id)
    );
  });
  return candidates[0]?.def ?? null;
}

function findReviewDue(modelNodes, now) {
  // Surface the most-overdue review node so the launcher can
  // prioritize it. Returns null if nothing is due.
  let best = null;
  for (const def of skillNodes) {
    const ns = modelNodes[def.id];
    if (!ns) continue;
    const due = ns.reviewDueAt;
    if (!due || due > now) continue;
    if (!best || due < best.due) best = { def, due };
  }
  return best;
}

function nodeLabel(def) {
  return def?.topic || def?.skill || def?.id;
}

function diagnosticIncomplete(state) {
  // True if the legacy state has zero non-locked nodes, meaning the
  // student hasn't placed yet.
  const nodes = state?.nodes || {};
  for (const k of Object.keys(nodes)) {
    if (nodes[k]?.status && nodes[k].status !== "locked") return false;
  }
  return true;
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
        recommendation: {
          kind: "none",
          headline: "Reading Academy not provisioned yet",
          subtitle: "Ask the admin to enable this app for your account.",
          estimatedMinutes: 0,
          priority: "low",
          path: "/reading",
          reason: "not_provisioned",
        },
        blocksRemaining: 0,
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
    const modelV2Nodes = state.modelV2?.nodes || {};
    const legacyNodes = state.nodes || {};

    // Merge: prefer modelV2 node entries, fall back to legacy.
    const merged = { ...legacyNodes };
    for (const k of Object.keys(modelV2Nodes)) merged[k] = modelV2Nodes[k];

    const now = Date.now();

    // Decide priority block.
    let kind = "none";
    let headline = "All caught up";
    let subtitle = "Come back tomorrow for new lessons.";
    let path = "/reading";
    let reason = "idle";
    let priority = "low";
    let estimatedMinutes = 0;
    let details = {};
    let blocksRemaining = 0;

    if (diagnosticIncomplete(state)) {
      kind = "placement";
      headline = "Run the placement check";
      subtitle = "5–8 minutes — figures out where to start.";
      path = "/reading/diagnostic";
      reason = "diagnostic_gap";
      priority = "high";
      estimatedMinutes = 7;
      blocksRemaining = 1;
    } else {
      const review = findReviewDue(merged, now);
      const active = pickActiveNode(merged);
      const otherCount = (review ? 1 : 0) + (active ? 1 : 0);

      if (review) {
        const def = review.def;
        kind = "review";
        headline = `Quick review: ${nodeLabel(def)}`;
        subtitle = "Sharpens a skill that's at risk of fading.";
        path = "/reading/drill";
        reason = "review_due";
        priority = "high";
        estimatedMinutes = 3;
        details = { nodeId: def.id, dueAt: review.due };
        blocksRemaining = otherCount;
      } else if (active) {
        kind = "drill";
        headline = `Today's lesson: ${nodeLabel(active)}`;
        subtitle = active.module || active.strand || "Active practice.";
        path = "/reading/drill";
        reason = "active_frontier";
        priority = "medium";
        estimatedMinutes = 8;
        details = { nodeId: active.id };
        blocksRemaining = otherCount;
      }
    }

    return res.status(200).json({
      studentId,
      appId: APP_SLUG,
      recommendation: {
        kind,
        headline,
        subtitle,
        estimatedMinutes,
        priority,
        path,
        reason,
        details,
      },
      blocksRemaining,
    });
  } catch (err) {
    return res.status(500).json({ error: "today fetch failed", details: err.message });
  }
}
