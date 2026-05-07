import React, { useEffect, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createClient } from "@supabase/supabase-js";
import { ROUTES, isInternal } from "../config/routes.js";

// --- Supabase ----------------------------------------------------------------
const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || "";
const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// --- Config ------------------------------------------------------------------
const STUDENT_NAME = "Samuel"; // Greeting target
const DAILY_XP_GOAL = 30;

// The apps that show up as rings. Each ring is tappable.
// Internal apps (`internal: true`) navigate within this SPA via ROUTES.
// External apps open their `url` in a new tab.
const APPS = [
  {
    key: "math",
    label: "Math Academy",
    sub: "4th Grade Math",
    internal: false,
    url: "https://www.mathacademy.com/",
    color: { from: "#FF2D55", to: "#FF6482", track: "rgba(255, 45, 85, 0.12)" },
  },
  {
    key: "reading",
    label: "Reading",
    sub: "Reading Academy",
    internal: true,
    to: ROUTES.READING,
    color: { from: "#34C759", to: "#5DDB7A", track: "rgba(52, 199, 89, 0.14)" },
  },
  {
    key: "writing",
    label: "Writing",
    sub: "Quill",
    internal: false,
    url: "https://www.quill.org/",
    color: { from: "#0A84FF", to: "#5AC8FA", track: "rgba(10, 132, 255, 0.14)" },
  },
];

// --- Helpers -----------------------------------------------------------------
const fmtNum = (n) =>
  n === null || n === undefined || Number.isNaN(Number(n))
    ? "—"
    : Number(n).toLocaleString();

const greeting = () => {
  const h = new Date().getHours();
  if (h < 5) return "Hi";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
};

// --- Ring (tappable app launcher) -------------------------------------------
function AppRing({ app, value, goal = 100, size = 132, stroke = 12, onClick }) {
  const id = useId();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Number(value) || 0;
  const pct = Math.max(0, Math.min(1, v / goal));
  const offset = c * (1 - pct);

  return (
    <button className="sa-app" onClick={onClick} aria-label={`Open ${app.label}`}>
      <div className="sa-app-ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)", display: "block" }}>
          <defs>
            <linearGradient id={id} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={app.color.from} />
              <stop offset="100%" stopColor={app.color.to} />
            </linearGradient>
          </defs>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={app.color.track} strokeWidth={stroke} />
          <circle
            cx={size / 2} cy={size / 2} r={r}
            fill="none" stroke={`url(#${id})`} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 700ms ease-out" }}
          />
        </svg>
        <div className="sa-app-ring-label">
          <span className="sa-app-ring-pct">{Math.round(pct * 100)}%</span>
        </div>
      </div>
      <div className="sa-app-meta">
        <div className="sa-app-name">{app.label}</div>
        <div className="sa-app-sub">{app.sub}</div>
      </div>
    </button>
  );
}

