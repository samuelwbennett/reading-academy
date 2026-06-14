// src/pages/Reading/routes/Roster.jsx
//
// Teacher roster — pilot-ready (M12-C).
//
// Reads the signed-in user's classes from teacher_classes (RLS scopes
// to owner) and the students in each class via class_memberships.
// Loads each student's account state to surface mastered count, last
// activity, current frontier node, and live action count.
//
// Data flow:
//   1. teacher_classes (owned by auth.uid())
//   2. class_memberships (RLS allows owner read)
//   3. students (RLS allows teacher_can_see_student)
//   4. student_app_accounts (RLS allows teacher_can_see_student, read-only)
//   5. reading_action_completions (filter active actions only)
//
// All five queries run in parallel-then-merge. Empty states cover
// the cases that matter for a real classroom: no classes, empty
// class, no app data yet for a student.

import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import skillNodes from "../../../data/skill_nodes.json";
import { useAuth } from "../../../lib/auth/AuthProvider.jsx";
import { supabase } from "../../../services/supabase.js";
import { generateActions } from "../../../lib/actions";
import { ROUTES } from "../../../config/routes.js";
import { parseCsv } from "../../../lib/dashboard/csvParse";
import { toCsv, downloadCsv } from "../../../lib/dashboard/csv";

const APP_SLUG = "reading_academy";
const ACTIVE_DAYS = 7; // "active" within the last week

const STATUS_COLORS = {
  on_track: { bg: "#bfe1c7", fg: "#143", label: "On track" },
  needs_review: { bg: "#fae3c1", fg: "#542", label: "Needs review" },
  at_risk: { bg: "#f4c5c5", fg: "#411", label: "At risk" },
  inactive: { bg: "#e5e5e5", fg: "#444", label: "Inactive" },
  unstarted: { bg: "#e6f0fa", fg: "#246", label: "Not started" },
};

function classifyStudent(model, lastUpdated) {
  // Three signals roll up into a single status pill.
  const nodeCount = Object.keys(model.nodes || {}).length;
  if (nodeCount === 0) return "unstarted";
  const idleDays = lastUpdated
    ? (Date.now() - new Date(lastUpdated).getTime()) / 86_400_000
    : Infinity;
  if (idleDays > 14) return "inactive";

  const masteredFamily = new Set([
    "mastered",
    "mastered_for_acquisition",
    "in_automaticity_zone",
    "automatic",
  ]);
  let mastered = 0;
  let regressed = 0;
  for (const ns of Object.values(model.nodes || {})) {
    if (masteredFamily.has(ns?.status)) mastered += 1;
    if (ns?.status === "regressed") regressed += 1;
  }
  if (regressed > 0 || idleDays > ACTIVE_DAYS) return "needs_review";
  if (mastered === 0 && nodeCount > 3) return "at_risk";
  return "on_track";
}

