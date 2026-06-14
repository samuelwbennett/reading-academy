// =============================================================
// READING ACADEMY — /api/recap
//
// Generates a 100-200 word weekly summary of one student's progress
// using Anthropic Claude. The natural-language output is what a
// teacher or parent reads at the end of the week.
//
// Inputs:
//   GET /api/recap?student=<vpa-student-uuid>&days=7
//
// Output:
//   {
//     studentId, days,
//     stats: { attempts, correctRate, masteredCount, fluencyTopWcpm },
//     recap: "...narrative summary...",
//     generatedAt
//   }
//
// Env vars required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  → fetch telemetry
//   ANTHROPIC_API_KEY                         → Claude completions
//
// If ANTHROPIC_API_KEY is missing, falls back to a deterministic
// template so the endpoint never 500s during pilot setup.
// =============================================================

import { createClient } from "@supabase/supabase-js";
import skillNodes from "../../src/data/skill_nodes.json" with { type: "json" };

const APP_SLUG = "reading_academy";
const DEFAULT_DAYS = 7;
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 400;

function isoMinus(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function nodeLabel(nodeId) {
  const def = skillNodes.find((n) => n.id === nodeId);
  return def?.topic || def?.skill || nodeId;
}

function summarizeStats({ attempts, passages, mastery }) {
  const total = attempts.length;
  const correct = attempts.filter((a) => a.correct).length;
  const correctRate = total > 0 ? correct / total : 0;
  const nodeCounts = {};
  for (const a of attempts) {
    nodeCounts[a.node_id] = (nodeCounts[a.node_id] || 0) + 1;
  }
  const topNodes = Object.entries(nodeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, n]) => ({ id, label: nodeLabel(id), attempts: n }));
  const masteredThisWeek = mastery
    .filter((m) => m.reason === "acquisition")
    .map((m) => ({ id: m.node_id, label: nodeLabel(m.node_id) }));
  const coldRuns = passages.filter((p) => p.is_cold);
  const fluencyTopWcpm = coldRuns.length
    ? Math.max(...coldRuns.map((p) => p.wcpm || 0))
    : 0;
  return {
    attempts: total,
    correctRate,
    topNodes,
    masteredThisWeek,
    fluencyTopWcpm,
    coldReadCount: coldRuns.length,
    practicedReadCount: passages.length - coldRuns.length,
  };
}

function fallbackRecap(stats) {
  const parts = [];
  if (stats.attempts === 0) {
    return "No practice this week — encourage a short daily session to keep the streak going.";
  }
  parts.push(
    `Logged ${stats.attempts} attempts at ${(stats.correctRate * 100).toFixed(0)}% correct.`,
  );
  if (stats.masteredThisWeek.length) {
    parts.push(
      `Newly mastered: ${stats.masteredThisWeek.map((m) => m.label).join(", ")}.`,
    );
  }
  if (stats.topNodes.length) {
    parts.push(
      `Most practice on ${stats.topNodes[0].label} (${stats.topNodes[0].attempts} attempts).`,
    );
  }
  if (stats.fluencyTopWcpm > 0) {
    parts.push(
      `Best cold-read fluency this week: ${Math.round(stats.fluencyTopWcpm)} WCPM.`,
    );
  }
  return parts.join(" ");
}

async function callClaude(stats, days) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const prompt = `You write short weekly progress recaps for K-2 reading practice.
Tone: warm, specific, parent-friendly. No jargon. 100-180 words. Plain prose, no lists or headers.

Data for the past ${days} days:
- attempts: ${stats.attempts}
- correct rate: ${(stats.correctRate * 100).toFixed(0)}%
- newly mastered skills: ${
    stats.masteredThisWeek.length
      ? stats.masteredThisWeek.map((m) => m.label).join(", ")
      : "none"
  }
- top 3 skills practiced: ${
    stats.topNodes
      .map((n) => `${n.label} (${n.attempts} attempts)`)
      .join("; ") || "none"
  }
- cold-read passages completed: ${stats.coldReadCount}
- practiced passages: ${stats.practicedReadCount}
- best cold WCPM: ${stats.fluencyTopWcpm > 0 ? Math.round(stats.fluencyTopWcpm) : "n/a"}

Write the recap directly — no preamble, no "this week:" prefix.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn("[recap] anthropic non-200:", res.status, text);
      return null;
    }
    const json = await res.json();
    const text = json?.content?.[0]?.text;
    return typeof text === "string" ? text.trim() : null;
  } catch (err) {
    console.warn("[recap] anthropic call threw:", err);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const studentId = req.query.student;
  const days = Math.min(
    Math.max(Number(req.query.days) || DEFAULT_DAYS, 1),
    30,
  );
  if (!studentId) {
    return res.status(400).json({ error: "missing ?student=<id>" });
  }
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
      return res
        .status(200)
        .json({ studentId, days, stats: null, recap: "Not provisioned yet." });
    }

    const since = isoMinus(days);

    const [{ data: attempts = [] }, { data: passages = [] }, { data: mastery = [] }] =
      await Promise.all([
        supabase
          .from("reading_skill_attempts")
          .select("node_id, correct, latency_ms, server_ts")
          .eq("student_id", studentId)
          .eq("app_id", app.id)
          .gte("server_ts", since)
          .order("server_ts", { ascending: true }),
        supabase
          .from("reading_passage_attempts")
          .select("passage_id, gate_id, is_cold, wcpm, accuracy, server_ts")
          .eq("student_id", studentId)
          .eq("app_id", app.id)
          .gte("server_ts", since),
        supabase
          .from("reading_mastery_snapshots")
          .select("node_id, from_status, to_status, reason, transitioned_at")
          .eq("student_id", studentId)
          .eq("app_id", app.id)
          .gte("transitioned_at", since),
      ]);

    const stats = summarizeStats({ attempts, passages, mastery });
    const llm = await callClaude(stats, days);
    const recap = llm || fallbackRecap(stats);

    return res.status(200).json({
      studentId,
      days,
      stats: {
        attempts: stats.attempts,
        correctRate: Number(stats.correctRate.toFixed(3)),
        masteredCount: stats.masteredThisWeek.length,
        topNodes: stats.topNodes,
        fluencyTopWcpm: stats.fluencyTopWcpm,
        coldReadCount: stats.coldReadCount,
      },
      recap,
      llmUsed: !!llm,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      error: "recap generation failed",
      details: err.message,
    });
  }
}