// --- Styles ------------------------------------------------------------------
const STYLES = `
.sa-app-root {
  min-height: 100vh;
  background: #F5F5F7;
  color: #1d1d1f;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.sa-container { max-width: 760px; margin: 0 auto; padding: 64px 28px 96px; }
@media (max-width: 600px) { .sa-container { padding: 36px 20px 60px; } }

/* Header greeting */
.sa-greeting { font-size: 14px; color: #86868b; font-weight: 500; margin: 0; }
.sa-name { font-size: 44px; font-weight: 600; letter-spacing: -0.022em; line-height: 1.05; color: #1d1d1f; margin: 6px 0 6px; }
@media (max-width: 600px) { .sa-name { font-size: 34px; } }
.sa-updated { font-size: 13px; color: #86868b; margin: 0; }

/* Section eyebrow */
.sa-eyebrow {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.08em; color: #86868b; margin: 0;
}
.sa-section { margin-top: 36px; }

/* Needs attention banner */
.sa-attention {
  display: flex; align-items: center; gap: 14px;
  background: #fff; border-radius: 18px; padding: 16px 20px;
  margin-top: 24px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px -16px rgba(0,0,0,0.08);
}
.sa-attention-dot {
  width: 10px; height: 10px; border-radius: 50%;
  background: #FF9F0A; flex-shrink: 0;
  box-shadow: 0 0 0 4px rgba(255, 159, 10, 0.16);
}
.sa-attention-title { font-size: 14px; font-weight: 600; color: #1d1d1f; margin: 0; line-height: 1.3; }
.sa-attention-sub { font-size: 13px; color: #6e6e73; margin: 2px 0 0; line-height: 1.35; }

/* Start here card — primary CTA */
.sa-start {
  display: block; width: 100%; text-align: left;
  background: #1d1d1f; color: #fff; border: none; cursor: pointer;
  border-radius: 28px; padding: 28px; margin-top: 14px;
  font-family: inherit;
  box-shadow: 0 1px 2px rgba(0,0,0,0.06), 0 24px 48px -24px rgba(0,0,0,0.30);
  transition: transform 0.2s, box-shadow 0.2s;
  overflow: hidden; position: relative;
}
.sa-start:hover {
  transform: translateY(-2px);
  box-shadow: 0 1px 2px rgba(0,0,0,0.06), 0 30px 56px -24px rgba(0,0,0,0.40);
}
.sa-start-eyebrow {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.08em; color: rgba(255,255,255,0.55); margin: 0;
}
.sa-start-title { font-size: 26px; font-weight: 600; letter-spacing: -0.015em; line-height: 1.15; margin: 8px 0 4px; }
.sa-start-sub { font-size: 15px; color: rgba(255,255,255,0.65); margin: 0; }
.sa-start-bar { height: 6px; background: rgba(255,255,255,0.12); border-radius: 999px; overflow: hidden; margin-top: 22px; }
.sa-start-bar-fill {
  height: 100%; border-radius: 999px;
  background: linear-gradient(90deg, #FF2D55, #FF6482);
  transition: width 0.6s ease-out;
}
.sa-start-row { display: flex; justify-content: space-between; align-items: baseline; margin-top: 10px; }
.sa-start-pct { font-size: 14px; font-weight: 600; color: rgba(255,255,255,0.85); }
.sa-start-cta { font-size: 14px; font-weight: 500; color: rgba(255,255,255,0.85); }

/* Apps row — clickable rings */
.sa-apps {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 14px;
}
@media (max-width: 600px) { .sa-apps { grid-template-columns: repeat(3, 1fr); gap: 8px; } }

.sa-app {
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  padding: 22px 12px;
  background: #fff; border: none; border-radius: 24px; cursor: pointer;
  font-family: inherit; text-align: center;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 12px 32px -16px rgba(0,0,0,0.10);
  transition: transform 0.2s, box-shadow 0.2s;
}
.sa-app:hover {
  transform: translateY(-3px);
  box-shadow: 0 2px 4px rgba(0,0,0,0.05), 0 20px 48px -20px rgba(0,0,0,0.18);
}
.sa-app-ring { position: relative; }
.sa-app-ring-label { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
.sa-app-ring-pct { font-size: 22px; font-weight: 600; letter-spacing: -0.015em; color: #1d1d1f; }
.sa-app-meta { display: flex; flex-direction: column; gap: 2px; }
.sa-app-name { font-size: 14px; font-weight: 600; color: #1d1d1f; letter-spacing: -0.005em; }
.sa-app-sub { font-size: 12px; color: #86868b; font-weight: 500; }

/* Card (insights, earning) */
.sa-card {
  background: #fff; border-radius: 24px; padding: 24px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 12px 32px -16px rgba(0,0,0,0.10);
  margin-top: 14px;
}
.sa-card-title { font-size: 17px; font-weight: 600; color: #1d1d1f; margin: 0 0 10px; letter-spacing: -0.01em; }

/* Insight item */
.sa-insight { display: flex; gap: 14px; align-items: flex-start; }
.sa-insight-icon {
  width: 32px; height: 32px; flex-shrink: 0; border-radius: 50%;
  background: #F0F4FF; color: #0A84FF; display: inline-flex; align-items: center; justify-content: center;
}
.sa-insight-text { font-size: 15px; line-height: 1.5; color: #1d1d1f; margin: 6px 0 0; }
.sa-insight-text strong { font-weight: 600; }
.sa-insight + .sa-insight { margin-top: 16px; padding-top: 16px; border-top: 1px solid #F5F5F7; }

/* Earning */
.sa-earn-row { display: flex; align-items: center; gap: 22px; }
.sa-earn-ring { flex-shrink: 0; position: relative; width: 96px; height: 96px; }
.sa-earn-label { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.sa-earn-num { font-size: 22px; font-weight: 600; letter-spacing: -0.015em; color: #1d1d1f; line-height: 1; }
.sa-earn-of { font-size: 10px; font-weight: 500; color: #86868b; margin-top: 4px; }
.sa-earn-stats { flex: 1; display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px 18px; }
.sa-earn-label-text { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #86868b; }
.sa-earn-value { font-size: 20px; font-weight: 600; color: #1d1d1f; margin-top: 2px; letter-spacing: -0.01em; }
`;

