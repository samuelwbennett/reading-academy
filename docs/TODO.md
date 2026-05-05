# Reading Academy — TODO

## P0 — before pilot

- [ ] **Replace Web Speech API with Azure Pronunciation Assessment.** Current ASR (browser `SpeechRecognition`) only verifies whole-word matches. Azure's pronunciation assessment API returns per-phoneme accuracy, completeness, and fluency scores against a reference word — the actual signal we need for phonics mastery and for diagnosing which GPC a student is failing. Cost ~$0.005/attempt. Needs an Azure key + a tiny backend route (or direct browser call with key in env for prototype). Touchpoints: replace `MicButton`/`useSpeechRecognition` in `src/App.jsx`, update `recordAttempt` to store per-phoneme scores, surface phoneme-level errors in the result toast and in the Progress tab.

## P1 — soon

- [ ] Expand 5-node chain to full 54-node K–2 graph (design already in session JSON).
- [ ] Author 20+ items per node.
- [ ] Daily session orchestrator: lesson + 2 reviews + passage + fluency drill, fixed ~17 min block.
- [ ] FIRe-lite scheduler: SM-2 base + trickle-down credit on prereqs.
- [ ] Decodable passage library with GPC inventory tagging.

## P2 — later

- [ ] Teacher/parent dashboard (one screen per student, WCPM trend).
- [ ] Diagnostic adaptivity: start mid-graph, ramp up/down based on responses.
- [ ] Real backend (Postgres) instead of localStorage.
- [ ] Multi-student support.
