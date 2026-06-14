// =============================================================
// READING ACADEMY — /api/action-narration
//
// Polishes a list of teacher actions into one short paragraph the
// teacher can read in 10 seconds. The LLM is sweetener; the
// deterministic fallback below is the contract.
//
// Per docs/architecture/llm-boundary.md:
//   - LLM may not be load-bearing
//   - llmUsed flag is honest
//   - no PII / transcripts in the payload
//
// Body:  { actions: Action[], context?: { dateLabel, classSize } }
// Reply: { paragraph, llmUsed: boolean }
// =============================================================

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 350;

function deterministic(actions, context = {}) {
  if (!actions || actions.length === 0) {
    return "No actions queued — keep practicing.";
  }
  const today = actions.filter((a) => a.urgency === "today");
  const week = actions.filter((a) => a.urgency === "this_week");
  const minutesToday = today.reduce((s, a) => s + (a.durationMinutes || 0), 0);
  const dayLabel = context.dateLabel ? ` for ${context.dateLabel}` : "";
  const parts = [];
  if (today.length) {
    parts.push(
      `${today.length} action${today.length === 1 ? "" : "s"} need attention${dayLabel} (about ${minutesToday} min focused teacher time).`,
    );
    const top = today.slice(0, 3).map((a) => a.headline).join("; ");
    if (top) parts.push(`Top: ${top}.`);
  } else {
    parts.push(`No urgent actions${dayLabel}.`);
  }
  if (week.length) {
    parts.push(`${week.length} more queued for this week.`);
  }
  return parts.join(" ");
}

async function callClaude(actions, context) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const compact = actions.slice(0, 12).map((a) => ({
    headline: a.headline,
    detail: a.detail,
    urgency: a.urgency,
    kind: a.kind,
    durationMinutes: a.durationMinutes,
    student: a.studentDisplayName || null,
  }));
  const prompt = `You're a literacy coach. Read the action list below and write a single short paragraph (60-110 words) a classroom teacher could glance at this morning. Cover what to do today, who needs the most attention, and total focused minutes. Plain language, no bullet points, no lists, no headers. Don't restate the actions verbatim — distill.

Date context: ${context?.dateLabel || "today"}
Class size: ${context?.classSize ?? "unspecified"}

Actions (top ${compact.length}):
${JSON.stringify(compact, null, 2)}

Paragraph:`;
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
      console.warn("[action-narration] anthropic non-200:", res.status);
      return null;
    }
    const json = await res.json();
    const text = json?.content?.[0]?.text;
    return typeof text === "string" ? text.trim() : null;
  } catch (err) {
    console.warn("[action-narration] anthropic call threw:", err);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  const actions = Array.isArray(body?.actions) ? body.actions : null;
  const context = body?.context || {};
  if (!actions) return res.status(400).json({ error: "missing actions[]" });

  const llm = await callClaude(actions, context);
  return res.status(200).json({
    paragraph: llm || deterministic(actions, context),
    llmUsed: !!llm,
  });
}