// --- Main Launcher -----------------------------------------------------------
export default function Launcher() {
  const navigate = useNavigate();

  // Today's data — wire to supabase later.
  // These reflect Samuel's current status pulled from Math Academy.
  const [data, setData] = useState({
    courseLabel: "Math Academy",
    courseSub: "4th Grade Math",
    coursePct: 6,
    appProgress: { math: 6, reading: 22, writing: 14 },
    needsAttention: {
      title: "Math Academy is waiting",
      sub: "You haven't started today — let's keep the streak going.",
    },
    todayXp: 0,
    weekXp: 142,
    streakDays: 4,
    insights: [
      { text: "You've mastered 27 new skills since starting — keep it up." },
      { text: "Your strongest area right now is Operations & Algebraic Thinking." },
    ],
    loading: true,
  });

  // Optional: pull a live snapshot for Samuel from supabase.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!supabase) {
        setData((d) => ({ ...d, loading: false }));
        return;
      }
      try {
        const { data: rows, error } = await supabase
          .from("ai_insights")
          .select("*")
          .eq("audience", "student")
          .ilike("name", `%${STUDENT_NAME}%`)
          .order("run_date", { ascending: false })
          .limit(1);
        if (cancelled) return;
        if (!error && rows && rows.length) {
          const row = rows[0];
          const summary = row.summary || "";
          const xp = Number((summary.match(/(\d+)\s+XP/i) || [])[1]) || 0;
          const masteryPct = Number((summary.match(/([\d.]+)%\s+observed/i) || [])[1]);
          setData((d) => ({
            ...d,
            coursePct: Number.isNaN(masteryPct) ? d.coursePct : Math.round(masteryPct),
            appProgress: { ...d.appProgress, math: Number.isNaN(masteryPct) ? d.appProgress.math : Math.round(masteryPct) },
            todayXp: xp,
            needsAttention:
              xp < DAILY_XP_GOAL
                ? {
                    title: "Math Academy is waiting",
                    sub: `You're ${DAILY_XP_GOAL - xp} XP from today's goal.`,
                  }
                : null,
            loading: false,
          }));
        } else {
          setData((d) => ({ ...d, loading: false }));
        }
      } catch {
        setData((d) => ({ ...d, loading: false }));
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Polymorphic launch: internal apps navigate via react-router; external open a tab.
  const launchApp = (app) => {
    if (!app) return;
    if (app.internal && app.to && isInternal(app.to)) {
      navigate(app.to);
      return;
    }
    if (app.url) {
      window.open(app.url, "_blank", "noopener,noreferrer");
    }
  };

  const xpRing = useMemo(() => {
    const pct = Math.max(0, Math.min(1, (data.todayXp || 0) / DAILY_XP_GOAL));
    return { pct, offset: 2 * Math.PI * 42 * (1 - pct) };
  }, [data.todayXp]);

  return (
    <div className="sa-app-root">
      <style>{STYLES}</style>
      <div className="sa-container">
        {/* Greeting */}
        <header>
          <p className="sa-greeting">{greeting()}</p>
          <h1 className="sa-name">{greeting()}, {STUDENT_NAME}.</h1>
          <p className="sa-updated">Updated just now</p>
        </header>

        {/* Needs attention */}
        {data.needsAttention && (
          <section className="sa-section" style={{ marginTop: 28 }}>
            <p className="sa-eyebrow">Needs attention</p>
            <div className="sa-attention">
              <span className="sa-attention-dot" />
              <div>
                <p className="sa-attention-title">{data.needsAttention.title}</p>
                <p className="sa-attention-sub">{data.needsAttention.sub}</p>
              </div>
            </div>
          </section>
        )}

        {/* Start here */}
        <section className="sa-section">
          <p className="sa-eyebrow">Start here</p>
          <button
            className="sa-start"
            onClick={() => launchApp(APPS[0])}
            aria-label={`Continue ${data.courseLabel}`}
          >
            <p className="sa-start-eyebrow">{data.courseLabel}</p>
            <h2 className="sa-start-title">{data.courseSub}</h2>
            <p className="sa-start-sub">{data.coursePct}% complete</p>
            <div className="sa-start-bar">
              <div className="sa-start-bar-fill" style={{ width: `${data.coursePct}%` }} />
            </div>
            <div className="sa-start-row">
              <span className="sa-start-pct">{data.coursePct}%</span>
              <span className="sa-start-cta">Continue →</span>
            </div>
          </button>
        </section>

        {/* Apps */}
        <section className="sa-section">
          <p className="sa-eyebrow">Your apps</p>
          <div className="sa-apps">
            {APPS.map((app) => (
              <AppRing
                key={app.key}
                app={app}
                value={data.appProgress[app.key] ?? 0}
                goal={100}
                size={120}
                stroke={11}
                onClick={() => launchApp(app)}
              />
            ))}
          </div>
        </section>

        {/* Insights */}
        <section className="sa-section">
          <p className="sa-eyebrow">Insights</p>
          <div className="sa-card">
            {data.insights.map((ins, i) => (
              <div key={i} className="sa-insight">
                <span className="sa-insight-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                    <circle cx="12" cy="12" r="4" />
                  </svg>
                </span>
                <p className="sa-insight-text">{ins.text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Earning */}
        <section className="sa-section">
          <p className="sa-eyebrow">Earning</p>
          <div className="sa-card">
            <div className="sa-earn-row">
              <div className="sa-earn-ring">
                <svg width={96} height={96} style={{ transform: "rotate(-90deg)", display: "block" }}>
                  <defs>
                    <linearGradient id="sa-earn-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#FF2D55" />
                      <stop offset="100%" stopColor="#FF6482" />
                    </linearGradient>
                  </defs>
                  <circle cx={48} cy={48} r={42} fill="none" stroke="rgba(255, 45, 85, 0.12)" strokeWidth={9} />
                  <circle
                    cx={48} cy={48} r={42}
                    fill="none" stroke="url(#sa-earn-grad)" strokeWidth={9} strokeLinecap="round"
                    strokeDasharray={2 * Math.PI * 42} strokeDashoffset={xpRing.offset}
                    style={{ transition: "stroke-dashoffset 700ms ease-out" }}
                  />
                </svg>
                <div className="sa-earn-label">
                  <span className="sa-earn-num">{fmtNum(data.todayXp)}</span>
                  <span className="sa-earn-of">of {DAILY_XP_GOAL} XP</span>
                </div>
              </div>
              <div className="sa-earn-stats">
                <div>
                  <div className="sa-earn-label-text">Today</div>
                  <div className="sa-earn-value">{fmtNum(data.todayXp)} XP</div>
                </div>
                <div>
                  <div className="sa-earn-label-text">This week</div>
                  <div className="sa-earn-value">{fmtNum(data.weekXp)} XP</div>
                </div>
                <div>
                  <div className="sa-earn-label-text">Streak</div>
                  <div className="sa-earn-value">{data.streakDays} days</div>
                </div>
                <div>
                  <div className="sa-earn-label-text">Goal</div>
                  <div className="sa-earn-value">{Math.round(xpRing.pct * 100)}%</div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
