import React, { useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import skillNodesData from "../../../data/skill_nodes.json";
import assessmentItemsData from "../../../data/assessment_items.json";
import { cascadeUnlock } from "../../../lib/masteryEngine.js";
import {
  filterTestableNodes,
  filterAutonomousTestableNodes,
} from "../../../lib/graphValidator.js";
import {
  gradeBandForNode,
  orderByDifficulty,
  pickCheckpoints,
  entryIndexForGrade,
  prevBandStartIndex,
  GRADE_OPTIONS,
  GRADE_LABELS,
} from "../../../lib/diagnosticPlan.js";
import { ROUTES } from "../../../config/routes.js";
import { loadState, saveState } from "../lib/readingState.js";
import {
  emit,
  masteryTransition,
  diagnosticCompleted,
  speechRecognitionError,
} from "../lib/telemetry.js";
import { useAdaptiveSpeech } from "../lib/useAdaptiveSpeech.js";
import { scoreReadAloudAuto } from "../lib/scoring.js";
import { useAuth } from "../../../lib/auth/AuthProvider.jsx";
import { useStudentMode } from "../../../lib/auth/useStudentMode.js";
import DiagnosticHeader from "../components/DiagnosticHeader.jsx";
import DiagnosticProgress from "../components/DiagnosticProgress.jsx";
import DiagnosticItem from "../components/DiagnosticItem.jsx";
import PlacementSummary from "../components/PlacementSummary.jsx";

const ITEMS_PER_NODE = 3;
// A checkpoint "passes" at 2 of 3 — robust to one unlucky item without
// being a giveaway.
const PASS_THRESHOLD = 2;
// Checkpoints per grade band the adaptive walk tests.
const CHECKPOINTS_PER_BAND = 2;

// Trickle prereq-mastery down the graph from a node we are crediting.
// If a student is placed at / credited with CVC_short_a they obviously
// have its prereqs (LS_01, LS_03, PA_06_segment_cvc) — marking those
// mastered keeps the graph consistent and stops the Drill prereq guard
// from bouncing a student off their own placement node.
function trickleMasteryToPrereqs(state, fromNodeId, nodeDefs) {
  const byId = new Map(nodeDefs.map((n) => [n.id, n]));
  const visit = (id) => {
    const node = byId.get(id);
    if (!node) return;
    for (const p of node.prereqs || []) {
      const ns = state.nodes[p];
      if (!ns || ns.status === "mastered") continue;
      ns.status = "mastered";
      ns.masteredAt = ns.masteredAt || Date.now();
      ns.diagnostic = { trickleDownFrom: fromNodeId, ts: Date.now() };
      visit(p);
    }
  };
  visit(fromNodeId);
}

// Diagnostic / Placement runtime — grade-aware adaptive walk.
//
// M16-I1 — autonomy contract:
//   In normal student mode the testable list EXCLUDES nodes that require
//   teacher scoring (PA_01_initial_isolation, letter-sound nodes, etc.).
//   Teacher mode (?teacher=1 or signed-in teacher/admin) restores the
//   full battery.
//
// Phase B — grade-aware adaptive placement:
//   The old walk started at the front of the graph (K phonemic
//   awareness) and stepped forward node by node. A 4th grader had to
//   clear ~50 phonics nodes before reaching grade-level work, and one
//   slip dropped them to kindergarten. The walk is now:
//     1. The student picks a grade. We test a few CHECKPOINT skills per
//        grade band rather than every node — placement is ~3-8 skills.
//     2. Start at the declared grade's band.
//     3. Pass a checkpoint -> ascend to the next harder checkpoint.
//     4. Miss BEFORE passing anything -> the declared grade is too hard;
//        descend a band and retry.
//     5. Miss AFTER passing one -> that band is the frontier; stop.
//   Placement is band-level: the first band the student cannot clear is
//   the frontier. Every easier band is credited (a 4th grader is not
//   walked back through kindergarten phonics), and the student is placed
//   at the first skill of the frontier band.

export default function Diagnostic() {
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth?.() ?? {};
  const startedAtRef = useRef(Date.now());

  // Mode resolution. ?teacher=1 OR signed-in teacher/admin → teacher mode.
  const urlParams = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  );
  const teacherMode =
    urlParams.get("teacher") === "1" ||
    auth?.profile?.role === "teacher" ||
    auth?.profile?.role === "admin";
  const isStudent = useStudentMode();

  // seq        — every testable node, difficulty-ordered (used to find
  //              the first skill of the frontier band at placement).
  // checkpoints — the short list the adaptive walk actually tests.
  // M16-I1: students walk only auto-scorable nodes; teachers get the
  // full battery.
  const { seq, checkpoints } = useMemo(() => {
    const base = teacherMode
      ? filterTestableNodes(skillNodesData, assessmentItemsData)
      : filterAutonomousTestableNodes(skillNodesData, assessmentItemsData);
    const ordered = orderByDifficulty(base);
    return {
      seq: ordered,
      checkpoints: pickCheckpoints(ordered, CHECKPOINTS_PER_BAND),
    };
  }, [teacherMode]);

  // ASR — same adaptive engine as Drill, hooked once at route level.
  const { supported: speechSupported, listening, listen, engine } =
    useAdaptiveSpeech({ engine: "auto" });

  // Phase: "grade" (pick a grade) → "walk" (answer items) → done.
  const [phase, setPhase] = useState("grade");
  const [selectedGrade, setSelectedGrade] = useState(0);

  // Walk state.
  const [cursor, setCursor] = useState(0); // index into checkpoints
  const [itemIdx, setItemIdx] = useState(0);
  const [nodeCorrect, setNodeCorrect] = useState(0);
  const [results, setResults] = useState([]); // { nodeId, label, correctCount, total, passed, band, seqIndex }
  const [done, setDone] = useState(false);
  // M16-I4: lastResult drives the soft-retry "I didn't hear you" UI.
  const [lastResult, setLastResult] = useState(null);
  const [busy, setBusy] = useState(false);

  // Adaptive-walk bookkeeping.
  const [passedAny, setPassedAny] = useState(false);
  const [ceilingIndex, setCeilingIndex] = useState(null); // lowest missed idx
  const [descended, setDescended] = useState(false);

  // Edge: no checkpoints at all (empty / item-less graph).
  if (!checkpoints.length) {
    return (
      <div className="ra-app">
        <div className="ra-app-inner">
          <DiagnosticHeader />
          <section className="ra-card">
            <h2 className="ra-card-title">No testable skills yet</h2>
            <p className="ra-card-sub">
              {teacherMode
                ? "The item bank doesn't yet have items for any node in the current graph."
                : "We don't have any auto-scorable placement items ready yet. Ask a teacher to start your placement instead."}
            </p>
            <div className="ra-actions" style={{ marginTop: 18 }}>
              <button
                type="button"
                className="ra-btn ra-btn-primary"
                onClick={() => navigate(ROUTES.READING)}
              >
                Back to Reading Academy
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  const node = checkpoints[Math.min(cursor, checkpoints.length - 1)];
  const items = assessmentItemsData[node.id] || [];
  const item = items[itemIdx % items.length];
  const itemKey = `${node.id}#${itemIdx % items.length}`;

  // ---- grade pick → start the walk ----------------------------------
  function startWalk(grade) {
    const entry = entryIndexForGrade(checkpoints, grade);
    setSelectedGrade(grade);
    setCursor(entry);
    setItemIdx(0);
    setNodeCorrect(0);
    setResults([]);
    setPassedAny(false);
    setCeilingIndex(null);
    setDescended(false);
    setLastResult(null);
    setBusy(false);
    setPhase("walk");
    startedAtRef.current = Date.now();
  }

  function handleScore(correct) {
    if (busy) return;
    setBusy(true);
    setLastResult(null);

    const nextCorrectCount = nodeCorrect + (correct ? 1 : 0);
    const itemsAnswered = itemIdx + 1;

    if (itemsAnswered < ITEMS_PER_NODE) {
      // Still inside this checkpoint's item set.
      setNodeCorrect(nextCorrectCount);
      setItemIdx(itemsAnswered);
      setBusy(false);
      return;
    }

    // Checkpoint complete (3 items answered).
    const passed = nextCorrectCount >= PASS_THRESHOLD;
    const result = {
      nodeId: node.id,
      label: node.topic || node.skill,
      correctCount: nextCorrectCount,
      total: ITEMS_PER_NODE,
      passed,
      band: gradeBandForNode(node),
      seqIndex: cursor,
    };
    const nextResults = [...results, result];

    masteryTransition({
      nodeId: node.id,
      from: "locked",
      to: passed ? "mastered" : "unlocked",
      reason: "diagnostic",
    });

    // Safety cap — the walk tests each checkpoint at most once, so this
    // can only fire on a degenerate graph.
    if (nextResults.length >= checkpoints.length) {
      finalize(nextResults);
      setBusy(false);
      return;
    }

    if (passed) {
      // Ascend to the next harder checkpoint.
      const nextCursor = cursor + 1;
      const hitCeiling = ceilingIndex != null && nextCursor >= ceilingIndex;
      if (hitCeiling || nextCursor >= checkpoints.length) {
        finalize(nextResults);
        setBusy(false);
        return;
      }
      setResults(nextResults);
      setPassedAny(true);
      setCursor(nextCursor);
      setItemIdx(0);
      setNodeCorrect(0);
      setBusy(false);
      return;
    }

    // Missed this checkpoint.
    if (passedAny) {
      // The frontier — first band the student cannot clear. Stop.
      finalize(nextResults);
      setBusy(false);
      return;
    }

    // Missed before passing anything → the declared grade is too hard.
    // Descend to the first checkpoint of the band below.
    const downIdx = prevBandStartIndex(checkpoints, cursor);
    if (downIdx < 0) {
      // Already at the easiest band — place them here.
      finalize(nextResults);
      setBusy(false);
      return;
    }
    setResults(nextResults);
    setCeilingIndex((prev) => (prev == null ? cursor : Math.min(prev, cursor)));
    setDescended(true);
    setCursor(downIdx);
    setItemIdx(0);
    setNodeCorrect(0);
    setBusy(false);
  }

  // M16-I1: mic path for autonomous student placement.
  function handleMicTap() {
    if (busy || listening) return;
    const expected = item.answer || item.prompt;
    // eslint-disable-next-line no-console
    console.log("[ra.diag] handleMicTap.dispatch", {
      nodeId: node.id,
      itemKey,
      expected,
      engine,
    });
    listen({ referenceText: expected }, (asrResult) => {
      // eslint-disable-next-line no-console
      console.log("[ra.diag] asrResult", {
        engine: asrResult?.engine,
        error: asrResult?.error,
        transcript: asrResult?.transcript,
        durationMs: asrResult?.latencyMs,
      });

      // Soft retry — same contract as Drill.handleMicTap (M16-H1).
      const noTranscript = !asrResult?.transcript;
      const noAzureScore = typeof asrResult?.accuracyScore !== "number";
      const noUsableSignal =
        !!asrResult?.error && noTranscript && noAzureScore;

      if (noUsableSignal) {
        if (asrResult.error && asrResult.error !== "no-speech") {
          speechRecognitionError({
            nodeId: node.id,
            itemId: itemKey,
            expected,
            errorCode: asrResult.error,
          });
        }
        setLastResult({
          correct: false,
          transcript: null,
          expected,
          softRetry: true,
        });
        return;
      }

      const scored = scoreReadAloudAuto({ item, asrResult });
      setLastResult({
        correct: scored.correct,
        transcript: scored.transcript,
        expected,
      });
      // Brief pause so the student sees the result, then advance.
      setTimeout(() => handleScore(scored.correct), 600);
    });
  }

  function finalize(finalResults) {
    // Sort the checkpoints tested into difficulty order. The first one
    // the student missed defines the frontier band.
    const ordered = [...finalResults].sort(
      (a, b) => a.seqIndex - b.seqIndex,
    );
    const firstMiss = ordered.find((r) => !r.passed);
    const frontierBand = firstMiss ? firstMiss.band : null;

    const after = loadState();
    const now = Date.now();

    // Band-level placement. Every band BELOW the frontier is credited
    // as mastered — a 4th grader is never walked back through 50
    // kindergarten phonics nodes. Band 0 (phonemic awareness / letter
    // sounds) is teacher-assessed and not auto-credited here; trickle
    // (below) still pulls in whatever band-0 prereqs the placement node
    // depends on so the graph stays consistent.
    for (const def of skillNodesData) {
      const band = gradeBandForNode(def);
      if (!after.nodes[def.id]) {
        after.nodes[def.id] = { status: "locked", attempts: [] };
      }
      const ns = after.nodes[def.id];
      const credited =
        band >= 1 && (frontierBand == null || band < frontierBand);
      if (credited && ns.status !== "mastered") {
        ns.status = "mastered";
        ns.masteredAt = ns.masteredAt || now;
        ns.diagnostic = { gradeTrust: frontierBand ?? "aced", ts: now };
      }
    }

    // Active node: the first skill of the frontier band (difficulty
    // order). null when the student cleared every checkpoint.
    let activeNodeId = null;
    if (frontierBand != null) {
      const firstOfBand = seq.find(
        (n) => gradeBandForNode(n) === frontierBand,
      );
      activeNodeId = firstOfBand ? firstOfBand.id : null;
    }
    if (activeNodeId && after.nodes[activeNodeId]) {
      after.nodes[activeNodeId].status = "active";
    }

    // Trickle: keep the graph consistent. Every credited/active node
    // gets its prereq chain (including teacher-scored band-0 nodes)
    // marked mastered, so the Drill prereq guard never bounces a
    // student off their own placement.
    for (const def of skillNodesData) {
      const st = after.nodes[def.id]?.status;
      if (st === "mastered" || st === "active") {
        trickleMasteryToPrereqs(after, def.id, skillNodesData);
      }
    }

    const unlocked = cascadeUnlock(after);

    unlocked.diagnosticComplete = true;
    unlocked.diagnosticCompletedAt = now;
    saveState(unlocked);

    diagnosticCompleted({
      studentId: unlocked.studentId || null,
      results: ordered,
      activeNodeId,
      gradeDeclared: selectedGrade,
      frontierBand,
      descended,
      durationMs: now - startedAtRef.current,
    });

    setResults(ordered);
    setDone(true);
  }

  function handleCancel() {
    // Don't write any state on cancel. Just bounce back.
    emit("diagnostic.cancelled", {
      phase,
      atCursor: cursor,
      atItemIdx: itemIdx,
      partialResults: results,
    });
    navigate(ROUTES.READING);
  }

  // ---- done: placement summary --------------------------------------
  if (done) {
    const activeNodeId = results.find((r) => !r.passed)
      ? seq.find(
          (n) =>
            gradeBandForNode(n) ===
            results.find((r) => !r.passed).band,
        )?.id
      : null;
    const activeNode = activeNodeId
      ? skillNodesData.find((n) => n.id === activeNodeId)
      : null;
    return (
      <div className="ra-app">
        <div className="ra-app-inner">
          <DiagnosticHeader />
          <section className="ra-card">
            <PlacementSummary
              results={results}
              activeNode={activeNode}
              onContinue={() => navigate(ROUTES.READING)}
            />
          </section>
        </div>
      </div>
    );
  }

  // ---- grade pick ----------------------------------------------------
  if (phase === "grade") {
    return (
      <div className="ra-app">
        <div className="ra-app-inner">
          <DiagnosticHeader onCancel={handleCancel} />
          <section className="ra-card">
            <p className="ra-eyebrow">Quick placement</p>
            <h2 className="ra-card-title" style={{ marginTop: 4 }}>
              What grade are you in?
            </h2>
            <p className="ra-card-sub">
              We'll start your placement at the right level. Pick the
              closest grade — a few quick questions will fine-tune it.
            </p>
            <div className="ra-diag-grade-grid">
              {GRADE_OPTIONS.map((opt) => (
                <button
                  key={opt.grade}
                  type="button"
                  className="ra-diag-grade-btn"
                  onClick={() => startWalk(opt.grade)}
                >
                  <span className="ra-diag-grade-label">{opt.label}</span>
                  <span className="ra-diag-grade-hint">{opt.hint}</span>
                </button>
              ))}
            </div>
            <div className="ra-actions" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="ra-link"
                onClick={() => startWalk(0)}
              >
                Not sure — start from the very beginning
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  // ---- walk ----------------------------------------------------------
  const gradeLabel = GRADE_LABELS[selectedGrade] || "Reading";
  return (
    <div className="ra-app">
      <div className="ra-app-inner">
        <DiagnosticHeader onCancel={handleCancel} />
        <section className="ra-card">
          <DiagnosticProgress
            skillsChecked={results.length}
            itemIdx={itemIdx}
            itemsPerNode={ITEMS_PER_NODE}
            gradeLabel={gradeLabel}
          />
          {!isStudent && (
            <h2 className="ra-card-title" style={{ marginTop: 18 }}>
              {node.topic || node.skill}
            </h2>
          )}
          {!isStudent && (
            <p className="ra-card-sub">
              {node.strand} · <code className="ra-id">{node.id}</code> ·
              band {gradeBandForNode(node)}
            </p>
          )}
          <DiagnosticItem
            key={`${node.id}-${itemIdx}`}
            node={node}
            item={item}
            onScore={handleScore}
            isStudent={isStudent}
            teacherMode={teacherMode}
            speechSupported={speechSupported}
            listening={listening}
            onMicTap={handleMicTap}
            lastResult={lastResult}
            busy={busy}
          />
        </section>
      </div>
    </div>
  );
}
