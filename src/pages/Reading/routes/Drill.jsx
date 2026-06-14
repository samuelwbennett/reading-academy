import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import skillNodesData from "../../../data/skill_nodes.json";
import assessmentItemsData from "../../../data/assessment_items.json";
import { recordAttempt, evaluateMastery } from "../../../lib/masteryEngine.js";
import { ROUTES } from "../../../config/routes.js";
import {
  loadState,
  saveState,
  getActiveNodeId,
  markPendingTeacherObservation,
} from "../lib/readingState.js";
import { useAdaptiveSpeech } from "../lib/useAdaptiveSpeech.js";
import { scoreReadAloudAuto, scoreAdultOverride } from "../lib/scoring.js";
import {
  drillAttempt,
  speechRecognitionError,
  masteryTransition,
} from "../lib/telemetry.js";
import {
  isTeacherScored,
  isAsrScorablePhoneme,
} from "../../../lib/assessment";
import { useAuth } from "../../../lib/auth/AuthProvider.jsx";
import { useStudentMode } from "../../../lib/auth/useStudentMode.js";
import DrillItem from "../components/DrillItem.jsx";
import DrillStats from "../components/DrillStats.jsx";
import PhonemeItem from "../components/PhonemeItem.jsx";
import PhonemeAsrItem from "../components/PhonemeAsrItem.jsx";
import ComprehensionItem from "../components/ComprehensionItem.jsx";
import MorphemeSplitItem from "../components/MorphemeSplitItem.jsx";
import StudentSessionProgress from "../components/StudentSessionProgress.jsx";
import SessionComplete from "../components/SessionComplete.jsx";

// M16-E4: bounded student session contract. A drill session ends
// when EITHER the student completes SESSION_TARGET items OR the node
// reaches mastery. Teacher/admin mode + ?teacher=1 can keep going
// (and gets a "Practice more" button on the completion screen).
const SESSION_TARGET = 10;

// Self-scoring drill runtime — handles every assessment type that has
// an authored item bank.
//
// Flow:
//   1. Load state, pick active node.
//   2. Cycle items[active.id] in order.
//      - read_aloud      → DrillItem (mic + adult override)
//      - phoneme_*       → PhonemeItem (TTS + adult tap)
//      - letter_sound    → PhonemeItem (silent + adult tap)
//      - cold_passage    → bounce (handled by /reading/passage)
//   3. On mic result OR adult tap:
//        - score
//        - record via masteryEngine.recordAttempt (state machine T2/T3/T4)
//        - persist via saveState
//        - emit drill.attempt + (mastery.transition if T4 fired)
//        - advance to next item (~600ms after feedback)
//   4. Exit any time → /reading.

const PHONEME_ASSESSMENTS = new Set([
  "phoneme_isolate_initial",
  "phoneme_isolate_final",
  "phoneme_isolate_medial",
  "phoneme_blend",
  "phoneme_segment",
  "phoneme_delete_initial",
  "phoneme_delete_final",
  "phoneme_substitute",
  "letter_sound",
]);
const READ_ALOUD_ASSESSMENTS = new Set(["read_aloud"]);
// Phase A + B1: tap-to-pick MCQ assessments — comprehension (vocab-in-
// context, literal recall, inference, bg knowledge) AND morphology
// (morpheme_meaning). All share the same renderer (ComprehensionItem)
// and the same single-shot, adult-score scoring path. The item shape
// is identical: { question, choices[], answer, passage? }.
const COMPREHENSION_ASSESSMENTS = new Set([
  "vocab_in_context",
  "literal_recall",
  "inference",
  "bg_knowledge",
  "morpheme_meaning",
]);
// Phase C: tap-to-split word-segmenting probe. Self-scoring like the
// comprehension MCQ but with its own renderer (MorphemeSplitItem).
const MORPHEME_SPLIT_ASSESSMENTS = new Set(["morpheme_split"]);
const SUPPORTED_ASSESSMENTS = new Set([
  ...READ_ALOUD_ASSESSMENTS,
  ...PHONEME_ASSESSMENTS,
  ...COMPREHENSION_ASSESSMENTS,
  ...MORPHEME_SPLIT_ASSESSMENTS,
]);
const FEEDBACK_HOLD_MS = 600;

