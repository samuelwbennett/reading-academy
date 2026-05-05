// ============================================================
// READING ACADEMY — /api/mastery
//
// Per-strand mastery rollup for the orchestration dashboard's Skill
// Garden (and any future cross-app mastery view). Walks the bundled
// skill_nodes.json and counts mastered/unlocked/locked per strand
// from the student's persisted state.
//
//   GET /api/mastery?student=<vpa-student-uuid>
//   →  {
//        studentId,
//        strands: [
//          { id, label, symbol, mastered, attempted, total, avgScore }
//        ]
//      }
//
// "Strand" here is the `strand` field on each skill node
// (Phonemic Awareness, CVC, Digraph, Fluency, etc.). Symbols are a
// human label-friendly compact icon.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import skillNodes from "../src/data/skill_nodes.json" with { type: "json" };

const APP_SLUG = "reading_academy";

// Tiny lookup of friendly icons per strand. Anything not listed
// falls back to "•".
const STRAND_SYMBOL = {
  "Phonemic Awareness": "🔊",
  "CVC":                "Aa",
  "Digraph":            "sh",
  "Fluency":            "→",
  "Sight Word":         "the",
  "Vocabulary":         "📖",
};

function bucketByStrand(state) {
  const buckets = new Map();
  for (const def of skillNodes) {
    const strand = def.strand || "Other";
    if (!buckets.has(strand)) {
      buckets.set(strand, { total: 0, mastered: 0, attempted: 0 });
    }
    const b = buckets.get(strand);
    b.total += 1;

    const ns = state?.nodes?.[def.id];
    const status = ns?.status || "locked";
    const attempts = (ns?.attempts || []).length;

    if (status === "mastered") b.mastered += 1;
    if (attempts > 0 || status === "active" || status === "practicing") {
      b.attempted += 1;
    }
  }

  return Array.from(buckets.entries()).map(([strand, b]) => ({
    id: strand.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    label: strand,
    symbol: STRAND_SYMBOL[strand] || "•",
    mastered: b.mastered,
    attempted: b.attempted,
    total: b.total,
    avgScore: b.total > 0 ? Number((b.mastered / b.total).toFixed(3)) : 0,
  }));
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

    const { data: app, error: appErr } = await supabase
      .from("learning_apps")
      .select("id")
      .eq("slug", APP_SLUG)
      .maybeSingle();
    if (appErr) throw appErr;

    if (!app?.id) {
      return res.status(200).json({
        studentId,
        strands: [],
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

    return res.status(200).json({
      studentId,
      strands: bucketByStrand(state),
    });
  } catch (err) {
    return res.status(500).json({
      error: "mastery fetch failed",
      details: err.message,
    });
  }
}

export const __test__ = { bucketByStrand, STRAND_SYMBOL };
