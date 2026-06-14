// src/pages/Reading/routes/Debug.jsx
//
// Read-only teacher / engineering dashboard. Mounted at /reading/debug.
//
// Surfaces:
//   - Per-node mastery: status, accuracy, latency, attempts, forgetting risk
//   - Per-gate fluency: cold/practiced WCPM, accuracy, trend
//   - Today's session plan (from sessionPlanner)
//   - Review queue
//   - Last 50 telemetry envelopes from the localStorage queue
//
// Pure read. No mutating buttons here. A single "reset student" button is
// gated behind a confirmation since this view is also useful for engineers
// debugging local state.

import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import skillNodes from "../../../data/skill_nodes.json";
import { load, reset } from "../../../lib/mastery/storage";
import { calculateForgettingRisk } from "../../../lib/mastery/masteryEngine";
import { buildReviewQueue } from "../../../lib/review/reviewScheduler";
import { planSession, flattenPlan } from "../../../lib/session/sessionPlanner";
import { peekAll, queueSize } from "../../../lib/telemetry";
import {
  loadState as loadReadingState,
  listPendingTeacherObservations,
} from "../lib/readingState.js";
import { getStoredStudentSession } from "../../../lib/auth/useStudentSession.js";
import { generateInsights } from "../../../lib/insights";
import { generateActions } from "../../../lib/actions";
import { toCsv, downloadCsv } from "../../../lib/dashboard/csv";
import FluencyChart from "../components/FluencyChart.jsx";
import WeeklyRecap from "../components/WeeklyRecap.jsx";
import CognitiveProfileCard from "../components/CognitiveProfileCard.jsx";
import ActionQueue from "../components/ActionQueue.jsx";
import { useAuth } from "../../../lib/auth/AuthProvider.jsx";

const PCT = (x) => `${Math.round((x ?? 0) * 100)}%`;
const MS = (x) => `${Math.round(x ?? 0)} ms`;
const RISK = (x) =>
  x == null ? "—" :
  x >= 0.7 ? `🔴 ${PCT(x)}` :
  x >= 0.4 ? `🟡 ${PCT(x)}` :
  `🟢 ${PCT(x)}`;

function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function StatusPill({ status }) {
  const colors = {
    locked: "#999",
    unlocked: "#7aa",
    active: "#2a7",
    practicing: "#a72",
    mastered_for_acquisition: "#27a",
    in_automaticity_zone: "#52d",
    automatic: "#a4d",
    regressed: "#c33",
  };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: 4,
        background: colors[status] ?? "#666",
        color: "white",
        fontSize: 11,
      }}
    >
      {status}
    </span>
  );
}

