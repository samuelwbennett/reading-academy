# Reading Academy — Pilot Readiness Checklist

Version 1.0 · 2026-05-07
Owner: Agent #7 — Chief Integration
Status: drafting through M4. All items must be ✅ before a real classroom touches the app.

This is the gating checklist between "engineering build" and "pilot
deploy with real K–2 learners." It is not a roadmap. It is the
acceptance test.

---

## 1. Auth & identity

- [ ] **Supabase Auth** wired to the app. Email-link or SSO; no passwords on student devices.
- [ ] **Role model** in `users.role`: `student` / `teacher` / `parent` / `admin`.
- [ ] **Student-without-auth** flow: a teacher can mint a student row + magic-link/QR for first sign-in without the student typing an email.
- [ ] **Session persistence** survives a tab refresh and a device swap.
- [ ] **Sign-out** clears: telemetry queue is flushed (or held with a retry token), student model is wiped from `localStorage`.
- [ ] **Account creation is teacher-mediated.** Reading Academy never auto-creates a student row from a learner click.

## 2. Data privacy & FERPA

- [ ] **Privacy policy** drafted, school-board-reviewable, posted at `/legal/privacy`.
- [ ] **Data processing agreement (DPA)** template ready for school sign-off.
- [ ] **PII separation**: `students` (light) vs. `students_pii` (admin-only). Confirmed via RLS test.
- [ ] **Parental consent** workflow for under-13 learners; consent gate before any data collection.
- [ ] **Data export**: an admin can download all rows tied to one student in a single JSON.
- [ ] **Data deletion**: an admin request triggers a 30-day purge job that hard-deletes student rows + child rows in `skill_attempts` / `passage_attempts` / `telemetry_events`.
- [ ] **No third-party trackers**. Confirmed by network-tab audit on production build.
- [ ] **No PII in telemetry payloads**. The validator (`scripts/validate-content.js` extension) scans queued envelopes for forbidden keys (`email`, `name`, etc.) before flush.

## 3. Environment & secrets

- [ ] `.env.example` committed; never `.env`.
- [ ] **Supabase URL + anon key** loaded from env, not hard-coded.
- [ ] **Server-side secrets** (service role key, ASR keys) live only in Edge Function env vars.
- [ ] **Branch-specific environments**: `preview` (Vercel preview), `staging` (separate Supabase project), `production`.
- [ ] **Feature flags** switch between Web Speech API ASR (current) and Azure ASR (future) without a deploy.

## 4. Observability & error handling

- [ ] **Sentry** (or equivalent) integrated for both client and Edge Functions.
- [ ] **Telemetry queue health** widget on the debug dashboard: queue size, oldest pending event, last flush time.
- [ ] **Mic / ASR fallback path**: when Web Speech API errors, the UI offers a tap-to-confirm fallback so the session keeps going.
- [ ] **Offline tolerance**: the queue holds 256 KB / 2000 events without loss; UI reads stay functional offline.
- [ ] **Crash recovery**: a corrupted `student-model` localStorage value resets cleanly and logs a single warning rather than wedging the app.

## 5. Pedagogy & content gates

- [ ] **Validator clean**: `npm run validate` is 0 errors, 0 warnings on every deploy. CI gate enforced.
- [ ] **Cold-pool minimum**: every `FL_xx` gate has ≥3 cold and ≥3 practice passages.
- [ ] **Decodability spot-check**: a non-engineering reviewer (literacy specialist) signs off that 6 randomly-sampled passages are appropriate at their gate.
- [ ] **Diagnostic placement** terminates within 8 minutes for any learner.
- [ ] **Mastery transitions** make sense: pilot teacher walks a synthetic learner through a session and confirms the state machine never produces a surprising state.

## 6. Performance & accessibility

- [ ] **Initial load** under 3 s on a 4 G connection, under 1 s on Wi-Fi.
- [ ] **Mic latency** under 200 ms from button-tap to "listening" state.
- [ ] **Keyboard navigation** full coverage on Today, Drill, Fluency, Passage, Debug.
- [ ] **Screen reader** correct labels on every interactive element.
- [ ] **Color contrast** WCAG AA across the XP ring, course tree, and drill UI.
- [ ] **Reduced motion** honored — XP ring animation collapses to a static state when `prefers-reduced-motion`.
- [ ] **Tablet first**: layout works on iPad portrait at 1024×768.

## 7. Telemetry & data flow

- [ ] **Client queue** flushes successfully against staging Edge Function with sample envelopes.
- [ ] **Idempotency** verified: re-flushing the same `attempt_id` is a no-op server-side.
- [ ] **Server replay** confirmed: replaying `skill_attempts` for one student rebuilds `student_app_accounts.state` byte-for-byte equal to the client's.
- [ ] **Schema parity**: client and server validators agree on the v1 taxonomy.
- [ ] **Backfill**: a learner who signs in for the first time on device B with state on device A reconciles within one session.

## 8. Teacher dashboard

- [ ] Per-class roster view: each row shows mastered count, current gate, last session date, fluency trend.
- [ ] Per-student deep dive: mastery state per node, fluency trend, review queue, last 20 attempts.
- [ ] CSV export for the per-class view.
- [ ] No teacher action can mutate student data without a confirmation dialog.

## 9. Pilot operations

- [ ] **Onboarding doc** for the pilot teacher: 1-page setup, 1-page weekly check-in, FAQ.
- [ ] **Bug-report path**: a single email + an in-app "report a problem" button.
- [ ] **Weekly office hours** scheduled with the pilot teacher for the first 6 weeks.
- [ ] **Outage runbook**: what to tell teachers if the app is down for >15 min.
- [ ] **Data review cadence**: every Friday, eng reviews telemetry for the previous week, flags anomalies, and updates the pilot teacher.

## 10. Deploy gate

- [ ] `npm run build` clean.
- [ ] `npm run validate` clean.
- [ ] `tsc --noEmit` clean across `src/lib/**/*.ts`.
- [ ] Vercel preview URL passes a manual smoke test on a real iPad.
- [ ] Privacy policy + DPA signed by the pilot school's admin.
- [ ] Pilot teacher has done a full dry-run with synthetic data.

---

## Out of scope for the pilot

These items are explicitly **not** required for the first pilot, but should be tracked as post-pilot follow-ups:

- AI-driven recommendations (rule-based only for v1).
- Cross-language support (English-only).
- Parent dashboard.
- Mobile app (web-only on iPad).
- District-level reporting.
- IRT / FSRS-grade spacing models.
- Multi-classroom assignment workflows.

---

*When every box on this checklist is ✅, Reading Academy is pilot-ready.*
