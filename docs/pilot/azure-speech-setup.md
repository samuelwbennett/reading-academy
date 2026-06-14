# Reading Academy — Azure Speech Setup

Version 1.0 · 2026-05-08
Audience: pilot engineer / admin
Scope: M15 — Azure ASR upgrade

This is the operational guide to enable Azure Speech for Reading Academy. The deterministic Web Speech baseline keeps working without these steps — Azure is the upgrade engine, not load-bearing.

---

## What changes when Azure is on

| | Web Speech (default) | Azure Speech (when configured) |
|---|---|---|
| Engine | Browser-native (Chrome/Safari/Edge) | Cloud — Microsoft Speech Service |
| Phoneme distinction | Weak — /s/ vs /sh/ often collapses | Strong — phoneme-level scoring |
| Pronunciation accuracy score | None | 0–100 per word + per phoneme |
| Words / phonemes detail | Single transcript | Per-word + per-phoneme breakdowns |
| Cost per drill (~5 min audio) | Free | ~$0.08 |
| Works offline | No | No (cloud-dependent) |
| Latency | ~250 ms | ~600 ms |
| Browser bundle cost | 0 KB | ~500 KB SDK loaded from Microsoft CDN on first use |

Reading Academy automatically picks Azure when configured, falls back to Web Speech otherwise.

---

## Provisioning (10 min, one-time)

1. Sign in to https://portal.azure.com (a free trial account works for pilot scale)
2. Click **Create a resource** → search for **Speech** → **Speech (Cognitive Services)**
3. Fill in:
   - **Subscription**: your Azure subscription
   - **Resource group**: create a new one named e.g. `vpa-reading-academy`
   - **Region**: pick one geographically close to your pilot users — `East US` works for North America, `West Europe` for EU. The region is locked in; make a note of the lowercase identifier (e.g. `eastus`, `westus2`).
   - **Name**: e.g. `vpa-reading-academy-speech`
   - **Pricing tier**: **Standard S0** for production, **Free F0** for prototyping (limited to 5 hours/month)
4. Click **Review + create** → **Create**
5. Once deployed, click **Go to resource** → **Keys and Endpoint**
6. Copy **KEY 1** and the **Location/Region** value (lowercase, no spaces — e.g. `eastus`)

---

## Set the env vars (3 min)

```bash
cd /Users/samuelbennett/Desktop/reading-academy
npx vercel env add AZURE_SPEECH_KEY production
# paste KEY 1 — mark Sensitive: yes
npx vercel env add AZURE_SPEECH_REGION production
# paste e.g. eastus — Sensitive: no (region is not secret)
npx vercel env add AZURE_SPEECH_KEY preview
npx vercel env add AZURE_SPEECH_REGION preview
npx vercel --prod   # redeploy so /api/azure-speech-token picks up the env
```

For local dev, add the same two vars to `.env.local`.

---

## Smoke test

1. Open `https://reading-academy.vercel.app/api/azure-speech-token` in a browser. Expected:
   ```json
   { "token": "eyJ0eX...", "region": "eastus", "expiresInSeconds": 540 }
   ```
   If you get `{ "error": "azure_speech_unconfigured" }` the env vars haven't propagated — redeploy.
2. Open `/reading/drill` and start a drill on any read-aloud node. Open devtools → Network. The first attempt should:
   - Fetch `/api/azure-speech-token` (returns the token JSON)
   - Load `https://aka.ms/csspeech/jsbrowserpackage` (the SDK, ~500 KB, cached)
   - Open a WebSocket to `wss://<region>.stt.speech.microsoft.com/...` and stream audio
3. The drill feedback row should now read **engine: azure**. Subsequent attempts skip the token + SDK fetches.

---

## Cost monitoring

Azure Speech is billed per audio second. Pricing as of writing:

| Usage | Cost |
|---|---|
| Standard real-time recognition | ~$1.00 per audio hour |
| Pronunciation Assessment | ~$0.30 per audio hour added on top |
| **Effective drill cost** | ~$1.30 / hour, or **$0.022 / minute** |

A typical 10-minute drill session spends ~5 minutes actively recording (the rest is feedback hold + transitions) → ~$0.11 per session.

For a 30-student pilot doing one daily session each: ~30 sessions × $0.11 = **$3.30 per pilot-day**, or **~$66 per pilot-month** at full daily use.

Set a budget alert in Azure Portal → **Cost Management** → **Budgets** to catch surprise spikes. A $50/month alert is a sensible pilot guardrail.

---

## Privacy

Azure Speech stores audio fragments transiently for the recognition request only. Microsoft's [Speech service privacy](https://learn.microsoft.com/azure/cognitive-services/speech-service/speech-encryption-of-data-at-rest) covers the data handling specifics. Per the M10-K LLM-boundary rule applied to ASR:

- We never send PII alongside audio. Only the `referenceText` (the expected word like "fish") goes with the audio.
- The SPA holds only short-lived issuer tokens (10-min lifetime); the long-lived account key stays on Vercel functions.
- Falling back to Web Speech is automatic — no audio leaves the device when Azure is unavailable.

If your pilot's DPA requires audio data residency, set the Azure region to your contractual zone. Audio for a `westeurope` Speech resource never leaves the EU.

---

## Disable temporarily

Either:
1. Delete the env vars: `npx vercel env rm AZURE_SPEECH_KEY production` → redeploy. The SPA falls back to Web Speech automatically.
2. Or set `AZURE_SPEECH_KEY` to the literal string `disabled` — the token endpoint detects an invalid key and returns 502; the SPA falls back.

Either way, no code change is needed and active drill sessions continue working through the fallback path.

---

## Failure modes & how to spot them

| Symptom | Cause | Fix |
|---|---|---|
| Drill always shows engine: web even after env set | Vercel didn't redeploy | `npx vercel --prod` after env add |
| `/api/azure-speech-token` returns 503 | Env vars missing | Re-add via `vercel env add` then redeploy |
| `/api/azure-speech-token` returns 502 | Wrong key or region | Re-copy KEY 1; check region spelling matches the Azure resource exactly |
| SDK load fails (devtools: blocked CDN) | School firewall blocks aka.ms | Self-host the SDK from `/public/` instead — see "Air-gapped deploy" in the runbook |
| Recognition returns "no-speech" repeatedly | Mic permission not granted | Check Safari/Chrome mic permissions; mic indicator should appear |
| Cost spike beyond budget | Long sessions or open-mic loops | Confirm `recognizeOnceAsync` is the only call site (no continuous mode) |

---

## What this enables

After Azure is on, the most-overridden surface in the app — kids on iPads where the teacher has to tap "Correct" because Web Speech mis-heard — should drop in override frequency by an order of magnitude. The pronunciation accuracy score also feeds into M11's intervention insights more reliably; "latency drift" + "low pronunciation accuracy" is a stronger signal than transcript matching alone.

---

## Change log

- v1.0 (2026-05-08): Initial runbook. Token endpoint + browser SDK + fallback path.
