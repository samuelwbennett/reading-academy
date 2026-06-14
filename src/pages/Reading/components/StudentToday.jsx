// src/pages/Reading/components/StudentToday.jsx
//
// Student-facing Today screen. Renders the planSession output as a
// scannable list of lessons (Math Academy-style), each tappable to
// drop straight into the right route with the right nodeId.
//
// Surface contract:
//   - Quick-glance progress strip at top: skills mastered, daily XP
//     bar, week XP.
//   - "Today's plan" list: every intent from planSession.blocks,
//     in priority order. Each row shows:
//       · lock/unlock icon
//       · lesson title (topic name) + small strand/kind subtitle
//       · XP reward
//       · Start CTA (whole row is the tap target)
//   - "Up next" tail: a peek at the next 3 locked nodes immediately
//     downstream from the active frontier, so students can see what
//     they're working toward without it being a distraction.
//   - Empty state: "All caught up — come back tomorrow."
//   - Placement state: surface the diagnostic if it isn't done.
//
// All Start links pass ?node=<id> so the Drill / Fluency / Passage
// route opens exactly the lesson the student tapped. Previously the
// home picked a node via the planner but Drill picked its own from
// stale local state — so a student tapping "Vocab in context" could
// land on "Phoneme deletion." That bug is gone now: source of truth
// for the active lesson is the intent the student clicked.

import React from "react";
import { Link } from "react-router-dom";

const ROUTE_FOR_KIND = {
  review: "/reading/drill",
  drill: "/reading/drill",
  fluency: "/reading/fluency",
  cold_passage: "/reading/passage",
  placement: "/reading/diagnostic",
};

const KIND_LABEL = {
  review: "Review",
  drill: "New lesson",
  fluency: "Reading drill",
  cold_passage: "New story",
};

// XP per intent kind. Mirrors how Math Academy attaches a fixed XP
// reward to each lesson surface. Adjust as the mastery engine learns
// what "one unit of progress" is worth in each context.
const XP_FOR_KIND = {
  review: 3,
  drill: 7,
  fluency: 5,
  cold_passage: 10,
};

const DAILY_XP_GOAL = 30;