export default function Debug() {
  const [model, setModel] = useState(() => load());
  const [now, setNow] = useState(Date.now());
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      setModel(load());
      setNow(Date.now());
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const reviewQueue = useMemo(
    () => buildReviewQueue(Object.values(model.nodes), now),
    [model, now],
  );

  const plan = useMemo(
    () => planSession(model, skillNodes, undefined, now),
    [model, now],
  );

  const insights = useMemo(
    () => generateInsights(model, skillNodes, undefined, now),
    [model, now],
  );

  const actions = useMemo(
    () => generateActions(model, skillNodes, now),
    [model, now],
  );

  function exportNodesCsv() {
    const rows = skillNodes.map((def) => {
      const ns = model.nodes[def.id];
      return {
        node_id: def.id,
        topic: def.topic ?? def.skill ?? "",
        status: ns?.status ?? "locked",
        attempts: ns?.attempts ?? 0,
        rolling_accuracy: ns?.rollingAccuracy ?? 0,
        rolling_latency_ms: ns?.rollingLatencyMs ?? 0,
        forgetting_risk: ns ? calculateForgettingRisk(ns, now) : 0,
        last_practiced_at: ns?.lastPracticedAt ?? "",
        review_due_at: ns?.reviewDueAt ?? "",
      };
    });
    downloadCsv(`reading-academy-nodes-${todayIso()}.csv`, toCsv(rows));
  }

  function exportFluencyCsv() {
    const rows = [];
    for (const f of Object.values(model.fluency)) {
      if (!f) continue;
      for (const h of f.history) {
        rows.push({
          gate_id: f.gateId,
          ts: h.ts,
          ts_iso: new Date(h.ts).toISOString(),
          passage_id: h.passageId,
          is_cold: h.isCold,
          wcpm: h.wcpm,
          accuracy: h.accuracy,
        });
      }
    }
    downloadCsv(`reading-academy-fluency-${todayIso()}.csv`, toCsv(rows));
  }

  function exportInsightsCsv() {
    const rows = insights.map((i) => ({
      id: i.id,
      rule: i.rule,
      severity: i.severity,
      headline: i.headline,
      detail: i.detail,
      node_id: i.nodeId ?? "",
      evidence: JSON.stringify(i.evidence),
    }));
    downloadCsv(`reading-academy-insights-${todayIso()}.csv`, toCsv(rows));
  }

  const queue = useMemo(() => peekAll(), [now]);
  const queueSz = useMemo(() => queueSize(), [now]);

  const allNodes = skillNodes.map((def) => {
    const ns = model.nodes[def.id];
    return {
      def,
      state: ns,
      forgettingRisk: ns ? calculateForgettingRisk(ns, now) : 0,
    };
  });

  const masteredCount = Object.values(model.nodes).filter((n) =>
    n.status === "mastered_for_acquisition" ||
    n.status === "in_automaticity_zone" ||
    n.status === "automatic",
  ).length;

  const fluencyRows = Object.values(model.fluency).filter(Boolean);

  function handleReset() {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 4000);
      return;
    }
    reset();
    setModel(load());
    setConfirmReset(false);
  }

  return (
    <div className="reading-debug" style={{ padding: 24, fontFamily: "system-ui", fontSize: 13 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>Reading Academy — Debug</h1>
        <div style={{ display: "flex", gap: 12 }}>
          <Link to="/reading" style={{ fontSize: 12 }}>← back to Today</Link>
          <button
            onClick={handleReset}
            style={{
              fontSize: 12,
              padding: "4px 10px",
              border: "1px solid #c33",
              background: confirmReset ? "#c33" : "white",
              color: confirmReset ? "white" : "#c33",
              cursor: "pointer",
              borderRadius: 4,
            }}
          >
            {confirmReset ? "click again to confirm" : "reset student model"}
          </button>
        </div>
      </header>

      <p style={{ color: "#666" }}>
        Read-only view. Auto-refreshes every 5 s. {model.studentId ? `student=${model.studentId}` : "anonymous"} · created {fmtDate(model.createdAt)} · updated {fmtDate(model.updatedAt)}
      </p>

      {/* Summary tiles ---------------------------------------------------- */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, margin: "16px 0" }}>
        <Tile label="Mastered nodes" value={masteredCount} sub={`of ${skillNodes.length}`} />
        <Tile label="Reviews due" value={reviewQueue.length} sub="now" />
        <Tile label="Today's intents" value={plan.totalIntents} sub={`${plan.blocks.length} blocks`} />
        <Tile label="Telemetry queue" value={queueSz} sub="awaiting flush" />
      </section>

      {/* Action queue (M11) ---------------------------------------------- */}
      <Section title={`Action queue (${actions.length})`}>
        <DebugActionQueue actions={actions} />
      </Section>

      {/* Cognitive profile (cross-app, orchestration-owned) ------------- */}
      <Section title="Cognitive profile &middot; cross-app">
        <DebugCognitiveProfile />
      </Section>

      {/* Weekly recap (LLM) ---------------------------------------------- */}
      <Section title="Weekly recap">
        <DebugWeeklyRecap />
      </Section>

      {/* Insights -------------------------------------------------------- */}
      <Section
        title={`Insights (${insights.length})`}
        action={
          insights.length > 0 ? (
            <ExportButton onClick={exportInsightsCsv}>CSV</ExportButton>
          ) : null
        }
      >
        {insights.length === 0 && <Empty>no insights right now — keep practicing</Empty>}
        {insights.length > 0 && (
          <ul style={{ marginTop: 0, paddingLeft: 0, listStyle: "none" }}>
            {insights.map((i) => (
              <InsightRow key={i.id} insight={i} />
            ))}
          </ul>
        )}
      </Section>

      {/* Today's plan ----------------------------------------------------- */}
      <Section title="Today's session plan">
        {plan.empty && <Empty>nothing planned (cold start?)</Empty>}
        {!plan.empty && (
          <ol style={{ marginTop: 0 }}>
            {flattenPlan(plan).map((intent, i) => (
              <li key={i}>
                <strong>{intent.kind}</strong>
                {intent.nodeId && <> · {intent.nodeId}</>}
                {intent.gateId && <> · {intent.gateId}</>}
                <span style={{ color: "#888" }}> ({intent.reason}{intent.forgettingRisk != null ? ` · risk ${PCT(intent.forgettingRisk)}` : ""})</span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {/* Review queue ----------------------------------------------------- */}
      <Section title="Review queue">
        {reviewQueue.length === 0 && <Empty>nothing due</Empty>}
        {reviewQueue.length > 0 && (
          <Table
            cols={["nodeId", "status", "due", "risk", "confidence"]}
            rows={reviewQueue.map((n) => [
              n.nodeId,
              <StatusPill status={n.status} />,
              fmtDate(n.reviewDueAt),
              RISK(n.forgettingRisk),
              PCT(n.masteryConfidence),
            ])}
          />
        )}
      </Section>

      {/* Fluency ---------------------------------------------------------- */}
      <Section
        title="Fluency gates"
        action={
          fluencyRows.length > 0 ? (
            <ExportButton onClick={exportFluencyCsv}>CSV</ExportButton>
          ) : null
        }
      >
        {fluencyRows.length === 0 && <Empty>no passage attempts yet</Empty>}
        {fluencyRows.length > 0 && (
          <>
            <Table
              cols={["gate", "cold WCPM", "practiced WCPM", "accuracy", "attempts", "trend", "last attempt"]}
              rows={fluencyRows.map((f) => [
                f.gateId,
                Math.round(f.coldWcpm),
                Math.round(f.practicedWcpm),
                PCT(f.accuracyRate),
                f.passageAttempts,
                f.fluencyTrend.toFixed(2),
                fmtDate(f.lastAttemptAt),
              ])}
            />
            {fluencyRows.map((f) => (
              <div key={f.gateId} style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
                  {f.gateId}
                </div>
                <FluencyChart history={f.history} personalBest={f.coldWcpm} />
              </div>
            ))}
          </>
        )}
      </Section>

      {/* Per-node mastery ------------------------------------------------- */}
      <Section
        title={`All nodes (${skillNodes.length})`}
        action={<ExportButton onClick={exportNodesCsv}>CSV</ExportButton>}
      >
        <Table
          cols={["nodeId", "status", "attempts", "accuracy", "latency", "risk", "due", "last practiced"]}
          rows={allNodes.map(({ def, state, forgettingRisk }) => [
            def.id,
            <StatusPill status={state?.status ?? "locked"} />,
            state?.attempts ?? 0,
            PCT(state?.rollingAccuracy ?? 0),
            MS(state?.rollingLatencyMs ?? 0),
            RISK(forgettingRisk),
            fmtDate(state?.reviewDueAt),
            fmtDate(state?.lastPracticedAt),
          ])}
        />
      </Section>

      {/* M19-4: account / role verification panel ------------------------- */}
      <AccountVerificationPanel />

      {/* Pending teacher observations (M16-K4) ----------------------------- */}
      <PendingObservationsSection />

      {/* Telemetry queue tail --------------------------------------------- */}
      <Section title={`Telemetry queue (last 50 of ${queueSz})`}>
        {queue.length === 0 && <Empty>queue empty</Empty>}
        {queue.length > 0 && (
          <Table
            cols={["ts", "event", "payload"]}
            rows={queue.slice(-50).reverse().map((env) => [
              fmtDate(env.ts),
              <code>{env.event}</code>,
              <code style={{ fontSize: 11, color: "#666" }}>{JSON.stringify(env.payload)}</code>,
            ])}
          />
        )}
      </Section>
    </div>
  );
}

// M19-4: Account / role verification panel.
//
// Shows everything a teacher or admin needs to confirm role-based
// testing is wired correctly. No secrets, no PIN hashes, no tokens.
// Renders inside /reading/debug which is already RequireRole-gated.
function AccountVerificationPanel() {
  const { session, profile, syncStatus } = useAuth();
  const studentSession = getStoredStudentSession();
  const [ping, setPing] = useState({ status: "idle", detail: null });

  // Best-effort health probe of /api/student-session. Hits the
  // endpoint with no bearer — we expect 401 invalid_session, which
  // proves the dispatcher routes the call and the handler is alive.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/student-session");
        if (cancelled) return;
        const json = await res.json().catch(() => ({}));
        if (res.status === 401 && json?.error === "invalid_session") {
          setPing({ status: "ok", detail: `401 invalid_session (expected)` });
        } else {
          setPing({
            status: "warn",
            detail: `unexpected ${res.status} ${JSON.stringify(json).slice(0, 80)}`,
          });
        }
      } catch (e) {
        if (cancelled) return;
        setPing({ status: "fail", detail: e?.message || String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const role = profile?.role ?? null;
  const isAdmin = role === "admin";
  const isTeacher = role === "teacher";
  const buildSha =
    typeof window !== "undefined" && window.__RA_BUILD__?.sha
      ? window.__RA_BUILD__.sha
      : "unknown";
  const buildTime =
    typeof window !== "undefined" && window.__RA_BUILD__?.time
      ? window.__RA_BUILD__.time
      : "—";

  const accessibleRoutes = computeAccessibleRoutes({
    role,
    hasStudentSession: !!studentSession,
    signedIn: !!session?.user,
  });

  return (
    <Section title="Account / role verification">
      <div style={{ display: "grid", gap: 6, fontSize: 12 }}>
        <Row label="Supabase user" value={session?.user?.email || "— not signed in —"} />
        <Row label="User ID" value={session?.user?.id || "—"} />
        <Row
          label="Resolved role"
          value={
            role ? (
              <span
                style={{
                  padding: "1px 8px",
                  background: isAdmin ? "#fef2c0" : isTeacher ? "#dbeafe" : "#f3f4f6",
                  borderRadius: 999,
                  fontWeight: 600,
                }}
              >
                {role}
              </span>
            ) : (
              "— unassigned —"
            )
          }
        />
        <Row label="Sync status" value={syncStatus || "idle"} />
        <Row
          label="Student session"
          value={
            studentSession ? (
              <span style={{ color: "#9a3412" }}>
                ⚠ active — passwordless session for{" "}
                <strong>
                  {studentSession.student?.firstName}{" "}
                  {studentSession.student?.lastInitial}.
                </strong>
                {" "}(expires{" "}
                {studentSession.expiresAt
                  ? new Date(studentSession.expiresAt).toLocaleDateString()
                  : "?"}
                )
              </span>
            ) : (
              "none"
            )
          }
        />
        <Row label="Build" value={`${buildSha} @ ${buildTime}`} />
        <Row
          label="Supabase env"
          value={
            typeof window !== "undefined" &&
            (window.location?.hostname || "").length > 0 ? (
              <span>configured (origin {window.location.origin})</span>
            ) : (
              "—"
            )
          }
        />
        <Row
          label="/api/student-session ping"
          value={
            ping.status === "ok" ? (
              <span style={{ color: "#15803d" }}>✓ {ping.detail}</span>
            ) : ping.status === "warn" ? (
              <span style={{ color: "#a16207" }}>⚠ {ping.detail}</span>
            ) : ping.status === "fail" ? (
              <span style={{ color: "#a31515" }}>✗ {ping.detail}</span>
            ) : (
              "…"
            )
          }
        />
      </div>

      <h3 style={{ fontSize: 12, marginTop: 16, marginBottom: 6 }}>
        Route access for current session
      </h3>
      <Table
        cols={["route", "purpose", "access"]}
        rows={accessibleRoutes.map((r) => [
          <code>{r.path}</code>,
          r.purpose,
          r.allowed ? (
            <span style={{ color: "#15803d" }}>✓ allowed</span>
          ) : (
            <span style={{ color: "#a31515" }}>✗ blocked</span>
          ),
        ])}
      />
      <p style={{ fontSize: 11, color: "#888", marginTop: 8 }}>
        This is a UX check. The authoritative security boundary is Postgres
        Row-Level Security — a "✓ allowed" row will still return zero data
        if the RLS policies disagree. See <code>docs/testing/accounts-role-testing.md</code>.
      </p>
    </Section>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 12 }}>
      <span style={{ color: "#666" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function computeAccessibleRoutes({ role, hasStudentSession, signedIn }) {
  const teacherish = role === "teacher" || role === "admin";
  return [
    { path: "/student", purpose: "Passwordless student login", allowed: true },
    { path: "/reading", purpose: "Student Today screen", allowed: true },
    {
      path: "/reading/drill",
      purpose: "Drill (student-facing)",
      allowed: true,
    },
    {
      path: "/reading/diagnostic",
      purpose: "Placement",
      allowed: true,
    },
    {
      path: "/reading/passage",
      purpose: "Passage reader",
      allowed: true,
    },
    {
      path: "/reading/roster",
      purpose: "Teacher roster + class codes + PINs",
      allowed: teacherish && !hasStudentSession,
    },
    {
      path: "/reading/debug",
      purpose: "This page",
      allowed: teacherish && !hasStudentSession,
    },
    {
      path: "/reading/actions",
      purpose: "Cohort actions",
      allowed: teacherish && !hasStudentSession,
    },
    {
      path: "/reading/student/:id",
      purpose: "Per-student deep dive",
      allowed: teacherish && !hasStudentSession,
    },
    {
      path: "/reading/signin",
      purpose: "Adult sign-in",
      allowed: !signedIn,
    },
  ];
}

// M16-K4: Surface the autonomous-bypass observation queue. Whenever
// an autonomous student would have been routed to a teacher-led node,
// readingState records the bypass. Teachers can use this as a
// recommended-observation list for in-person check-ins.
function PendingObservationsSection() {
  const readingState = loadReadingState();
  const obs = listPendingTeacherObservations(readingState);
  const byId = new Map(skillNodes.map((n) => [n.id, n]));
  return (
    <Section title={`Recommended teacher observations (${obs.length})`}>
      {obs.length === 0 && (
        <Empty>
          No autonomous bypasses recorded. The student hasn't (yet) hit a
          teacher-led skill while drilling on their own.
        </Empty>
      )}
      {obs.length > 0 && (
        <Table
          cols={["node", "topic", "assessment", "reason", "ts"]}
          rows={obs
            .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
            .map((o) => {
              const def = byId.get(o.nodeId);
              return [
                <code>{o.nodeId}</code>,
                def?.topic || def?.skill || "—",
                <code>{def?.assessment || "—"}</code>,
                o.reason || "—",
                fmtDate(o.ts),
              ];
            })}
        />
      )}
    </Section>
  );
}

function Section({ title, children, action }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <h2 style={{ fontSize: 14, margin: 0 }}>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function ExportButton({ onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 11,
        padding: "3px 8px",
        border: "1px solid #ccc",
        background: "white",
        borderRadius: 4,
        cursor: "pointer",
        color: "#444",
      }}
    >
      ⤓ {children}
    </button>
  );
}

const SEVERITY_COLOR = {
  urgent: "#c33",
  attention: "#a72",
  watch: "#888",
};

function SeverityBadge({ severity }) {
  return (
    <span
      style={{
        flexShrink: 0,
        padding: "2px 7px",
        borderRadius: 999,
        background: SEVERITY_COLOR[severity] ?? "#888",
        color: "white",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        height: "fit-content",
        marginTop: 2,
      }}
    >
      {severity}
    </span>
  );
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function DebugWeeklyRecap() {
  const auth = useAuth?.() ?? {};
  return <WeeklyRecap studentId={auth.student?.id ?? null} />;
}

function DebugCognitiveProfile() {
  const auth = useAuth?.() ?? {};
  return <CognitiveProfileCard studentId={auth.student?.id ?? null} />;
}

function DebugActionQueue({ actions }) {
  const auth = useAuth?.() ?? {};
  const studentId = auth.student?.id ?? null;
  if (!studentId) {
    return (
      <div style={{ color: "#999", fontStyle: "italic" }}>
        sign in to mark actions complete (queue still computes locally)
      </div>
    );
  }
  return <ActionQueue actions={actions} studentId={studentId} />;
}

// In-memory cache so the same insight doesn't re-pay between renders.
const recCache = new Map();

function InsightRow({ insight }) {
  const [rec, setRec] = useState(() => recCache.get(insight.id) ?? null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  async function fetchRec() {
    if (loading) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/insight-recommendation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ insight }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = await res.json();
      const r = { text: json.recommendation, llmUsed: !!json.llmUsed };
      recCache.set(insight.id, r);
      setRec(r);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <li
      style={{
        display: "flex",
        gap: 10,
        padding: "8px 0",
        borderBottom: "1px solid #eee",
      }}
    >
      <SeverityBadge severity={insight.severity} />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{insight.headline}</div>
        <div style={{ color: "#666", fontSize: 12 }}>
          {insight.detail}
          {insight.nodeId && <> · <code className="ra-id">{insight.nodeId}</code></>}
        </div>
        {rec && (
          <div
            style={{
              marginTop: 6,
              padding: "8px 10px",
              background: "#f3f7fb",
              borderLeft: "3px solid #27a",
              borderRadius: 4,
              fontSize: 13,
              color: "#234",
            }}
          >
            <strong>Recommendation:</strong> {rec.text}
            <span style={{ marginLeft: 6, color: "#888", fontSize: 11 }}>
              ({rec.llmUsed ? "AI" : "template"})
            </span>
          </div>
        )}
        {err && (
          <div style={{ color: "#c33", fontSize: 12, marginTop: 4 }}>
            failed: {err}
          </div>
        )}
        {!rec && (
          <button
            type="button"
            onClick={fetchRec}
            disabled={loading}
            style={{
              marginTop: 6,
              fontSize: 11,
              padding: "3px 9px",
              border: "1px solid #ccc",
              background: "white",
              borderRadius: 4,
              cursor: loading ? "wait" : "pointer",
              color: "#444",
            }}
          >
            {loading ? "Thinking…" : "Get recommendation"}
          </button>
        )}
      </div>
    </li>
  );
}

function Tile({ label, value, sub }) {
  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 6,
        padding: 12,
        background: "white",
      }}
    >
      <div style={{ fontSize: 11, color: "#888" }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#888" }}>{sub}</div>}
    </div>
  );
}

function Empty({ children }) {
  return <div style={{ color: "#999", fontStyle: "italic" }}>{children}</div>;
}

function Table({ cols, rows }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c}
                style={{
                  textAlign: "left",
                  padding: "4px 8px",
                  borderBottom: "1px solid #ccc",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  color: "#888",
                  fontWeight: 500,
                }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #eee" }}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: "4px 8px", verticalAlign: "top" }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