export default function Drill() {
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth?.() ?? {};

  // URL params for testing + teacher override (M16-B3):
  //   ?node=<nodeId>   force a specific node (overrides session state)
  //   ?teacher=1       enable manual scoring buttons even on
  //                    teacher-scored nodes (otherwise hidden)
  const urlParams = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  );
  const overrideNodeId = urlParams.get("node");
  const teacherMode =
    urlParams.get("teacher") === "1" ||
    auth?.profile?.role === "teacher" ||
    auth?.profile?.role === "admin";
  const isStudent = useStudentMode();

  const [state, setState] = useState(() => loadState());
  const activeNodeId = useMemo(
    () => overrideNodeId || getActiveNodeId(state),
    [state, overrideNodeId],
  );
  const activeNode = useMemo(
    () => (activeNodeId ? skillNodesData.find((n) => n.id === activeNodeId) : null),
    [activeNodeId],
  );
  const items = useMemo(
    () => (activeNodeId && Array.isArray(assessmentItemsData[activeNodeId]) ? assessmentItemsData[activeNodeId] : []),
    [activeNodeId],
  );

  // Local drill state.
  const [itemIdx, setItemIdx] = useState(0);
  const [sessionAttempts, setSessionAttempts] = useState(0);
  const [sessionCorrect, setSessionCorrect] = useState(0);
  const [lastResult, setLastResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const advanceTimerRef = useRef(null);
  // M16-E4-6: bounded session contract.
  //   sessionDone           — # of items the student has scored this session
  //   sessionEnded          — true once target hit or mastery reached
  //   sessionEndReason      — "target_reached" | "mastery_reached"
  // Practice-more (teacher) clears these and resumes drilling.
  const [sessionDone, setSessionDone] = useState(0);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [sessionEndReason, setSessionEndReason] = useState("target_reached");

  // ASR.
  // M16-A: adaptive engine — picks Azure when /api/azure-speech-token
  // returns a valid token, falls back to Web Speech API otherwise.
  // The deterministic Web baseline always remains as a fallback per
  // the LLM-boundary discipline applied to ASR.
  const { supported: speechSupported, listening, listen, engine } =
    useAdaptiveSpeech({ engine: "auto" });

  // Persist state to localStorage on every change.
  useEffect(() => {
    saveState(state);
  }, [state]);

  // Cleanup any pending advance timer on unmount.
  useEffect(() => () => clearTimeout(advanceTimerRef.current), []);

  // M16-K2: SOFT-SKIP autonomous students past teacher-led nodes.
  //
  // Belt-and-suspenders defense. selectActiveNodeAutonomous (the picker
  // readingState now uses by default) already filters teacher-led nodes
  // out of the candidate list, so an autonomous student following the
  // normal flow shouldn't land here. But three edge cases can still put
  // a teacher-led node in front of an autonomous student:
  //
  //   (a) ?node=PA_02_final_isolation in the URL (debug / shared link).
  //   (b) Old saved state that still has a teacher-led node marked as
  //       "active" or "practicing" from before M16-K3.
  //   (c) A future bug in the picker.
  //
  // In any of those cases we record the bypass into the teacher
  // observation queue (so it surfaces in the teacher dashboard) and
  // bounce back to /reading. The student never sees a dead-end card.
  // Teacher mode (?teacher=1 or signed-in teacher/admin) skips this
  // branch — they're allowed to drill teacher-led nodes directly.
  useEffect(() => {
    if (!activeNode) return;
    if (teacherMode) return;
    if (!isTeacherScored(activeNode.assessment)) return;
    // eslint-disable-next-line no-console
    console.log("[ra.drill] soft-skip teacher-led node", {
      nodeId: activeNode.id,
      assessment: activeNode.assessment,
      reason: "autonomous_student_landed_on_teacher_led",
    });
    const skipped = markPendingTeacherObservation(
      state,
      activeNode.id,
      "auto_skipped_in_drill",
    );
    saveState(skipped);
    navigate(ROUTES.READING, { replace: true });
  }, [activeNode, teacherMode, navigate, state]);

  // 2026-05-19 audit fix #2: prereq guard at drill-launch time.
  //
  // Closes the URL-param bypass that previously let `?node=<lockedId>`
  // skip the gating entirely. The planner won't surface locked nodes,
  // but a student (or shared link) hitting the drill route directly
  // could still drill — and even master — a node whose upstream skills
  // aren't actually built yet. That breaks the mastery contract.
  //
  // Behaviour: if any prereq of the requested node is not in a
  // mastered-family status in legacy state, bounce back to /reading.
  // Teacher mode skips this check (teachers may legitimately want to
  // demo or assess any node).
  useEffect(() => {
    if (!activeNode) return;
    if (teacherMode) return;
    const prereqs = activeNode.prereqs || [];
    if (prereqs.length === 0) return;
    const LEGACY_MASTERED = new Set(["mastered"]);
    const unmet = prereqs.filter((pid) => {
      const ps = state.nodes?.[pid]?.status;
      return !ps || !LEGACY_MASTERED.has(ps);
    });
    if (unmet.length === 0) return;
    // eslint-disable-next-line no-console
    console.log("[ra.drill] prereq-locked node — bouncing", {
      nodeId: activeNode.id,
      unmetPrereqs: unmet,
    });
    navigate(ROUTES.READING, { replace: true });
  }, [activeNode, teacherMode, state, navigate]);

  // ----- Empty / unsupported states ---------------------------------------

  if (!activeNode) {
    return (
      <DrillFrame>
        <h2 className="ra-card-title">Nothing to drill</h2>
        <p className="ra-card-sub">
          No active node. Try the placement check or pick a topic from the
          course tree.
        </p>
        <BackToReading />
      </DrillFrame>
    );
  }

  if (items.length === 0) {
    return (
      <DrillFrame node={activeNode}>
        <h2 className="ra-card-title">No items authored yet</h2>
        <p className="ra-card-sub">
          The item bank doesn't have practice words for{" "}
          <code className="ra-id">{activeNode.id}</code> yet. Item authoring is
          M2 of the build plan.
        </p>
        <BackToReading />
      </DrillFrame>
    );
  }

  if (activeNode.assessment === "cold_passage") {
    return (
      <DrillFrame node={activeNode}>
        <h2 className="ra-card-title">Use the passage reader</h2>
        <p className="ra-card-sub">
          <code className="ra-id">{activeNode.assessment}</code> runs as a
          full passage read-along, not a single-item drill. Open the passage
          tab from the dashboard.
        </p>
        <BackToReading />
      </DrillFrame>
    );
  }

  // M16-B / M16-K2: Teacher-scored assessments are excluded from the
  // normal student drill surface. Autonomous students reaching this
  // branch have already triggered the soft-skip useEffect above and
  // are bouncing to /reading — render a brief "loading" card while
  // the redirect lands. Teacher mode keeps the legacy panel for
  // explicit in-person administration.
  if (isTeacherScored(activeNode.assessment) && !teacherMode) {
    return (
      <DrillFrame node={activeNode} isStudent={isStudent}>
        <h2 className="ra-card-title">Loading…</h2>
        <p className="ra-card-sub">Picking your next skill.</p>
      </DrillFrame>
    );
  }
  if (isTeacherScored(activeNode.assessment) && teacherMode) {
    return (
      <DrillFrame node={activeNode}>
        <TeacherLedPanel node={activeNode} />
      </DrillFrame>
    );
  }

  if (!SUPPORTED_ASSESSMENTS.has(activeNode.assessment)) {
    return (
      <DrillFrame node={activeNode}>
        <h2 className="ra-card-title">This drill type isn't built yet</h2>
        <p className="ra-card-sub">
          <code className="ra-id">{activeNode.assessment}</code> doesn't have a
          runtime in this build.
        </p>
        <BackToReading />
      </DrillFrame>
    );
  }

  // ----- Live drill -------------------------------------------------------

  const item = items[itemIdx % items.length];
  const itemId = `${activeNode.id}#${itemIdx % items.length}`;

  const masteryConfig = activeNode.mastery || {};
  const masteryWindow = masteryConfig.rolling_window || 10;
  const nodeAttemptsCount = state.nodes[activeNode.id]?.attempts?.length || 0;
  const masteryProgress = Math.min(1, nodeAttemptsCount / masteryWindow);

  const commit = (attempt) => {
    if (busy) return;
    setBusy(true);

    // Build the engine attempt payload.
    const enginePayload = {
      correct: attempt.correct,
      latencyMs: attempt.latencyMs,
      prompt: item.prompt,
      transcript: attempt.transcript,
      source: attempt.source,
      itemId,
    };

    // Update state via existing engine (T2/T3/T4 transitions handled inside).
    const before = state;
    const beforeStatus = before.nodes[activeNode.id]?.status;
    const after = recordAttempt(before, activeNode.id, enginePayload, masteryConfig);
    const afterStatus = after.nodes[activeNode.id]?.status;

    setState(after);
    setSessionAttempts((n) => n + 1);
    if (attempt.correct) {
      setSessionCorrect((n) => n + 1);
      // Award XP on correct attempts. Source of truth for cross-app
      // rollups is the server-side daily_progress write (handled by
      // the session-bridge on session save), but the student-facing
      // Today screen reads this local mirror so the daily / weekly
      // bar updates immediately without waiting for the server.
      try {
        const raw = localStorage.getItem("ra:xp:v1");
        const data = raw ? JSON.parse(raw) : { byDay: {} };
        const today = new Date().toISOString().slice(0, 10);
        // 1 XP per correct attempt — keeps the per-correct increment
        // consistent across kinds. Lesson XP "rewards" shown on the
        // Today screen are aspirational targets for the full lesson;
        // they aren't the sum of per-correct increments.
        data.byDay = data.byDay || {};
        data.byDay[today] = (Number(data.byDay[today]) || 0) + 1;
        localStorage.setItem("ra:xp:v1", JSON.stringify(data));
      } catch {
        // localStorage can be disabled / quota-exceeded; ignore — the
        // server-side daily_progress write is still the authoritative
        // record.
      }
    }
    setLastResult(attempt);

    // Telemetry — drill.attempt (always).
    drillAttempt({
      studentId: after.studentId || null,
      nodeId: activeNode.id,
      itemId,
      expected: attempt.expected,
      transcript: attempt.transcript,
      correct: attempt.correct,
      latencyMs: attempt.latencyMs,
      scoringSource: attempt.source,
      confidence: attempt.confidence,
    });

    // Telemetry — mastery.transition if status changed.
    if (beforeStatus !== afterStatus) {
      masteryTransition({
        nodeId: activeNode.id,
        from: beforeStatus || "locked",
        to: afterStatus,
        reason: "drill",
      });
    }

    // M16-E4-6: bump bounded session counter and check for end.
    const nextDone = sessionDone + 1;
    setSessionDone(nextDone);

    const masteredFamily = new Set([
      "mastered",
      "mastered_for_acquisition",
      "in_automaticity_zone",
      "automatic",
    ]);
    const reachedMastery =
      beforeStatus !== afterStatus && masteredFamily.has(afterStatus);
    const reachedTarget = nextDone >= SESSION_TARGET;

    // Hold the feedback briefly, then either end the session or
    // advance to the next item.
    clearTimeout(advanceTimerRef.current);
    advanceTimerRef.current = setTimeout(() => {
      if (reachedMastery) {
        setSessionEndReason("mastery_reached");
        setSessionEnded(true);
      } else if (reachedTarget) {
        setSessionEndReason("target_reached");
        setSessionEnded(true);
      } else {
        setItemIdx((i) => i + 1);
        setLastResult(null);
      }
      setBusy(false);
    }, FEEDBACK_HOLD_MS);
  };

  const practiceMore = () => {
    setSessionEnded(false);
    setSessionDone(0);
    setItemIdx((i) => i + 1);
    setLastResult(null);
  };

  const handleMicTap = () => {
    if (busy) return;
    const expected = item.answer || item.prompt;
    // Always log the dispatch so we can prove from the console that
    // Drill is calling the new adaptive-speech path.
    // eslint-disable-next-line no-console
    console.log("[ra.drill] handleMicTap.dispatch", {
      nodeId: activeNode.id,
      itemId,
      expected,
      engine,
    });
    listen({ referenceText: expected }, (asrResult) => {
      // Always log the result shape so we can confirm the lifecycle in
      // production without flipping any debug flags.
      // eslint-disable-next-line no-console
      console.log("[ra.drill] asrResult", {
        engine: asrResult?.engine,
        error: asrResult?.error,
        transcript: asrResult?.transcript,
        durationMs: asrResult?.latencyMs,
        hasAzureScore: typeof asrResult?.accuracyScore === "number",
      });

      // M16-H1: SOFT-RETRY GUARD MUST RUN BEFORE ANY TELEMETRY.
      // Previously we called speechRecognitionError() up-front for any
      // non-no-speech error, and that helper internally emitted a
      // phantom responseIncorrect — producing the production sequence:
      //   speech.recognition_error → response_incorrect → softRetry
      //
      // Now we check first whether the recognizer produced any usable
      // signal at all. If not, the student didn't answer — they
      // experienced an engine failure. We emit AT MOST the diagnostic
      // speech.recognition_error (which no longer cascades into
      // response_incorrect) and return without scoring or committing.
      const noTranscript = !asrResult?.transcript;
      const noAzureScore = typeof asrResult?.accuracyScore !== "number";
      const noUsableSignal =
        !!asrResult?.error && noTranscript && noAzureScore;

      if (noUsableSignal) {
        // eslint-disable-next-line no-console
        console.log(
          "[ra.drill] softRetry — recognizer produced no usable signal",
          {
            error: asrResult?.error,
            engine: asrResult?.engine,
            durationMs: asrResult?.latencyMs,
          },
        );
        // Diagnostic only — no longer cascades into responseIncorrect.
        if (asrResult.error && asrResult.error !== "no-speech") {
          speechRecognitionError({
            nodeId: activeNode.id,
            itemId,
            expected,
            errorCode: asrResult.error,
          });
        }
        setLastResult({
          correct: false,
          transcript: null,
          alternatives: [],
          expected,
          latencyMs: asrResult?.latencyMs ?? 0,
          confidence: null,
          error: asrResult?.error || "no-speech",
          source: asrResult?.engine === "azure" ? "azure_asr" : "web_speech",
          softRetry: true,
        });
        return;
      }

      // We got a usable signal (transcript or Azure score). Now we
      // can score + commit. Fire the diagnostic telemetry for any
      // non-no-speech error that snuck through (e.g. partial result
      // with a recoverable error code).
      if (asrResult.error && asrResult.error !== "no-speech") {
        speechRecognitionError({
          nodeId: activeNode.id,
          itemId,
          expected,
          errorCode: asrResult.error,
        });
      }

      // scoreReadAloudAuto routes to the Azure-aware scorer when the
      // result includes accuracyScore, otherwise falls back to the
      // existing transcript-matching path.
      const scored = scoreReadAloudAuto({ item, asrResult });
      commit(scored);
    });
  };

  const handleAdult = (correct, latencyMs) => {
    const scored = scoreAdultOverride({ item, correct, latencyMs });
    commit(scored);
  };

  const isPhoneme = PHONEME_ASSESSMENTS.has(activeNode.assessment);
  const isAsrPhoneme = isAsrScorablePhoneme(activeNode.assessment);
  const isComprehension = COMPREHENSION_ASSESSMENTS.has(activeNode.assessment);
  const isMorphemeSplit = MORPHEME_SPLIT_ASSESSMENTS.has(activeNode.assessment);

  // M16-E4-6: bounded session contract — once the student has hit the
  // target (or the node has reached mastery), short-circuit the drill
  // render with the completion card. Teachers/admins get a "Practice
  // more" override so the contract doesn't get in the way of debugging.
  if (sessionEnded) {
    return (
      <DrillFrame node={activeNode} isStudent={isStudent}>
        <SessionComplete
          done={sessionDone}
          target={SESSION_TARGET}
          reason={sessionEndReason}
          showPracticeMore={teacherMode}
          onPracticeMore={practiceMore}
        />
      </DrillFrame>
    );
  }

  return (
    <DrillFrame node={activeNode} isStudent={isStudent}>
      {isStudent && (
        <StudentSessionProgress done={sessionDone} target={SESSION_TARGET} />
      )}
      {!isStudent && (
        <EngineBadge
          engine={engine}
          speechSupported={speechSupported}
          lastAttemptEngine={
            lastResult?.source === "azure_asr"
              ? "azure"
              : lastResult?.source === "web_speech"
                ? "web"
                : null
          }
          lastAttemptDurationMs={lastResult?.latencyMs ?? null}
        />
      )}
      {isComprehension ? (
        // Phase A: tap-to-pick MCQ for vocab-in-context, literal recall,
        // inference, and background knowledge. No mic, no ASR — pure tap.
        <ComprehensionItem
          key={`${activeNode.id}-${itemIdx}`}
          item={item}
          onAdultScore={handleAdult}
          lastResult={lastResult}
          busy={busy}
        />
      ) : isMorphemeSplit ? (
        // Phase C: tap-the-gap word segmenting — decompose an unseen
        // word into its morphemes. No mic, no ASR — tap then Check.
        <MorphemeSplitItem
          key={`${activeNode.id}-${itemIdx}`}
          item={item}
          onAdultScore={handleAdult}
          busy={busy}
        />
      ) : isAsrPhoneme ? (
        // M16-B: blend / deletion / substitution — ASR-scored, no
        // teacher tap in normal student mode. teacherMode=true
        // restores the manual buttons for debug / teacher-led use.
        <PhonemeAsrItem
          key={`${activeNode.id}-${itemIdx}`}
          node={activeNode}
          item={item}
          speechSupported={speechSupported}
          listening={listening}
          onMicTap={handleMicTap}
          onAdultScore={handleAdult}
          lastResult={lastResult}
          busy={busy}
          teacherMode={teacherMode}
        />
      ) : isPhoneme && teacherMode ? (
        // Teacher-scored assessment + teacherMode override → use the
        // legacy PhonemeItem (manual buttons).
        <PhonemeItem
          key={`${activeNode.id}-${itemIdx}`}
          node={activeNode}
          item={item}
          onAdultScore={handleAdult}
          lastResult={lastResult}
          busy={busy}
        />
      ) : (
        <DrillItem
          key={`${activeNode.id}-${itemIdx}`}
          item={item}
          speechSupported={speechSupported}
          listening={listening}
          onMicTap={handleMicTap}
          onAdultScore={handleAdult}
          lastResult={lastResult}
          busy={busy}
        />
      )}
      {!isStudent && (
        <DrillStats
          sessionAttempts={sessionAttempts}
          sessionCorrect={sessionCorrect}
          lastLatencyMs={lastResult?.latencyMs ?? null}
          nodeAttemptsCount={nodeAttemptsCount}
          masteryProgress={masteryProgress}
          masteryWindow={masteryWindow}
        />
      )}
      {!isStudent && (
        <div className="ra-drill-foot">
          <Link to={ROUTES.READING} className="ra-link">
            ← Exit to dashboard
          </Link>
        </div>
      )}
    </DrillFrame>
  );
}