export default function StudentToday({
  plan,
  diagnosticComplete,
  counts,
  nodeIndex, // optional: id → node, used to pretty-label intents
  todayXp = 0,
  weekXp = 0,
}) {
  // First-run: send to placement before anything else.
  if (!diagnosticComplete) {
    return <PlacementHero />;
  }

  const intents = (plan?.blocks || []).flatMap((b) =>
    (b.intents || []).map((i) => ({ ...i, _block: b })),
  );

  if (intents.length === 0) {
    return (
      <>
        <ProgressStrip counts={counts} todayXp={todayXp} weekXp={weekXp} />
        <section
          className="ra-card"
          style={{ textAlign: "center", padding: "32px 20px", marginTop: 12 }}
        >
          <div style={{ fontSize: 36 }} aria-hidden>✨</div>
          <h2 className="ra-card-title" style={{ margin: "10px 0 4px" }}>
            All caught up
          </h2>
          <p className="ra-card-sub" style={{ margin: 0 }}>
            Come back tomorrow for more.
          </p>
        </section>
      </>
    );
  }

  return (
    <>
      <ProgressStrip counts={counts} todayXp={todayXp} weekXp={weekXp} />
      <section className="ra-card ra-today-list">
        <div className="ra-eyebrow" style={{ marginBottom: 10 }}>
          Today's plan
        </div>
        <ul className="ra-lesson-list">
          {intents.map((intent, i) => {
            const node = intent.nodeId
              ? nodeIndex?.[intent.nodeId]
              : null;
            const title =
              node?.topic ||
              node?.module ||
              intent._block?.subtitle ||
              KIND_LABEL[intent.kind] ||
              "Lesson";
            const sub = subtitleFor(intent, node);
            const xp = XP_FOR_KIND[intent.kind] ?? 5;
            const baseHref = ROUTE_FOR_KIND[intent.kind] || "/reading";
            const href = intent.nodeId
              ? `${baseHref}?node=${encodeURIComponent(intent.nodeId)}`
              : baseHref;
            const recommended = i === 0;
            return (
              <li key={`${intent.kind}-${intent.nodeId || i}`}>
                <Link to={href} className="ra-lesson-row">
                  <span className="ra-lesson-icon" aria-hidden>
                    {recommended ? <UnlockedIcon /> : <UnlockedIcon dim />}
                  </span>
                  <span className="ra-lesson-body">
                    <span className="ra-lesson-kind">
                      {KIND_LABEL[intent.kind] || "Lesson"}
                    </span>
                    <span className="ra-lesson-title">{title}</span>
                    {sub && (
                      <span className="ra-lesson-sub">{sub}</span>
                    )}
                  </span>
                  <XpRing xp={xp} size={44} stroke={4} />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

// ---- helpers ----

function subtitleFor(intent, node) {
  const strand = node?.strand;
  if (intent.kind === "review") {
    if (intent.reason === "forgetting_risk") return "Spaced review · don't lose this";
    return strand ? `${strand} · keep sharp` : "Keep sharp";
  }
  if (intent.kind === "drill") {
    return strand || "Active practice";
  }
  if (intent.kind === "fluency") return "Fluency · fast and accurate";
  if (intent.kind === "cold_passage") return "Transfer · a fresh passage";
  return null;
}

function PlacementHero() {
  return (
    <section
      className="ra-card"
      style={{ textAlign: "center", padding: "36px 20px", marginBottom: 12 }}
    >
      <div className="ra-eyebrow" style={{ marginBottom: 6 }}>
        Today
      </div>
      <h2 className="ra-card-title" style={{ fontSize: 26, margin: "0 0 6px" }}>
        Let's get started
      </h2>
      <p
        className="ra-card-sub"
        style={{ marginTop: 0, marginBottom: 22, fontSize: 15 }}
      >
        Quick check — about 5 minutes.
      </p>
      <Link
        to="/reading/diagnostic"
        className="ra-btn ra-btn-primary"
        style={{
          display: "inline-block",
          padding: "14px 36px",
          fontSize: 18,
          textDecoration: "none",
        }}
      >
        Start
      </Link>
    </section>
  );
}

function ProgressStrip({ counts, todayXp, weekXp }) {
  const masteredPct = counts
    ? Math.round((counts.pct ?? 0) * 100)
    : 0;
  const dailyPct = Math.min(100, Math.round((todayXp / DAILY_XP_GOAL) * 100));
  return (
    <section className="ra-card ra-today-strip">
      <div className="ra-today-strip-col">
        <div className="ra-today-strip-eyebrow">Skills mastered</div>
        <div className="ra-today-strip-value">
          {counts?.mastered ?? 0}
          <span className="ra-today-strip-of">
            {" "}of {counts?.total ?? 0}
          </span>
        </div>
        <div className="ra-today-strip-bar" aria-label={`${masteredPct}% mastered`}>
          <div
            className="ra-today-strip-bar-fill mastered"
            style={{ width: `${masteredPct}%` }}
          />
        </div>
      </div>
      <div className="ra-today-strip-divider" aria-hidden />
      <div className="ra-today-strip-col">
        <div className="ra-today-strip-eyebrow">Today</div>
        <div className="ra-today-strip-value">
          {todayXp}
          <span className="ra-today-strip-of"> / {DAILY_XP_GOAL} XP</span>
        </div>
        <div className="ra-today-strip-bar" aria-label={`${dailyPct}% of daily goal`}>
          <div
            className="ra-today-strip-bar-fill daily"
            style={{ width: `${dailyPct}%` }}
          />
        </div>
      </div>
      <div className="ra-today-strip-divider" aria-hidden />
      <div className="ra-today-strip-col">
        <div className="ra-today-strip-eyebrow">This week</div>
        <div className="ra-today-strip-value">
          {weekXp}
          <span className="ra-today-strip-of"> XP</span>
        </div>
        <div className="ra-today-strip-bar" aria-hidden>
          <div
            className="ra-today-strip-bar-fill weekly"
            style={{ width: `${Math.min(100, weekXp / 2)}%` }}
          />
        </div>
      </div>
    </section>
  );
}

function UnlockedIcon({ dim = false }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke={dim ? "#c7c7cc" : RA_PURPLE}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
  );
}

// Reading Academy's app color in the orchestration layer's DailyRings.
// Keep this in sync with APP_COLOR_HEX["reading-academy"] over there so
// both surfaces feel like the same app.
const RA_PURPLE = "#bf5af2";
const RA_PURPLE_TRACK = "rgba(191, 90, 242, 0.18)";

// Small XP donut. Always 100% filled because the XP value shown is the
// "reward when you complete this lesson" — it's a label, not progress.
// We render it as a ring (vs flat text) to match the rings on the
// orchestration dashboard and the Math Academy reference UI.
function XpRing({ xp, size = 44, stroke = 4 }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span
      className="ra-lesson-xp-ring"
      style={{ width: size, height: size }}
      aria-label={`${xp} XP`}
    >
      <svg
        width={size}
        height={size}
        style={{ transform: "rotate(-90deg)", display: "block" }}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={RA_PURPLE_TRACK}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={RA_PURPLE}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={0}
        />
      </svg>
      <span className="ra-lesson-xp-ring-label">
        <span className="ra-lesson-xp-ring-num">{xp}</span>
        <span className="ra-lesson-xp-ring-unit">XP</span>
      </span>
    </span>
  );
}
