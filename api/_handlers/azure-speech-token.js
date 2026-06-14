// =============================================================
// READING ACADEMY — /api/azure-speech-token (M15-A)
//
// Mints a short-lived Azure Speech issuer token from the long-lived
// AZURE_SPEECH_KEY. Browsers use the token (lifetime 10 min) to
// authenticate Speech SDK calls without ever seeing the long-lived
// key. Per Azure best practice for browser apps.
//
// Env vars (server-only):
//   AZURE_SPEECH_KEY     — long-lived account key, NEVER ship to client
//   AZURE_SPEECH_REGION  — e.g. "eastus", "westus2", "centralus"
//
// Without those vars, returns 503 — the SPA's recognition layer
// then falls back to Web Speech API per the M15-C engine-selection
// logic. Calls to the deprecated long-lived-key path are not
// supported here by design.
//
// Reply:
//   { token: "<jwt-ish>", region: "eastus", expiresInSeconds: 540 }
// =============================================================

const CONTRACT_VERSION = "1.0";
const TOKEN_TTL_SECONDS = 540; // Azure tokens last 10 min; advertise 9 to leave drift slack.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("X-VPA-Contract-Version", CONTRACT_VERSION);
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();

  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    return res.status(503).json({
      error: "azure_speech_unconfigured",
      hint: "set AZURE_SPEECH_KEY + AZURE_SPEECH_REGION in Vercel; SPA falls back to Web Speech",
    });
  }

  try {
    const url = `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
    // Node's native fetch (undici) treats Content-Length as a
    // forbidden header — setting it manually throws a TypeError that
    // escapes our try/catch and produces FUNCTION_INVOCATION_FAILED.
    // An empty-string body triggers Content-Length: 0 automatically,
    // which is what Azure's STS expects.
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.warn("[azure-speech-token] non-200", r.status, text);
      return res.status(502).json({
        error: "azure_token_issue_failed",
        status: r.status,
        details: text.slice(0, 300),
      });
    }
    const token = await r.text();
    return res.status(200).json({
      token,
      region,
      expiresInSeconds: TOKEN_TTL_SECONDS,
    });
  } catch (err) {
    console.warn("[azure-speech-token] threw", err);
    return res.status(500).json({
      error: "azure_speech_token_threw",
      details: err?.message || String(err),
    });
  }
}