// ---- Internals --------------------------------------------------------

function DrillFrame({ node, children, isStudent }) {
  // Student view: no node id chip, no graph stats. Quiet header that
  // gets out of the way so the prompt is the dominant element.
  return (
    <div className="ra-app">
      <div className="ra-app-inner">
        <header
          className="ra-header"
          style={{ paddingBottom: 6, marginBottom: 12 }}
        >
          <Link
            to={ROUTES.READING}
            className="ra-header-back"
            style={{ fontSize: 13 }}
          >
            ← Done
          </Link>
          {node && (
            <h1 className="ra-header-title" style={{ fontSize: 18, marginTop: 4 }}>
              {node.topic || node.skill}
              {!isStudent && (
                <span
                  style={{ marginLeft: 8, fontSize: 11, color: "#999", fontWeight: 400 }}
                >
                  <code className="ra-id">{node.id}</code>
                </span>
              )}
            </h1>
          )}
        </header>
        <section className="ra-card">{children}</section>
      </div>
    </div>
  );
}

function TeacherLedPanel({ node }) {
  return (
    <div>
      <h2 className="ra-card-title">This skill is teacher-led</h2>
      <p className="ra-card-sub">
        <strong>{node.topic || node.skill || node.id}</strong> involves
        single-sound answers (like saying just /s/). Speech recognition
        can't reliably score isolated sounds yet — so your teacher works
        with you on this one in person.
      </p>
      <p className="ra-card-sub" style={{ marginTop: 10 }}>
        Once you've got it, your teacher will mark it complete and the
        next skill will unlock.
      </p>
      <BackToReading />
      <p
        className="ra-card-sub"
        style={{ marginTop: 14, fontSize: 11, color: "#888" }}
      >
        Teacher: append <code>?teacher=1</code> to the URL to enable manual
        scoring buttons for this node.
      </p>
    </div>
  );
}

