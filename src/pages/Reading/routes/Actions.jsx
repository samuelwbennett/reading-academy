// src/pages/Reading/routes/Actions.jsx
//
// /reading/actions — the cohort daily action sheet.
//
// What a teacher prints Monday morning. Reads every student row the
// signed-in user can see (RLS-scoped — until M12, that's themselves
// + any roster the launcher exposes), reconstructs each StudentModel
// from student_app_accounts.state.modelV2 (or legacy state.nodes),
// runs the cohort action engine, and renders a single page with
// print-friendly CSS.
//
// On screen: regular dashboard. On `@media print`: header + flat list,
// page-break-friendly.

import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import skillNodes from "../../../data/skill_nodes.json";
import { ROUTES } from "../../../config/routes.js";
import { useAuth } from "../../../lib/auth/AuthProvider.jsx";
import { supabase } from "../../../services/supabase.js";
import {
  generateCohortActions,
  todayMinutesEstimate,
  DEFAULT_COHORT_CONFIG,
} from "../../../lib/actions";
import ActionQueue from "../components/ActionQueue.jsx";

const APP_SLUG = "reading_academy";
const CAP_PRESETS = [
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
  { label: "45 min", value: 45 },
  { label: "60 min", value: 60 },
  { label: "Show all", value: null },
];