function buildModelFromState(state) {
  // The cohort engine needs a StudentModel-shaped object. Use modelV2
  // when present; synthesize a minimal one from legacy state.nodes
  // otherwise so the action engine has something to chew on.
  if (state?.modelV2) return state.modelV2;
  return {
    schema: "student-model/v1",
    studentId: null,
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

function pickActiveNodeId(model) {
  // Mirrors sessionPlanner's pickActiveNode. We don't import it here
  // to keep the bundle slim; it's a 6-line predicate.
  const masteredStates = new Set([
    "mastered",
    "mastered_for_acquisition",
    "in_automaticity_zone",
    "automatic",
  ]);
  const isUnlocked = (def) =>
    (def.prereqs || []).every((p) => masteredStates.has(model.nodes?.[p]?.status));
  for (const def of skillNodes) {
    if (def.assessment === "cold_passage") continue;
    const status = model.nodes?.[def.id]?.status || "locked";
    if (
      (status === "active" || status === "practicing" || status === "unlocked") &&
      isUnlocked(def)
    ) {
      return def.id;
    }
  }
  return null;
}

export default function Roster() {
  const { session, profile, loading } = useAuth();
  const [classes, setClasses] = useState([]);
  const [archivedClasses, setArchivedClasses] = useState([]);
  const [studentsByClass, setStudentsByClass] = useState({});
  const [allVisibleStudents, setAllVisibleStudents] = useState([]);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [now] = useState(() => Date.now());
  const [reloadTick, setReloadTick] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const reload = () => setReloadTick((t) => t + 1);

  useEffect(() => {
    if (loading) return;
    if (!session?.user) {
      setClasses([]);
      setStudentsByClass({});
      return;
    }
    let cancelled = false;
    (async () => {
      setFetching(true);
      setError(null);
      try {
        // 1. Fetch ALL of the teacher's classes (archived + active);
        //    we split locally so the toggle is purely client-side.
        const { data: allClasses = [], error: cErr } = await supabase
          .from("teacher_classes")
          .select("id, name, grade_level, archived, created_at")
          .eq("teacher_user_id", session.user.id)
          .order("name");
        if (cErr) throw cErr;
        const classRows = allClasses.filter((c) => !c.archived);
        const archivedRows = allClasses.filter((c) => c.archived);
        if (!cancelled) {
          setClasses(classRows);
          setArchivedClasses(archivedRows);
        }
        if (classRows.length === 0 && archivedRows.length === 0) {
          if (!cancelled) {
            setStudentsByClass({});
            setAllVisibleStudents([]);
          }
          return;
        }

        // 2. Fetch memberships for active classes.
        const classIds = classRows.map((c) => c.id);
        const { data: memberships = [], error: mErr } = classIds.length
          ? await supabase
              .from("class_memberships")
              .select("class_id, student_id, joined_at")
              .in("class_id", classIds)
          : { data: [] };
        if (mErr) throw mErr;
        const studentIds = Array.from(new Set(memberships.map((m) => m.student_id)));
        if (studentIds.length === 0) {
          if (!cancelled) {
            setStudentsByClass(
              Object.fromEntries(classRows.map((c) => [c.id, []])),
            );
          }
          return;
        }

        // 3. Fetch student rows + app accounts + active actions in parallel.
        const { data: app } = await supabase
          .from("learning_apps")
          .select("id")
          .eq("slug", APP_SLUG)
          .maybeSingle();
        const appId = app?.id;

        const [
          { data: students = [], error: sErr },
          { data: accounts = [], error: aErr },
          { data: completions = [] },
        ] = await Promise.all([
          supabase
            .from("students")
            .select("id, display_name, grade_level")
            .in("id", studentIds),
          appId
            ? supabase
                .from("student_app_accounts")
                .select("student_id, state, updated_at")
                .eq("app_id", appId)
                .in("student_id", studentIds)
            : Promise.resolve({ data: [] }),
          supabase
            .from("reading_action_completions")
            .select("student_id, action_id, status")
            .in("student_id", studentIds),
        ]);
        if (sErr) throw sErr;
        if (aErr) throw aErr;

        // Index everything by student id for O(1) lookups.
        const studentById = new Map(students.map((s) => [s.id, s]));
        const accountById = new Map(accounts.map((a) => [a.student_id, a]));
        const completionsByStudent = {};
        for (const c of completions) {
          if (!completionsByStudent[c.student_id]) completionsByStudent[c.student_id] = new Set();
          if (c.status === "completed" || c.status === "skipped" || c.status === "dismissed") {
            completionsByStudent[c.student_id].add(c.action_id);
          }
        }

        // 4. Bucket students under their class(es).
        const buckets = {};
        for (const cls of classRows) buckets[cls.id] = [];
        for (const m of memberships) {
          const s = studentById.get(m.student_id);
          if (!s) continue;
          const account = accountById.get(s.id);
          const state = account?.state || {};
          const model = buildModelFromState(state);
          const status = classifyStudent(model, account?.updated_at);
          const activeNodeId = pickActiveNodeId(model);
          const def = activeNodeId ? skillNodes.find((n) => n.id === activeNodeId) : null;
          const completed = completionsByStudent[s.id] || new Set();
          const allActions = generateActions(model, skillNodes, now);
          const openActions = allActions.filter((a) => !completed.has(a.id));
          const masteredFamily = new Set([
            "mastered",
            "mastered_for_acquisition",
            "in_automaticity_zone",
            "automatic",
          ]);
          let mastered = 0;
          for (const ns of Object.values(model.nodes || {})) {
            if (masteredFamily.has(ns?.status)) mastered += 1;
          }
          buckets[m.class_id].push({
            id: s.id,
            displayName: s.display_name || "Unnamed",
            gradeLevel: s.grade_level,
            status,
            mastered,
            activeNodeLabel: def?.topic || def?.skill || activeNodeId || "—",
            actionCounts: {
              today: openActions.filter((a) => a.urgency === "today").length,
              total: openActions.length,
            },
            lastUpdated: account?.updated_at || null,
          });
        }
        // Stable sort within class.
        for (const id of classIds) buckets[id].sort((x, y) => x.displayName.localeCompare(y.displayName));
        if (!cancelled) setStudentsByClass(buckets);

        // Build a flat de-duped list of every student the teacher
        // can currently see — used by the "Enroll existing student"
        // picker on each class card.
        if (!cancelled) {
          const seen = new Set();
          const flat = [];
          for (const list of Object.values(buckets)) {
            for (const s of list) {
              if (seen.has(s.id)) continue;
              seen.add(s.id);
              flat.push({ id: s.id, displayName: s.displayName, gradeLevel: s.gradeLevel });
            }
          }
          flat.sort((a, b) => a.displayName.localeCompare(b.displayName));
          setAllVisibleStudents(flat);
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id, loading, now, reloadTick]);

  const totals = useMemo(() => {
    let students = 0;
    let todayActions = 0;
    for (const cls of classes) {
      const list = studentsByClass[cls.id] || [];
      students += list.length;
      for (const s of list) todayActions += s.actionCounts.today;
    }
    return { students, todayActions };
  }, [classes, studentsByClass]);

  return (
    <div className="ra-app">
      <div className="ra-app-inner">
        <header className="ra-header">
          <Link to={ROUTES.READING} className="ra-header-back">
            ← Reading Academy
          </Link>
          <h1 className="ra-header-title">Roster</h1>
          <p className="ra-header-status">
            Your classes and the students in them. RLS-scoped — only the rows you own.
          </p>
        </header>

        {!session?.user && <SignedOutPanel />}
        {session?.user && fetching && (
          <p style={{ padding: 14, color: "#888" }}>Loading roster…</p>
        )}
        {session?.user && error && (
          <ErrorPanel message={error} />
        )}

        {session?.user && !fetching && !error && (
          <>
            {classes.length > 0 && (
              <SummaryCard
                classCount={classes.length}
                studentCount={totals.students}
                todayActions={totals.todayActions}
              />
            )}
            <NewClassCard
              teacherUserId={session.user.id}
              isTeacher={profile?.role === "teacher" || profile?.role === "admin"}
              onCreated={reload}
            />
            {classes.length === 0 && archivedClasses.length === 0 && (
              <NoClassesPanel />
            )}
            {classes.map((cls) => (
              <ClassCard
                key={cls.id}
                cls={cls}
                students={studentsByClass[cls.id] || []}
                allVisibleStudents={allVisibleStudents}
                accessToken={session.access_token}
                onChanged={reload}
              />
            ))}
            {archivedClasses.length > 0 && (
              <ArchivedClassesSection
                classes={archivedClasses}
                showArchived={showArchived}
                onToggle={() => setShowArchived((v) => !v)}
                onChanged={reload}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---- subcomponents ----

function SummaryCard({ classCount, studentCount, todayActions }) {
  const cells = [
    { label: "Classes", value: classCount },
    { label: "Students", value: studentCount },
    { label: "Today actions", value: todayActions },
  ];
  return (
    <section className="ra-card" style={{ marginBottom: 16 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
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
            <div style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>
              {c.label}
            </div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{c.value}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: "#888" }}>
        See all queued interventions on{" "}
        <Link to="/reading/actions" className="ra-link">the action queue</Link>.
      </div>
    </section>
  );
}

function ClassCard({ cls, students, allVisibleStudents = [], accessToken, onChanged }) {
  // Students who exist in the roster but aren't in THIS class are
  // candidates for the "Enroll existing student" picker.
  const enrolledIds = new Set(students.map((s) => s.id));
  const candidates = allVisibleStudents.filter((s) => !enrolledIds.has(s.id));

  return (
    <section className="ra-card" style={{ marginBottom: 16 }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div>
          <h2 className="ra-card-title" style={{ margin: 0 }}>{cls.name}</h2>
          <div className="ra-card-sub" style={{ marginTop: 2 }}>
            Grade {cls.grade_level || "—"} &middot; {students.length} student{students.length === 1 ? "" : "s"}
          </div>
        </div>
        <ClassControls cls={cls} onChanged={onChanged} />
      </header>
      {/* M16-L6: passwordless login setup — class code + roster print */}
      <PasswordlessLoginPanel
        cls={cls}
        students={students}
        accessToken={accessToken}
        onChanged={onChanged}
      />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <AddStudentForm classId={cls.id} accessToken={accessToken} onCreated={onChanged} inline />
        <BulkAddForm classId={cls.id} accessToken={accessToken} onChanged={onChanged} />
        {candidates.length > 0 && (
          <EnrollExistingForm
            classId={cls.id}
            candidates={candidates}
            onEnrolled={onChanged}
          />
        )}
      </div>
      {students.length === 0 ? (
        <div style={{ marginTop: 12, color: "#999", fontStyle: "italic" }}>
          No students enrolled yet. Use the form above to add one.
        </div>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <thead>
              <tr>
                {["name", "status", "mastered", "current frontier", "today actions", "last updated", ""].map((c) => (
                  <th
                    key={c}
                    style={{
                      textAlign: "left",
                      padding: "6px 10px",
                      borderBottom: "1px solid #ddd",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      color: "#888",
                    }}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <StudentRow
                  key={s.id}
                  student={s}
                  classId={cls.id}
                  accessToken={accessToken}
                  onChanged={onChanged}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StudentRow({ student, classId, accessToken, onChanged }) {
  const colors = STATUS_COLORS[student.status] || STATUS_COLORS.unstarted;
  return (
    <tr style={{ borderBottom: "1px solid #eee" }}>
      <td style={{ padding: "8px 10px" }}>
        <Link to={`/reading/student/${student.id}`} className="ra-link">
          {student.displayName}
        </Link>
      </td>
      <td style={{ padding: "8px 10px" }}>
        <span
          style={{
            background: colors.bg,
            color: colors.fg,
            border: `1px solid ${colors.fg}33`,
            padding: "2px 8px",
            borderRadius: 999,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {colors.label}
        </span>
      </td>
      <td style={{ padding: "8px 10px" }}>{student.mastered}</td>
      <td style={{ padding: "8px 10px" }}>{student.activeNodeLabel}</td>
      <td style={{ padding: "8px 10px" }}>
        {student.actionCounts.today === 0 ? (
          <span style={{ color: "#888" }}>0</span>
        ) : (
          <strong>{student.actionCounts.today}</strong>
        )}
        {student.actionCounts.total > student.actionCounts.today && (
          <span style={{ color: "#888", fontSize: 11, marginLeft: 6 }}>
            (+{student.actionCounts.total - student.actionCounts.today} later)
          </span>
        )}
      </td>
      <td style={{ padding: "8px 10px", fontSize: 12, color: "#666" }}>
        {student.lastUpdated
          ? new Date(student.lastUpdated).toISOString().slice(0, 16).replace("T", " ")
          : "—"}
      </td>
      <td style={{ padding: "8px 10px" }}>
        <StudentRowControls
          student={student}
          classId={classId}
          accessToken={accessToken}
          onChanged={onChanged}
        />
      </td>
    </tr>
  );
}

function EnrollExistingForm({ classId, candidates, onEnrolled }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    const { error: insErr } = await supabase
      .from("class_memberships")
      .insert({ class_id: classId, student_id: selected });
    setBusy(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    setSelected("");
    setOpen(false);
    onEnrolled?.();
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          fontSize: 12,
          padding: "4px 10px",
          border: "1px solid #ccc",
          background: "white",
          borderRadius: 5,
          cursor: "pointer",
          color: "#444",
        }}
      >
        {open ? "Cancel" : "+ Enroll existing student"}
      </button>
      {open && (
        <form
          onSubmit={submit}
          style={{
            marginTop: 8,
            padding: 12,
            background: "#f7f9fb",
            borderRadius: 6,
            display: "grid",
            gap: 8,
            minWidth: 260,
          }}
        >
          <label className="ra-form-label" style={{ fontSize: 12 }}>
            Student already in your roster
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="ra-form-input"
            >
              <option value="">— pick a student —</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                  {c.gradeLevel ? ` (grade ${c.gradeLevel})` : ""}
                </option>
              ))}
            </select>
          </label>
          <div>
            <button
              type="submit"
              className="ra-btn ra-btn-primary"
              disabled={busy || !selected}
              style={{ fontSize: 12, padding: "4px 12px" }}
            >
              {busy ? "Enrolling…" : "Enroll"}
            </button>
          </div>
          {error && <div style={{ color: "#c33", fontSize: 12 }}>Failed: {error}</div>}
          <div style={{ fontSize: 11, color: "#888" }}>
            A student can be in multiple classes; each enrollment is independent.
          </div>
        </form>
      )}
    </div>
  );
}

function BulkAddForm({ classId, accessToken, onChanged }) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!accessToken) {
      setError("missing access token — sign in again");
      return;
    }
    let rows;
    try {
      rows = parseCsv(csv);
    } catch (err) {
      setError(`CSV parse failed: ${err.message || err}`);
      return;
    }
    const students = rows
      .map((r) => ({
        displayName: r.display_name || r.name || r["display name"] || "",
        gradeLevel: r.grade_level || r.grade || r["grade level"] || null,
      }))
      .filter((r) => r.displayName);
    if (students.length === 0) {
      setError("no rows with a display_name column");
      return;
    }
    if (students.length > 50) {
      setError("max 50 rows per batch");
      return;
    }
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch("/api/bulk-provision-students", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ classId, students }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 207) {
        setError(json?.error || `status ${res.status}`);
        return;
      }
      setResults(json);
      onChanged?.();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  function downloadResultsCsv() {
    if (!results?.results) return;
    const rows = results.results.map((r) => ({
      display_name: r.displayName,
      ok: r.ok ? "yes" : "no",
      student_id: r.studentId || "",
      invite_url: r.inviteUrl || "",
      expires_at: r.expiresAt || "",
      error: r.error || "",
    }));
    downloadCsv(`reading-academy-invites-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          fontSize: 12,
          padding: "4px 10px",
          border: "1px solid #ccc",
          background: "white",
          borderRadius: 5,
          cursor: "pointer",
          color: "#444",
        }}
      >
        {open ? "Cancel bulk add" : "+ Bulk add (CSV)"}
      </button>
      {open && (
        <form
          onSubmit={submit}
          style={{
            marginTop: 8,
            padding: 12,
            background: "#f7f9fb",
            borderRadius: 6,
            display: "grid",
            gap: 8,
            minWidth: 320,
          }}
        >
          <label className="ra-form-label" style={{ fontSize: 12 }}>
            Paste CSV (header row required)
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={6}
              placeholder={"display_name,grade_level\nAlice S.,K\nBob T.,K"}
              className="ra-form-input"
              style={{ fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
            />
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="submit"
              className="ra-btn ra-btn-primary"
              disabled={busy}
              style={{ fontSize: 12, padding: "4px 12px" }}
            >
              {busy ? "Provisioning…" : "Create + invite"}
            </button>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = () => setCsv(String(reader.result || ""));
                reader.readAsText(f);
              }}
              style={{ fontSize: 11 }}
            />
          </div>
          {error && <div style={{ color: "#c33", fontSize: 12 }}>Failed: {error}</div>}
          {results && (
            <div
              style={{
                marginTop: 6,
                padding: 8,
                background: "white",
                borderRadius: 5,
                border: "1px solid #cde0f0",
                fontSize: 12,
              }}
            >
              <strong>
                {results.summary.created} created
                {results.summary.failed > 0 && ` · ${results.summary.failed} failed`}
                {results.summary.enrolled > 0 && ` · ${results.summary.enrolled} enrolled`}
              </strong>
              <button
                type="button"
                onClick={downloadResultsCsv}
                style={{
                  display: "block",
                  marginTop: 6,
                  fontSize: 11,
                  padding: "3px 8px",
                  border: "1px solid #ccc",
                  background: "white",
                  borderRadius: 4,
                  cursor: "pointer",
                  color: "#444",
                }}
              >
                ⤓ Download invite-URL CSV
              </button>
              <div style={{ fontSize: 11, color: "#666", marginTop: 6 }}>
                Mail-merge the downloaded CSV — each row has a single-use invite_url.
              </div>
            </div>
          )}
        </form>
      )}
    </div>
  );
}

function ArchivedClassesSection({ classes, showArchived, onToggle, onChanged }) {
  return (
    <section className="ra-card" style={{ marginBottom: 16 }}>
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <h2 className="ra-card-title" style={{ margin: 0 }}>
          Archived classes ({classes.length})
        </h2>
        <button
          type="button"
          onClick={onToggle}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            border: "1px solid #ccc",
            background: "white",
            borderRadius: 5,
            cursor: "pointer",
          }}
        >
          {showArchived ? "Hide" : "Show"}
        </button>
      </header>
      {showArchived && (
        <ul style={{ marginTop: 12, paddingLeft: 0, listStyle: "none" }}>
          {classes.map((cls) => (
            <ArchivedClassRow key={cls.id} cls={cls} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ArchivedClassRow({ cls, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(0);

  async function unarchive() {
    setBusy(true);
    const { error } = await supabase
      .from("teacher_classes")
      .update({ archived: false, updated_at: new Date().toISOString() })
      .eq("id", cls.id);
    setBusy(false);
    if (error) {
      alert(`Unarchive failed: ${error.message}`);
      return;
    }
    onChanged?.();
  }

  async function destroy() {
    if (confirmDelete < 2) {
      setConfirmDelete((n) => n + 1);
      setTimeout(() => setConfirmDelete(0), 5000);
      return;
    }
    setBusy(true);
    const { error } = await supabase
      .from("teacher_classes")
      .delete()
      .eq("id", cls.id);
    setBusy(false);
    if (error) {
      alert(`Delete failed: ${error.message}`);
      return;
    }
    onChanged?.();
  }

  const deleteLabel =
    confirmDelete === 0
      ? "Delete"
      : confirmDelete === 1
      ? "Click again to confirm"
      : "Click ONCE more to delete forever";

  return (
    <li
      style={{
        display: "flex",
        gap: 12,
        alignItems: "baseline",
        padding: "8px 0",
        borderBottom: "1px solid #eee",
      }}
    >
      <div style={{ flex: 1 }}>
        <strong>{cls.name}</strong>{" "}
        <span style={{ color: "#888", fontSize: 12 }}>
          grade {cls.grade_level || "—"} · archived
        </span>
      </div>
      <button
        type="button"
        onClick={unarchive}
        disabled={busy}
        style={{
          fontSize: 12,
          padding: "4px 10px",
          border: "1px solid #27a",
          color: "#27a",
          background: "white",
          borderRadius: 5,
          cursor: "pointer",
        }}
      >
        Unarchive
      </button>
      <button
        type="button"
        onClick={destroy}
        disabled={busy}
        style={{
          fontSize: 12,
          padding: "4px 10px",
          border: "1px solid #c33",
          color: confirmDelete > 0 ? "white" : "#c33",
          background: confirmDelete > 0 ? "#c33" : "white",
          borderRadius: 5,
          cursor: "pointer",
        }}
        title="Permanently deletes the class + its memberships. Student records survive."
      >
        {deleteLabel}
      </button>
    </li>
  );
}

function ClassControls({ cls, onChanged }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(cls.name);
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  async function rename(e) {
    e.preventDefault();
    if (!name.trim() || name.trim() === cls.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    const { error } = await supabase
      .from("teacher_classes")
      .update({ name: name.trim(), updated_at: new Date().toISOString() })
      .eq("id", cls.id);
    setBusy(false);
    if (error) {
      alert(`Rename failed: ${error.message}`);
      return;
    }
    setRenaming(false);
    onChanged?.();
  }

  async function archive() {
    if (!confirmArchive) {
      setConfirmArchive(true);
      setTimeout(() => setConfirmArchive(false), 4000);
      return;
    }
    setBusy(true);
    const { error } = await supabase
      .from("teacher_classes")
      .update({ archived: true, updated_at: new Date().toISOString() })
      .eq("id", cls.id);
    setBusy(false);
    if (error) {
      alert(`Archive failed: ${error.message}`);
      return;
    }
    onChanged?.();
  }

  if (renaming) {
    return (
      <form onSubmit={rename} style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          autoFocus
          style={{
            fontSize: 13,
            padding: "4px 8px",
            border: "1px solid #ccc",
            borderRadius: 4,
          }}
        />
        <button type="submit" className="ra-btn ra-btn-primary" disabled={busy} style={{ fontSize: 12, padding: "4px 10px" }}>
          Save
        </button>
        <button type="button" onClick={() => { setRenaming(false); setName(cls.name); }} style={CtrlBtn}>
          Cancel
        </button>
      </form>
    );
  }
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <button type="button" onClick={() => setRenaming(true)} style={CtrlBtn}>Rename</button>
      <button
        type="button"
        onClick={archive}
        disabled={busy}
        style={{
          ...CtrlBtn,
          color: confirmArchive ? "white" : "#a72",
          background: confirmArchive ? "#a72" : "white",
          borderColor: "#a72",
        }}
      >
        {confirmArchive ? "Click again to confirm" : "Archive"}
      </button>
    </div>
  );
}

function StudentRowControls({ student, classId, accessToken, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [inviteUrl, setInviteUrl] = useState(null);
  const [inviteError, setInviteError] = useState(null);
  const [copied, setCopied] = useState(false);

  async function invite() {
    if (!accessToken) {
      setInviteError("missing access token — sign in again");
      return;
    }
    setBusy(true);
    setInviteError(null);
    try {
      const res = await fetch("/api/create-student-invite", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ studentId: student.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInviteError(json?.error || `status ${res.status}`);
        return;
      }
      setInviteUrl(json.inviteUrl);
    } catch (err) {
      setInviteError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  async function remove() {
    if (!confirmRemove) {
      setConfirmRemove(true);
      setTimeout(() => setConfirmRemove(false), 4000);
      return;
    }
    setBusy(true);
    const { error } = await supabase
      .from("class_memberships")
      .delete()
      .eq("class_id", classId)
      .eq("student_id", student.id);
    setBusy(false);
    if (error) {
      alert(`Remove failed: ${error.message}`);
      return;
    }
    onChanged?.();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" onClick={invite} disabled={busy} style={CtrlBtn}>
          {busy ? "…" : "Invite"}
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          style={{
            ...CtrlBtn,
            color: confirmRemove ? "white" : "#c33",
            background: confirmRemove ? "#c33" : "white",
            borderColor: "#c33",
          }}
        >
          {confirmRemove ? "Confirm" : "Remove"}
        </button>
      </div>
      {inviteUrl && (
        <div
          style={{
            fontSize: 11,
            background: "#f3f7fb",
            padding: "4px 8px",
            borderRadius: 4,
            border: "1px solid #cde0f0",
            maxWidth: 360,
          }}
        >
          <div style={{ wordBreak: "break-all", color: "#234" }}>{inviteUrl}</div>
          <button
            type="button"
            onClick={copyInvite}
            style={{ ...CtrlBtn, marginTop: 4, fontSize: 10 }}
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
        </div>
      )}
      {inviteError && (
        <div style={{ fontSize: 11, color: "#c33" }}>{inviteError}</div>
      )}
    </div>
  );
}

const CtrlBtn = {
  fontSize: 11,
  padding: "3px 8px",
  border: "1px solid #ccc",
  background: "white",
  borderRadius: 4,
  cursor: "pointer",
  color: "#444",
};

function SignedOutPanel() {
  return (
    <section className="ra-card">
      <h2 className="ra-card-title">Sign in to view the roster</h2>
      <p className="ra-card-sub">
        The roster is RLS-gated. Sign in with the teacher email to see the
        classes and students assigned to this account.
      </p>
      <div className="ra-actions" style={{ marginTop: 14 }}>
        <Link to="/reading/signin" className="ra-btn ra-btn-primary">
          Go to sign-in
        </Link>
      </div>
    </section>
  );
}

function NoClassesPanel() {
  return (
    <section className="ra-card" style={{ marginBottom: 16 }}>
      <h2 className="ra-card-title">No classes yet</h2>
      <p className="ra-card-sub">
        Use the <strong>New class</strong> form above to create your first class. Once you have a
        class, you can add students inline — no SQL required.
      </p>
    </section>
  );
}

function NewClassCard({ teacherUserId, isTeacher, onCreated }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [gradeLevel, setGradeLevel] = useState("K");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!isTeacher) {
    return (
      <section className="ra-card" style={{ marginBottom: 16 }}>
        <p className="ra-card-sub" style={{ margin: 0 }}>
          Your account isn't flagged as a teacher yet. Open the
          {" "}<Link to="/reading/signin" className="ra-link">sign-in page</Link>
          {" "}and click Refresh to provision the role.
        </p>
      </section>
    );
  }

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { error: insErr } = await supabase
        .from("teacher_classes")
        .insert({
          teacher_user_id: teacherUserId,
          name: name.trim(),
          grade_level: gradeLevel || null,
        });
      if (insErr) throw insErr;
      setName("");
      setOpen(false);
      onCreated?.();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ra-card" style={{ marginBottom: 16 }}>
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <h2 className="ra-card-title" style={{ margin: 0 }}>Classes</h2>
        <button
          type="button"
          className="ra-btn ra-btn-primary"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Cancel" : "+ New class"}
        </button>
      </header>
      {open && (
        <form onSubmit={submit} style={{ marginTop: 12, display: "grid", gap: 10 }}>
          <label className="ra-form-label">
            Class name
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="ra-form-input"
              placeholder="Mrs. Lee — Reading K"
              maxLength={80}
            />
          </label>
          <label className="ra-form-label">
            Grade level
            <select
              value={gradeLevel}
              onChange={(e) => setGradeLevel(e.target.value)}
              className="ra-form-input"
            >
              <option value="K">K</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="K-2">K–2</option>
              <option value="">Mixed / unspecified</option>
            </select>
          </label>
          <div className="ra-actions" style={{ display: "flex", gap: 10 }}>
            <button type="submit" className="ra-btn ra-btn-primary" disabled={busy}>
              {busy ? "Creating…" : "Create class"}
            </button>
          </div>
          {error && (
            <div style={{ color: "#c33", fontSize: 12 }}>Failed: {error}</div>
          )}
        </form>
      )}
    </section>
  );
}

function AddStudentForm({ classId, accessToken, onCreated }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [gradeLevel, setGradeLevel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    if (!accessToken) {
      setError("missing access token — sign in again");
      return;
    }
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const res = await fetch("/api/provision-student", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          displayName: name.trim(),
          gradeLevel: gradeLevel || null,
          classId,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 207) {
        setError(json?.error || `status ${res.status}`);
        return;
      }
      if (res.status === 207 && json?.enrollWarning) {
        setWarning(`Student created but enrollment failed: ${json.enrollWarning}`);
      }
      setName("");
      setGradeLevel("");
      setOpen(false);
      onCreated?.();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          fontSize: 12,
          padding: "4px 10px",
          border: "1px solid #ccc",
          background: "white",
          borderRadius: 5,
          cursor: "pointer",
          color: "#444",
        }}
      >
        {open ? "Cancel" : "+ Add student"}
      </button>
      {open && (
        <form
          onSubmit={submit}
          style={{
            marginTop: 8,
            padding: 12,
            background: "#f7f9fb",
            borderRadius: 6,
            display: "grid",
            gap: 8,
          }}
        >
          <label className="ra-form-label" style={{ fontSize: 12 }}>
            Student display name
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="ra-form-input"
              placeholder="Sam"
              maxLength={80}
            />
          </label>
          <label className="ra-form-label" style={{ fontSize: 12 }}>
            Grade level
            <select
              value={gradeLevel}
              onChange={(e) => setGradeLevel(e.target.value)}
              className="ra-form-input"
            >
              <option value="">Same as class</option>
              <option value="K">K</option>
              <option value="1">1</option>
              <option value="2">2</option>
            </select>
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="submit"
              className="ra-btn ra-btn-primary"
              disabled={busy}
              style={{ fontSize: 12, padding: "4px 12px" }}
            >
              {busy ? "Adding…" : "Add"}
            </button>
          </div>
          {error && (
            <div style={{ color: "#c33", fontSize: 12 }}>Failed: {error}</div>
          )}
          {warning && (
            <div style={{ color: "#a72", fontSize: 12 }}>{warning}</div>
          )}
          <div style={{ fontSize: 11, color: "#888" }}>
            PII-light: only the display name + grade are stored. Auth invites
            (so a student can sign in) come in M13.
          </div>
        </form>
      )}
    </div>
  );
}

function ErrorPanel({ message }) {
  return (
    <section className="ra-card">
      <h2 className="ra-card-title" style={{ color: "#c33" }}>Failed to load roster</h2>
      <p className="ra-card-sub">{message}</p>
      {message?.includes("does not exist") && (
        <p className="ra-card-sub" style={{ marginTop: 8 }}>
          The teacher-roster migration (M12-A) hasn't been applied yet. See{" "}
          <code>supabase/migrations/0004_teacher_roster.sql</code>.
        </p>
      )}
    </section>
  );
}

// =====================================================================
// M16-L6 — Passwordless student login setup
// =====================================================================
//
// Per-class panel that lets teachers:
//   - mint or rotate the class_code (5-char unambiguous code)
//   - set or rotate each student's 4-digit PIN + avatar emoji
//   - print a roster sheet with name + emoji + PIN per student
//
// PINs are NEVER displayed after they're set. Teachers see them
// exactly once (the moment they're generated/rotated) and the print
// view picks them up while the page memory still holds them.

const AVATAR_PALETTE = [
  "🦊", "🐶", "🐱", "🐰", "🐼", "🐯", "🐵", "🐸",
  "🦁", "🐢", "🐳", "🐝", "🦄", "🐧", "🦉", "🐙",
  "🌟", "⚡", "🌈", "🍎", "🍌", "🍓", "🚀", "⚽",
  "🎨", "📚", "🎵", "🌻", "🦖", "🐬",
];

function PasswordlessLoginPanel({ cls, students, accessToken, onChanged }) {
  const [classCode, setClassCode] = useState(cls.class_code || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [revealedPins, setRevealedPins] = useState({}); // { [studentId]: pin }
  // Sync local code if upstream cls changes (e.g. after refetch).
  useEffect(() => {
    setClassCode(cls.class_code || null);
  }, [cls.class_code]);

  async function generateClassCode() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/class-set-code", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ classId: cls.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) {
        setError(json?.error || `status ${res.status}`);
        return;
      }
      setClassCode(json.classCode);
      onChanged?.();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rotatePin(studentId) {
    setError(null);
    try {
      const res = await fetch("/api/student-set-pin", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ studentId }), // server generates
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) {
        setError(json?.error || `status ${res.status}`);
        return;
      }
      setRevealedPins((m) => ({ ...m, [studentId]: json.pin }));
      onChanged?.();
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  async function setAvatar(studentId, emoji) {
    setError(null);
    try {
      const res = await fetch("/api/student-set-pin", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        // Re-set PIN with same value — easier API surface than a
        // separate set-avatar endpoint. The handler accepts pin
        // omitted (and re-generates), so we only call this AFTER
        // a PIN exists — passing the previously revealed pin keeps
        // it stable. If unknown, this also rotates the PIN, which
        // is acceptable: the teacher will see the new one revealed.
        body: JSON.stringify({
          studentId,
          pin: revealedPins[studentId] || undefined,
          avatarEmoji: emoji,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) {
        setError(json?.error || `status ${res.status}`);
        return;
      }
      if (json.pin) {
        setRevealedPins((m) => ({ ...m, [studentId]: json.pin }));
      }
      onChanged?.();
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  function printRoster() {
    const w = window.open("", "_blank");
    if (!w) return;
    const rows = students
      .map((s) => {
        const pin = revealedPins[s.id] || "—";
        return `<tr>
          <td style="padding:10px;font-size:30px">${s.avatar_emoji || "🌱"}</td>
          <td style="padding:10px;font-size:18px;font-weight:600">${escapeHtml(s.displayName)}</td>
          <td style="padding:10px;font-size:32px;font-family:monospace;letter-spacing:6px">${pin}</td>
        </tr>`;
      })
      .join("");
    w.document.write(`<!doctype html><html><head><title>${escapeHtml(cls.name)} — login cards</title>
      <style>body{font-family:-apple-system,sans-serif;padding:24px;color:#222}
      h1{margin:0 0 4px}h2{margin:0 0 16px;color:#666;font-weight:400}
      table{border-collapse:collapse;width:100%}
      tr{border-bottom:1px solid #eee}
      .code{font-size:48px;font-family:monospace;letter-spacing:8px;background:#f3f5f9;padding:12px 24px;display:inline-block;border-radius:10px;margin:8px 0 16px}
      </style></head><body>
      <h1>${escapeHtml(cls.name)}</h1>
      <h2>Class code: <span class="code">${classCode || "—"}</span></h2>
      <p style="color:#666;font-size:13px;margin-bottom:24px">Visit <strong>vpa.app/student</strong> on the device. Tap your name, then type your PIN.</p>
      <table><thead><tr>
        <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #222">Avatar</th>
        <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #222">Name</th>
        <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #222">PIN</th>
      </tr></thead><tbody>${rows}</tbody></table>
      <p style="margin-top:24px;color:#999;font-size:11px">PINs shown only for students whose PIN you've just rotated this session. Use "Rotate PIN" on each student to populate.</p>
      </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 200);
  }

  return (
    <div
      style={{
        marginTop: 14,
        padding: "12px 14px",
        background: "#f7f9fb",
        borderRadius: 10,
        border: "1px solid #e5e7eb",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              color: "#888",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Student login (passwordless)
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 22,
              fontFamily: "monospace",
              letterSpacing: 4,
              fontWeight: 700,
              color: classCode ? "#222" : "#aaa",
            }}
          >
            {classCode || "no code yet"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={generateClassCode}
            disabled={busy}
            style={{
              padding: "6px 12px",
              border: "1px solid #2c7be5",
              background: "white",
              color: "#2c7be5",
              borderRadius: 6,
              fontSize: 12,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Working…" : classCode ? "Rotate code" : "Get class code"}
          </button>
          <button
            type="button"
            onClick={printRoster}
            disabled={!classCode || students.length === 0}
            style={{
              padding: "6px 12px",
              border: "1px solid #ccc",
              background: "white",
              color: "#444",
              borderRadius: 6,
              fontSize: 12,
              cursor: !classCode ? "not-allowed" : "pointer",
            }}
          >
            Print login cards
          </button>
        </div>
      </div>
      {error && (
        <div
          style={{
            marginTop: 10,
            padding: "6px 10px",
            background: "#fef3f2",
            color: "#a31515",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
      {students.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <details>
            <summary
              style={{
                cursor: "pointer",
                fontSize: 12,
                color: "#555",
                marginBottom: 8,
              }}
            >
              Set PINs and avatars ({students.length} student{students.length === 1 ? "" : "s"})
            </summary>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              {students.map((s) => (
                <StudentPinRow
                  key={s.id}
                  student={s}
                  revealedPin={revealedPins[s.id]}
                  onRotatePin={() => rotatePin(s.id)}
                  onSetAvatar={(emoji) => setAvatar(s.id, emoji)}
                />
              ))}
            </div>
          </details>
        </div>
      )}
      <p
        style={{
          marginTop: 10,
          fontSize: 11,
          color: "#999",
        }}
      >
        Students sign in at <code>/student</code> with the class code, their
        avatar, and a 4-digit PIN. PINs are hashed; you only see them at the
        moment you rotate them.
      </p>
    </div>
  );
}

function StudentPinRow({ student, revealedPin, onRotatePin, onSetAvatar }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 8px",
        background: "white",
        borderRadius: 6,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 26, lineHeight: 1 }}>{student.avatar_emoji || "🌱"}</span>
      <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>
        {student.displayName}
      </span>
      <button
        type="button"
        onClick={() => setPickerOpen((o) => !o)}
        style={{
          padding: "4px 8px",
          fontSize: 11,
          border: "1px solid #ddd",
          background: "white",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        {pickerOpen ? "Done" : "Avatar"}
      </button>
      <button
        type="button"
        onClick={onRotatePin}
        style={{
          padding: "4px 8px",
          fontSize: 11,
          border: "1px solid #ddd",
          background: "white",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        Rotate PIN
      </button>
      {revealedPin && (
        <span
          style={{
            padding: "2px 8px",
            fontFamily: "monospace",
            fontSize: 14,
            letterSpacing: 2,
            background: "#fffbe5",
            border: "1px dashed #d4af37",
            borderRadius: 4,
            fontWeight: 700,
          }}
          title="Visible only this session — write it down"
        >
          {revealedPin}
        </span>
      )}
      {pickerOpen && (
        <div style={{ flexBasis: "100%", marginTop: 6 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(10,1fr)",
              gap: 4,
            }}
          >
            {AVATAR_PALETTE.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => {
                  onSetAvatar(e);
                  setPickerOpen(false);
                }}
                style={{
                  fontSize: 22,
                  padding: 4,
                  border: e === student.avatar_emoji ? "2px solid #2c7be5" : "1px solid #eee",
                  background: "white",
                  borderRadius: 6,
                  cursor: "pointer",
                  lineHeight: 1,
                }}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