function EngineBadge({
  engine,
  speechSupported,
  lastAttemptEngine,
  lastAttemptDurationMs,
}) {
  // Tiny chip so a teacher (or dev verifying the deploy) can see at a
  // glance which ASR engine is scoring this session. Hidden when no
  // mic surface applies (e.g. PhonemeItem self-scoring).
  //
  // M16-F3: also surface the engine the LAST ATTEMPT actually used.
  // If the resolved engine and the last-attempt engine disagree, that
  // means our adaptive selection silently fell through (e.g. token
  // expired mid-session), which is exactly what we want to spot.
  if (!speechSupported) return null;
  if (!engine) {
    return (
      <div style={{ marginBottom: 8, fontSize: 11, color: "#888" }}>
        Detecting speech engine…
      </div>
    );
  }
  const isAzure = engine === "azure";
  const lastDiffers =
    lastAttemptEngine && lastAttemptEngine !== engine ? lastAttemptEngine : null;
  return (
    <div style={{ marginBottom: 8, fontSize: 11, color: "#666" }}>
      Speech engine:{" "}
      <span
        style={{
          padding: "1px 7px",
          borderRadius: 999,
          background: isAzure ? "#27a" : "#888",
          color: "white",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          fontWeight: 600,
        }}
      >
        {engine}
      </span>
      {isAzure && (
        <span style={{ marginLeft: 8, color: "#999" }}>
          phoneme-aware scoring
        </span>
      )}
      {lastAttemptEngine && (
        <span style={{ marginLeft: 10, color: lastDiffers ? "#c62828" : "#999" }}>
          last attempt: {lastAttemptEngine}
          {Number.isFinite(lastAttemptDurationMs) && lastAttemptDurationMs > 0 && (
            <> · {(lastAttemptDurationMs / 1000).toFixed(1)}s</>
          )}
          {lastDiffers && <> ⚠ engine mismatch</>}
        </span>
      )}
    </div>
  );
}

function BackToReading() {
  return (
    <div className="ra-actions" style={{ marginTop: 18 }}>
      <Link
        to={ROUTES.READING}
        className="ra-btn ra-btn-primary"
        role="button"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