export default function Actions() {
  const { session, student, loading } = useAuth();
  const [students, setStudents] = useState([]);
  const [classes, setClasses] = useState([]);
  const [studentClassIds, setStudentClassIds] = useState({});
  const [classFilter, setClassFilter] = useState("all");
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [now] = useState(() => Date.now());
  const [dailyCap, setDailyCap] = useState(DEFAULT_COHORT_CONFIG.dailyCapacityMinutes);

  useEffect(() => {
    if (loading) return;
    if (!session?.user) {
      setStudents([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setFetching(true);
      setError(null);
      try {
        // 1. Fetch teacher's classes + memberships in parallel with the
        //    students/accounts query. Classes drive the filter dropdown
        //    and the per-student class tags.
        const [
          { data: classRows = [] },
          { data: app },
          { data: rows = [], error: rErr },
        ] = await Promise.all([
          supabase
            .from("teacher_classes")
            .select("id, name, grade_level, archived")
            .eq("teacher_user_id", session.user.id)
            .eq("archived", false)
            .order("name"),
          supabase
            .from("learning_apps")
            .select("id")
            .eq("slug", APP_SLUG)
            .maybeSingle(),
          supabase.from("students").select("id, display_name, grade_level"),
        ]);
        if (rErr) throw rErr;
        if (!cancelled) setClasses(classRows);

        const classIds = classRows.map((c) => c.id);
        const { data: memberships = [] } = classIds.length
          ? await supabase
              .from("class_memberships")
              .select("class_id, student_id")
              .in("class_id", classIds)
          : { data: [] };
        const studentToClasses = {};
        for (const m of memberships) {
          (studentToClasses[m.student_id] ||= []).push(m.class_id);
        }
        if (!cancelled) setStudentClassIds(studentToClasses);

        if (!app?.id) {
          if (!cancelled) setStudents([]);
          return;
        }
        const ids = rows.map((s) => s.id);
        if (ids.length === 0) {
          if (!cancelled) setStudents([]);
          return;
        }
        const { data: accounts = [] } = await supabase
          .from("student_app_accounts")
          .select("student_id, state")
          .eq("app_id", app.id)
          .in("student_id", ids);
        const accountByStudent = new Map(
          accounts.map((a) => [a.student_id, a.state || {}]),
        );
        const merged = rows.map((s) => {
          const state = accountByStudent.get(s.id) || {};
          // Prefer modelV2, fall back to a synthesized model from legacy state.
          const model = state.modelV2 || {
            schema: "student-model/v1",
            studentId: s.id,
            createdAt: 0,
            updatedAt: 0,
            nodes: state.nodes || {},
            fluency: {},
            global: {
              totalSessions: 0,
              totalItemsAttempted: 0,
              streakDays: 0,
              lastSessionDayUtc: null,
              dailyXp: 0,
              weeklyXp: 0,
            },
          };
          return {
            id: s.id,
            displayName: s.display_name || "Unnamed",
            gradeLevel: s.grade_level,
            model,
          };
        });
        if (!cancelled) setStudents(merged);
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id, loading]);

  const filteredStudents = useMemo(() => {
    if (classFilter === "all") return students;
    return students.filter((s) =>
      (studentClassIds[s.id] || []).includes(classFilter),
    );
  }, [students, studentClassIds, classFilter]);

  const { actions, summary } = useMemo(
    () =>
      generateCohortActions(filteredStudents, skillNodes, now, {
        dailyCapacityMinutes: dailyCap,
      }),
    [filteredStudents, now, dailyCap],
  );
  const todayMin = useMemo(() => todayMinutesEstimate(actions), [actions]);

  const todayActions = useMemo(
    () => actions.filter((a) => a.urgency === "today"),
    [actions],
  );
  const weekActions = useMemo(
    () => actions.filter((a) => a.urgency === "this_week"),
    [actions],
  );
  const monitorActions = useMemo(
    () => actions.filter((a) => a.urgency === "monitor"),
    [actions],
  );

  const dateLabel = new Date(now).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="ra-app">
      <PrintCss />
      <div className="ra-app-inner">
        <header className="ra-header no-print-hide">
          <Link to={ROUTES.READING} className="ra-header-back">
            ← Reading Academy
          </Link>
          <h1 className="ra-header-title">Action queue</h1>
          <p className="ra-header-status">
            What this class needs today. Print-friendly — Cmd/Ctrl+P.
          </p>
        </header>

        <div className="print-only print-header">
          <h1 style={{ margin: 0, fontSize: 22 }}>Reading Academy — Daily Actions</h1>
          <div style={{ color: "#444", fontSize: 12, marginTop: 4 }}>{dateLabel}</div>
        </div>

        {!session?.user && <SignedOutPanel />}
        {session?.user && fetching && (
          <p style={{ padding: 14, color: "#888" }}>Loading roster…</p>
        )}
        {session?.user && error && (
          <p style={{ padding: 14, color: "#c33" }}>Failed: {error}</p>
        )}

        {session?.user && !fetching && !error && students.length === 0 && (
          <NoRosterPanel hasClasses={classes.length > 0} />
        )}

        {session?.user && !fetching && !error && students.length > 0 && (
          <>
            <ClassFilter
              classes={classes}
              value={classFilter}
              onChange={setClassFilter}
              filteredCount={filteredStudents.length}
              totalCount={students.length}
            />
            <SummaryStrip summary={summary} todayMin={todayMin} />
            <CapToggle
              dailyCap={dailyCap}
              onChange={setDailyCap}
              summary={summary}
            />
            <NarrationCard
              actions={actions}
              context={{ dateLabel, classSize: filteredStudents.length }}
            />

            <Section
              title={`Today (${todayActions.length})`}
              subtitle={`~${todayMin} min focused teacher time`}
            >
              {todayActions.length === 0 ? (
                <Empty>nothing critical for today — quick win!</Empty>
              ) : (
                <ActionQueue actions={todayActions} cohort />
              )}
            </Section>

            <Section
              title={`This week (${weekActions.length})`}
              subtitle="Next 5 school days"
            >
              {weekActions.length === 0 ? (
                <Empty>no week-level actions queued</Empty>
              ) : (
                <ActionQueue actions={weekActions} cohort />
              )}
            </Section>

            <Section
              title={`Monitor (${monitorActions.length})`}
              subtitle="Watch — no action required yet"
            >
              {monitorActions.length === 0 ? (
                <Empty>nothing to monitor</Empty>
              ) : (
                <ActionQueue actions={monitorActions} cohort />
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, subtitle, children }) {
  return (
    <section
      className="ra-card"
      style={{ marginBottom: 16, pageBreakInside: "avoid" }}
    >
      <header style={{ marginBottom: 6 }}>
        <h2 className="ra-card-title" style={{ margin: 0 }}>{title}</h2>
        {subtitle && (
          <div className="ra-card-sub" style={{ marginTop: 2 }}>{subtitle}</div>
        )}
      </header>
      {children}
    </section>
  );
}

function Empty({ children }) {
  return (
    <div style={{ color: "#999", fontStyle: "italic", padding: "8px 0" }}>
      {children}
    </div>
  );
}

function SummaryStrip({ summary, todayMin }) {
  const todayLabel =
    summary.dailyCapacityMinutes != null &&
    summary.uncappedTodayMinutes > summary.dailyCapacityMinutes
      ? `${todayMin} / ${summary.uncappedTodayMinutes}`
      : `${todayMin}`;
  const cells = [
    { label: "Students", value: summary.studentsWithActions },
    { label: "Today", value: summary.todayCount },
    { label: "This week", value: summary.thisWeekCount },
    { label: "Monitor", value: summary.monitorCount },
    { label: "Today minutes", value: todayLabel },
  ];
  return (
    <section
      className="ra-card"
      style={{ marginBottom: 16 }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 10,
        }}
      >
        {cells.map((c) => (
          <div
            key={c.label}
            style={{
              border: "1px solid #eee",
              borderRadius: 6,
              padding: "8px 10px",
              background: "#fafafa",
            }}
          >
            <div
              style={{
                fontSize: 10,
                color: "#888",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {c.label}
            </div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{c.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ClassFilter({ classes, value, onChange, filteredCount, totalCount }) {
  if (classes.length === 0) return null;
  return (
    <section className="ra-card no-print-hide" style={{ marginBottom: 16, padding: "10px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, color: "#444" }}>
          <strong>Filter by class</strong>
        </div>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            fontSize: 13,
            padding: "5px 10px",
            border: "1px solid #ccc",
            borderRadius: 5,
            background: "white",
          }}
        >
          <option value="all">All classes ({totalCount} students)</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.grade_level || "—"})
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: "#888", marginLeft: "auto" }}>
          Showing {filteredCount} of {totalCount} students
        </span>
      </div>
    </section>
  );
}

function NoRosterPanel({ hasClasses }) {
  return (
    <section className="ra-card">
      <h2 className="ra-card-title">No students visible yet</h2>
      <p className="ra-card-sub">
        {hasClasses
          ? "You own classes, but no students are enrolled in them yet. Add some via the SQL block in the roster runbook."
          : "You don't own any classes yet. The Action Engine queues across the students you've been assigned. Create a class first."}
      </p>
      <div className="ra-actions" style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Link to="/reading/roster" className="ra-btn ra-btn-primary">
          Open roster
        </Link>
      </div>
      <p className="ra-card-sub" style={{ marginTop: 10, fontSize: 12 }}>
        Setup runbook: <code>docs/pilot/teacher-roster-setup.md</code>
      </p>
    </section>
  );
}

function SignedOutPanel() {
  return (
    <section className="ra-card">
      <h2 className="ra-card-title">Sign in to view the action queue</h2>
      <p className="ra-card-sub">
        Actions are derived from each student's M3 model. Sign in with the teacher
        email to load the roster.
      </p>
      <div className="ra-actions" style={{ marginTop: 14 }}>
        <Link to="/reading/signin" className="ra-btn ra-btn-primary">
          Go to sign-in
        </Link>
      </div>
    </section>
  );
}

function CapToggle({ dailyCap, onChange, summary }) {
  const overflow = summary.overflowedToWeek || 0;
  return (
    <section
      className="ra-card"
      style={{ marginBottom: 16, padding: "12px 16px" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 13, color: "#444" }}>
          <strong>Daily capacity</strong>
        </div>
        {CAP_PRESETS.map((p) => {
          const active = dailyCap === p.value;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => onChange(p.value)}
              style={{
                fontSize: 12,
                padding: "5px 10px",
                borderRadius: 5,
                cursor: "pointer",
                border: active ? "1px solid #27a" : "1px solid #ccc",
                background: active ? "#27a" : "white",
                color: active ? "white" : "#444",
              }}
            >
              {p.label}
            </button>
          );
        })}
        {dailyCap != null && overflow > 0 && (
          <span style={{ fontSize: 12, color: "#a72", marginLeft: "auto" }}>
            {overflow} action{overflow === 1 ? "" : "s"} bumped to this week to fit your {dailyCap}-min budget
          </span>
        )}
        {dailyCap != null && overflow === 0 && (
          <span style={{ fontSize: 12, color: "#888", marginLeft: "auto" }}>
            Today's actions fit within {dailyCap} min.
          </span>
        )}
        {dailyCap == null && (
          <span style={{ fontSize: 12, color: "#888", marginLeft: "auto" }}>
            Showing the full unfiltered today block.
          </span>
        )}
      </div>
    </section>
  );
}

function NarrationCard({ actions, context }) {
  const [paragraph, setParagraph] = useState(null);
  const [llmUsed, setLlmUsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/action-narration", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actions, context }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = await res.json();
      setParagraph(json.paragraph);
      setLlmUsed(!!json.llmUsed);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // Re-run when the action set changes meaningfully.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions.length, JSON.stringify(actions.map((a) => a.id))]);

  if (actions.length === 0) return null;

  return (
    <section className="ra-card" style={{ marginBottom: 16 }}>
      <div className="ra-eyebrow">Quick read</div>
      {loading && (
        <p className="ra-card-sub" style={{ marginTop: 4 }}>Generating overview…</p>
      )}
      {error && (
        <p className="ra-card-sub" style={{ marginTop: 4, color: "#c33" }}>
          Overview unavailable: {error}
        </p>
      )}
      {paragraph && (
        <>
          <p style={{ margin: "6px 0 8px", fontSize: 14, lineHeight: 1.5, color: "#222" }}>
            {paragraph}
          </p>
          <div style={{ fontSize: 11, color: "#999" }}>
            {llmUsed ? "AI-generated" : "deterministic template"} ·{" "}
            <button
              type="button"
              onClick={load}
              style={{
                background: "none",
                border: "none",
                color: "#27a",
                cursor: "pointer",
                padding: 0,
                fontSize: 11,
              }}
            >
              refresh
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function PrintCss() {
  return (
    <style>{`
      .print-only { display: none; }
      @media print {
        .no-print-hide, .ra-header, .ra-actions { display: none !important; }
        .print-only { display: block; margin-bottom: 12px; }
        body { background: white; }
        .ra-card { box-shadow: none; border: 1px solid #ccc; }
        a { color: black !important; text-decoration: none; }
      }
    `}</style>
  );
}
