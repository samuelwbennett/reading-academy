// =============================================================
// READING ACADEMY — /api/insight-recommendation
//
// Takes one rule-engine insight and asks Claude for a 1-2 sentence
// teacher-facing recommendation in plain language. POST so the full
// insight payload (with evidence) travels in the body.
//
// Body:  { insight: { id, rule, severity, headline, detail, nodeId?, evidence } }
// Reply: { recommendation: string, llmUsed: boolean }
//
// Falls back to a deterministic per-rule recommendation when
// ANTHROPIC_API_KEY is not set.
// =============================================================

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 200;

const FALLBACK = {
  stalled:
    "Spend a 5-minute teacher-led mini-lesson on this skill before the next session. The child likely needs explicit modeling on a specific item type.",
  latency_drift:
    "Pull the child back to a slower-paced practice on this skill. The drift suggests the strategy isn't yet automatic — repetition with shorter sets restores fluency.",
  cold_read_regression:
    "Re-read a recent practiced passage at this gate before the next cold read. The drop is likely word-level — a confidence reset usually fixes it.",
  forgetting_cluster:
    "Run a quick review block at the start of the next session to refresh these mastered skills before introducing anything new.",
  ready_to_advance:
    "Promote the child to the next skill in the sequence. Their accuracy and fluency on this one are at the threshold.",
  diagnostic_gap:
    "Run the placement walk before the next session — without it the engine is choosing skills blind.",
};

function fallbackRec(rule) {
  return FALLBACK[rule] || "Review the supporting data with the teacher to decide on next steps.";
}

async function callClaude(insight) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const prompt = `You're a literacy coach reading a single rule-engine insight about a K-2 student. Write a 1-2 sentence specific, actionable recommendation a classroom teacher could do tomorrow morning. Plain language. No jargon. Don't restate the insight.

Insight:
- rule: ${insight.rule}
- severity: ${insight.severity}
- headline: ${insight.headline}
- detail: ${insight.detail}
- node: ${insight.nodeId || "n/a"}
- evidence: ${JSON.stringify(insight.evidence ?? {})}

Recommendation:`;

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
      console.warn("[insight-rec] anthropic non-200:", res.status, text);
      return null;
    }
    const json = await res.json();
    const text = json?.content?.[0]?.text;
    return typeof text === "string" ? text.trim() : null;
  } catch (err) {
    console.warn("[insight-rec] anthropic call threw:", err);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let insight;
  try {
    insight = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    insight = insight?.insight || insight;
  } catch {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  if (!insight || !insight.rule) {
    return res.status(400).json({ error: "missing insight.rule" });
  }

  const llm = await callClaude(insight);
  return res.status(200).json({
    recommendation: llm || fallbackRec(insight.rule),
    llmUsed: !!llm,
  });
}
