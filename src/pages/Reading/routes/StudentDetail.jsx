// src/pages/Reading/routes/StudentDetail.jsx
//
// /reading/student/:studentId — teacher / admin per-student deep-dive.
//
// Loads the target student's state via Supabase (RLS allows read iff
// teacher_can_see_student). Reconstructs a StudentModel from
// student_app_accounts.state.modelV2 (or legacy state.nodes), then
// renders the same family of widgets the Debug page does — but for
// THAT student, not the signed-in user.
//
// Read-only. Action completions can be marked here too because
// reading_action_completions has RLS that lets teachers write for
// their roster (M12-B / 0004 migration).

import React, { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import skillNodes from "../../../data/skill_nodes.json";
import { ROUTES } from "../../../config/routes.js";
import { useAuth } from "../../../lib/auth/AuthProvider.jsx";
import { supabase } from "../../../services/supabase.js";
import { calculateForgettingRisk } from "../../../lib/mastery/masteryEngine";
import { buildReviewQueue } from "../../../lib/review/reviewScheduler";
import { planSession, flattenPlan } from "../../../lib/session/sessionPlanner";
import { generateInsights } from "../../../lib/insights";
import { generateActions } from "../../../lib/actions";
import FluencyChart from "../components/FluencyChart.jsx";
import ActionQueue from "../components/ActionQueue.jsx";

const APP_SLUG = "reading_academy";

const STATUS_COLORS = {
  locked: "#999",
  unlocked: "#7aa",
  active: "#2a7",
  practicing: "#a72",
  mastered_for_acquisition: "#27a",
  mastered: "#27a",
  in_automaticity_zone: "#52d",
  automatic: "#a4d",
  regressed: "#c33",
};

function buildModelFromState(state, studentId) {
  if (state?.modelV2) return state.modelV2;
  return {
    schema: "student-model/v1",
    studentId,
    createdAt: 0,
    updatedAt: 0,
    nodes: state?.nodes || {},
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
}

export default function StudentDetail() {
  const { studentId } = useParams();
  const { session, profile, loading } = useAuth();
  const [student, setStudent] = useState(null);
  const [model, setModel] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (loading) return;
    if (!session?.user) return;
    if (!studentId) return;
    let cancelled = false;
    (async () => {
      setFetching(true);
      setError(null);
      try {
        const [{ data: stRow, error: stErr }, { data: app }] = await Promise.all([
          supabase
            .from("students")
            .select("id, display_name, grade_level, auth_user_id")
            .eq("id", studentId)
            .maybeSingle(),
          supabase
            .from("learning_apps")
            .select("id")
            .eq("slug", APP_SLUG)
            .maybeSingle(),
        ]);
        if (stErr) throw stErr;
        if (!stRow) throw new Error("student not found or not visible to you");
        const appId = app?.id;
        const { data: account } = appId
          ? await supabase
              .from("student_app_accounts")
              .select("state, updated_at")
              .eq("student_id", studentId)
              .eq("app_id", appId)
              .maybeSingle()
          : { data: null };
        if (cancelled) return;
        setStudent(stRow);
        setModel(buildModelFromState(account?.state || {}, studentId));
        setUpdatedAt(account?.updated_at || null);
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [studentId, session?.user?.id, loading]);

  const reviewQueue = useMemo(
    () => (model ? buildReviewQueue(Object.values(model.nodes), now) : []),
    [model, now],
  );
  const plan = useMemo(
    () => (model ? planSession(model, skillNodes, undefined, now) : null),
    [model, now],
  );
  const insights = useMemo(
    () => (model ? generateInsights(model, skillNodes, undefined, now) : []),
    [model, now],
  );
  const actions = useMemo(
    () => (model ? generateActions(model, skillNodes, now) : []),
    [model, now],
  );

  const masteredFamily = new Set([
    "mastered",
    "mastered_for_acquisition",
    "in_automaticity_zone",
    "automatic",
  ]);
  const masteredCount = useMemo(() => {
    if (!model) return 0;
    let n = 0;
    for (const ns of Object.values(model.nodes)) if (masteredFamily.has(ns.status)) n += 1;
    return n;
  }, [model]);

  const isTeacherLike = profile?.role === "teacher" || profile?.role === "admin";

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", fontSize: 13 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <Link to={ROUTES.READING} style={{ fontSize: 12, color: "#666" }}>← Reading Academy</Link>
          <Link to="/reading/roster" style={{ fontSize: 12, color: "#666", marginLeft: 12 }}>← Roster</Link>
          <h1 style={{ margin: "8px 0 0" }}>
            {student?.display_name || "Student"}{" "}
            {student?.grade_level && (
              <span style={{ fontSize: 13, color: "#666", fontWeight: 400 }}>
                · grade {student.grade_level}
              </span>
            )}
          </h1>
          <p style={{ color: "#666", marginTop: 4 }}>
            {studentId}
            {updatedAt && (
              <> · last updated {new Date(updatedAt).toISOString().slice(0, 16).replace("T", " ")}</>
            )}
          </p>
        </div>
      </header>

      {!isTeacherLike && (
        <p style={{ color: "#a72", marginTop: 16 }}>
          Your account isn't a teacher / admin — RLS still scopes reads, but this
          page is intended for teachers managing a roster.
        </p>
      )}

      {fetching && <p style={{ color: "#888", marginTop: 16 }}>Loading…</p>}
      {error && (
        <p style={{ color: "#c33", marginTop: 16 }}>
          {error}
        </p>
      )}

      {!fetching && !error && model && (
        <>
          <SummaryStrip
            masteredCount={masteredCount}
            reviewsDue={reviewQueue.length}
            insightCount={insights.length}
            todayCount={actions.filter((a) => a.urgency === "today").length}
          />

          <Section title={`Action queue (${actions.length})`}>
            <ActionQueue
              actions={actions}
              studentId={studentId}
              title={`For ${student?.display_name || "this student"}`}
            />
          </Section>

          <Section title={`Insights (${insights.length})`}>
            {insights.length === 0 ? (
              <Empty>no insights right now — they're on track.</Empty>
            ) : (
              <ul style={{ marginTop: 0, paddingLeft: 0, listStyle: "none" }}>
                {insights.map((i) => (
                  <li
                    key={i.id}
                    style={{
                      display: "flex",
                      gap: 10,
                      padding: "8px 0",
                      borderBottom: "1px solid #eee",
                    }}
                  >
                    <span
                      style={{
                        flexShrink: 0,
                        padding: "2px 7px",
                        borderRadius: 999,
                        background:
                          i.severity === "urgent"
                            ? "#c33"
                            : i.severity === "attention"
                            ? "#a72"
                            : "#888",
                        color: "white",
                        fontSize: 10,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                        height: "fit-content",
                        marginTop: 2,
                      }}
                    >
                      {i.severity}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{i.headline}</div>
                      <div style={{ color: "#666", fontSize: 12 }}>{i.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Today's plan">
            {!plan || plan.empty ? (
              <Empty>nothing planned</Empty>
            ) : (
              <ol style={{ marginTop: 0 }}>
                {flattenPlan(plan).map((intent, i) => (
                  <li key={i}>
                    <strong>{intent.kind}</strong>
                    {intent.nodeId && <> · {intent.nodeId}</>}
                    {intent.gateId && <> · {intent.gateId}</>}
                    <span style={{ color: "#888" }}> ({intent.reason})</span>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section title="Fluency gates">
            {Object.values(model.fluency).filter(Boolean).length === 0 ? (
              <Empty>no passage attempts yet</Empty>
            ) : (
              Object.values(model.fluency).filter(Boolean).map((f) => (
                <div key={f.gateId} style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
                    {f.gateId} · cold {Math.round(f.coldWcpm)} WCPM · accuracy{" "}
                    {Math.round((f.accuracyRate ?? 0) * 100)}% · {f.passageAttempts} attempts
                  </div>
                  <FluencyChart history={f.history} personalBest={f.coldWcpm} />
                </div>
              ))
            )}
          </Section>

          <Section title={`All nodes (${skillNodes.length})`}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    {["nodeId", "status", "attempts", "accuracy", "latency", "risk"].map((c) => (
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
                  {skillNodes.map((def) => {
                    const ns = model.nodes[def.id];
                    const status = ns?.status ?? "locked";
                    const risk = ns ? calculateForgettingRisk(ns, now) : 0;
                    return (
                      <tr key={def.id} style={{ borderBottom: "1px solid #eee" }}>
                        <td style={{ padding: "4px 8px" }}>{def.id}</td>
                        <td style={{ padding: "4px 8px" }}>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "1px 6px",
                              borderRadius: 4,
                              background: STATUS_COLORS[status] ?? "#666",
                              color: "white",
                              fontSize: 11,
                            }}
                          >
                            {status}
                          </span>
                        </td>
                        <td style={{ padding: "4px 8px" }}>{ns?.attempts ?? 0}</td>
                        <td style={{ padding: "4px 8px" }}>
                          {Math.round((ns?.rollingAccuracy ?? 0) * 100)}%
                        </td>
                        <td style={{ padding: "4px 8px" }}>
                          {Math.round(ns?.rollingLatencyMs ?? 0)} ms
                        </td>
                        <td style={{ padding: "4px 8px" }}>
                          {risk >= 0.7 ? "🔴 " : risk >= 0.4 ? "🟡 " : "🟢 "}
                          {Math.round(risk * 100)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 14, marginBottom: 8 }}>{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }) {
  return <div style={{ color: "#999", fontStyle: "italic" }}>{children}</div>;
}

function SummaryStrip({ masteredCount, reviewsDue, insightCount, todayCount }) {
  const cells = [
    { label: "Mastered nodes", value: masteredCount },
    { label: "Reviews due", value: reviewsDue },
    { label: "Insights", value: insightCount },
    { label: "Today actions", value: todayCount },
  ];
  return (
    <section
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 12,
        margin: "16px 0",
      }}
    >
      {cells.map((c) => (
        <div
          key={c.label}
          style={{
            border: "1px solid #ddd",
            borderRadius: 6,
            padding: 12,
            background: "white",
          }}
        >
          <div style={{ fontSize: 11, color: "#888" }}>{c.label}</div>
          <div style={{ fontSize: 28, fontWeight: 600 }}>{c.value}</div>
        </div>
      ))}
    </section>
  );
}
