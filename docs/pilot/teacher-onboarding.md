# Reading Academy — Teacher Quick Start

Welcome — and thank you for piloting Reading Academy. This single
page is everything you need for the first week. You can come back to
it whenever you need a reminder.

---

## What it does

Reading Academy is a mastery-based reading practice tool for K–2
learners. Each child works through a sequence of phonics skills,
practices fluency on decodable passages, and the system keeps track
of what they know, how quickly they know it, and what they should
practice next.

You don't have to plan a session. The app shows the child the right
thing in the right order.

---

## Five things to do on day one

1. **Open** `https://reading-academy.vercel.app` on the device the
   child will use. iPad in portrait works best.
2. **Sign in** if you'd like progress to follow the child across
   devices: tap **"Sign in to sync"** in the header. Use your school
   email. We'll send a one-tap sign-in link — no password.
3. **Run the placement** if the child hasn't done it yet. The
   dashboard prompts for it on first visit. It takes 5–8 minutes.
4. **Tap Start** on the first card on the dashboard. That's
   "Today's session." It might be a quick review, today's lesson,
   a 60-second fluency drill, or a cold-read passage — the app
   chooses.
5. **Score with the green / red buttons** if the microphone misses
   what the child said. The app prefers automatic scoring but the
   tap is always available.

That's it. The first session takes about 10–15 minutes.

---

## What you'll see

- **Today's session** — the day's plan. Reviews first, then the
  active lesson, then fluency, then a cold passage when the child
  has earned one.
- **Progress** — counts of mastered, in-progress, and locked skills.
- **Course tree** — the full skill graph, so you can see what's
  ahead.
- **Sign in to sync** — header link to the auth screen.
- **/reading/debug** (engineering view) — per-skill mastery, fluency
  curve, today's session plan, recent telemetry. Useful for spot
  checks. CSV export buttons download the same data.

---

## Weekly cadence (suggested)

| When | What | Time |
|---|---|---|
| Monday | Two sessions, child working through Today's plan. | 20 min total |
| Tuesday–Thursday | One session per day. The plan adapts based on what they got right. | 10–15 min each |
| Friday | One session + a quick look at `/reading/debug` to see what's stalled or ready to advance. | 15 min |
| Anytime | If the child seems frustrated, the cold-read can wait a day. The dashboard remembers and surfaces it again. |

The bedrock idea is short, focused, frequent. The system favors a
10-minute session daily over a 60-minute session once a week.

---

## What's hard, what's expected

**Hard for kindergartners**: phoneme isolation, blending, segmentation.
The app speaks the word out loud automatically, then waits for the
child to respond. That's by design — we're testing the child, not
their reading-out-loud skill.

**Expected**: incorrect answers. Mastery isn't single-shot; the
engine watches the child's last 20 attempts. A bad day doesn't undo
mastery.

**Worth flagging to me**: if the same skill keeps showing up day
after day with no progress for ~7 days, the dashboard's
**Insights** section will surface it. You'll see something like:

> 🟡 Stalled at PA_06 segment CVC — 8 days since last
> practice; status practicing with 12 attempts logged.

When you see one of those, the child probably needs a different
intervention — a few minutes of direct teacher modeling, or a step
back to a prerequisite. The app can't replace that part of teaching.

---

## Frequently asked

**Q. The microphone isn't working.**
On iPad, Safari prompts for mic permission the first time the child
taps the mic button. If it's been denied, go to Settings → Safari
→ Camera & Microphone → Reading Academy → Allow. Until that's
fixed, use the green / red tap buttons — same scoring path.

**Q. The child got the right answer but it scored wrong.**
Tap the green button. The microphone recognizer struggles with
isolated phonemes ("/s/" sounds like "ess" or "es" and the
recognizer sometimes can't tell). The tap overrides it.

**Q. Can I see how long the child has spent in the app?**
`/reading/debug` shows total attempts and the last-50 telemetry
events. A class-level dashboard lands in the next milestone.

**Q. What if a child is way ahead?**
The placement walk runs through every skill until the child fails
three in a row. They'll be placed at exactly the right skill, even
if that's three years above grade level.

**Q. What if a child is way behind?**
Same path — placement finds the right starting point. There is no
"floor." Even a child who needs to start with letter sounds will
get placed there cleanly.

**Q. The site is down.**
Email [your contact]. Most issues are network or sign-in;
real outages get fixed quickly.

---

## What I need from you, the pilot teacher

Three things:

1. **Use it daily for two weeks.** Even brief sessions. The data
   gets useful around session 5–10.
2. **Note the friction.** Anything confusing, slow, or wrong —
   write it down or text it to me. No filter.
3. **Don't pre-correct.** Let the child get things wrong. The
   system's whole job is to know where they are.

That's it. Thanks for piloting. The app gets better fastest when
real children break it.

---

*Reading Academy v1.0 · pilot · v1.0 onboarding*
