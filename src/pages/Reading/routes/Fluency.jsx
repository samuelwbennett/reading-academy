import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import skillNodesData from "../../../data/skill_nodes.json";
import assessmentItemsData from "../../../data/assessment_items.json";
import { recordAttempt } from "../../../lib/masteryEngine.js";
import { ROUTES } from "../../../config/routes.js";
import {
  loadState,
  saveState,
} from "../lib/readingState.js";
import { useAdaptiveSpeech } from "../lib/useAdaptiveSpeech.js";
import { scoreReadAloudAuto, scoreAdultOverride } from "../lib/scoring.js";
import { useStudentMode } from "../../../lib/auth/useStudentMode.js";
import {
  pickFocalNode,
  buildItemQueue,
  itemIsAutomatic,
  scoreDrill,
  applyDrillResult,
  getPersonalBest,
  DRILL_DURATION_MS,
  FLUENCY_NODE_IS_DRILLABLE,
} from "../lib/readingFactsEngine.js";
import {
  drillAttempt,
  speechRecognitionError,
  masteryTransition,
  emit,
} from "../lib/telemetry.js";
import FluencyTimer from "../components/FluencyTimer.jsx";
import FluencyItem from "../components/FluencyItem.jsx";
import FluencySummary from "../components/FluencySummary.jsx";

// Reading Facts — 60-second timed read-aloud drill.
//
// Phases:
//   "ready"   → Start screen with focal node + personal best.
//   "running" → 60s drill. Words flash, mic chains, attempts accumulate.
//   "done"    → FluencySummary with WCPM + personal-best announce.
//
// Mic chain: on each onresult/onerror/onend (regardless of outcome), if the
// drill is still running we score, advance, and immediately listen() again.
// First listen() is gated by user tapping Start, which counts as the
// browser's required user gesture for SpeechRecognition.

const FEEDBACK_FLASH_MS = 200;
const TICK_MS = 100;

export default function Fluency() {
  const navigate = useNavigate();

  const [state, setState] = useState(() => loadState());

  // Pick a focal node Reading Facts can actually drill. Priority:
  //   1. The mastery engine's active node IF it's read-aloud-eligible.
  //   2. Otherwise, the most recently mastered read-aloud node.
  //   3. Otherwise, the lowest-numbered unlocked read-aloud node with items.
  // This lets a student stuck at PA still get fluency reps on any
  // CVC/blend/digraph skill they've unlocked.
  const focalNode = useMemo(() => {
    const active = pickFocalNode(state, skillNodesData);
    if (active && FLUENCY_NODE_IS_DRILLABLE(active.assessment)) return active;

    const readable = skillNodesData.filter(
      (n) =>
        FLUENCY_NODE_IS_DRILLABLE(n.assessment) &&
        Array.isArray(assessmentItemsData[n.id]) &&
        assessmentItemsData[n.id].length > 0,
    );
    if (readable.length === 0) return active; // nothing to fall back to

    // Find the most recently practiced/mastered readable node.
    const ranked = readable
      .map((n) => {
        const ns = state.nodes?.[n.id];
        const status = ns?.status || "locked";
        const score =
          status === "mastered" ? 4 :
          status === "practicing" ? 3 :
          status === "active" ? 2 :
          status === "unlocked" ? 1 : 0;
        const ts = ns?.attempts?.length
          ? ns.attempts[ns.attempts.length - 1]?.ts || 0
          : 0;
        return { node: n, score, ts };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.ts - a.ts);

    if (ranked[0]) return ranked[0].node;
    // No unlocked read-aloud nodes yet → return active so the friendly
    // progression message renders.
    return active;
  }, [state]);
  const itemQueueRef = useRef([]);
  const [phase, setPhase] = useState("ready"); // ready | running | done
  const [itemIdx, setItemIdx] = useState(0);
  const [msRemaining, setMsRemaining] = useState(DRILL_DURATION_MS);
  const [lastVerdict, setLastVerdict] = useState(null);
  const [drillScore, setDrillScore] = useState(null);
  const [isNewOverall, setIsNewOverall] = useState(false);
  const [isNewForNode, setIsNewForNode] = useState(false);
  const [priorBest, setPriorBest] = useState({ overall: 0, forNode: 0 });

  // Refs for the mic chain — avoid stale closures on rapid re-renders.
  const phaseRef = useRef(phase);
  const itemIdxRef = useRef(itemIdx);
  const attemptsRef = useRef([]); // local drill log, committed at finish
  const drillIdRef = useRef(`drill-${Date.now()}`);
  const drillStartTsRef = useRef(null);
  const flashTimerRef = useRef(null);
  const lastFiredItemKeyRef = useRef(null);
  const lastTapTsRef = useRef(Date.now());

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { itemIdxRef.current = itemIdx; }, [itemIdx]);

  // M16-A: adaptive engine (Azure when available, Web Speech fallback).
  const { supported: speechSupported, listening, listen, stop: stopMic, engine } =
    useAdaptiveSpeech({ engine: "auto", patience: "fluency" });

  // Persist state whenever it changes.
  useEffect(() => { saveState(state); }, [state]);

  // ---- Edge / unsupported states ---------------------------------------

  if (!focalNode) {
    return (
      <FluencyFrame>
        <h2 className="ra-card-title">Nothing to drill yet</h2>
        <p className="ra-card-sub">
          No active node. Run the placement check or pick a topic from the dashboard.
        </p>
        <BackLink />
      </FluencyFrame>
    );
  }

  if (!FLUENCY_NODE_IS_DRILLABLE(focalNode.assessment)) {
    return (
      <FluencyFrame node={focalNode}>
        <h2 className="ra-card-title">Reading Facts unlocks at CVC</h2>
        <p className="ra-card-sub">
          You're currently working on phonemic awareness. Reading Facts is a
          60-second word fluency drill, so it starts once you've reached
          letter–sound and CVC reading. Keep working through the placement and
          today's drill — it'll unlock automatically.
        </p>
        <BackLink />
      </FluencyFrame>
    );
  }

  const focalItems = assessmentItemsData[focalNode.id] || [];
  if (focalItems.length === 0) {
    return (
      <FluencyFrame node={focalNode}>
        <h2 className="ra-card-title">No items authored for this skill yet</h2>
        <p className="ra-card-sub">
          Item authoring is M2 of the build plan. Once items land for{" "}
          <code className="ra-id">{focalNode.id}</code>, Reading Facts can drill
          them.
        </p>
        <BackLink />
      </FluencyFrame>
    );
  }

  // ---- Drill control ---------------------------------------------------

  const handleStart = () => {
    const pb = getPersonalBest(state, focalNode.id);
    setPriorBest(pb);

    itemQueueRef.current = buildItemQueue(focalNode, assessmentItemsData);
    attemptsRef.current = [];
    drillIdRef.current = `drill-${Date.now()}`;
    drillStartTsRef.current = Date.now();
    lastFiredItemKeyRef.current = null; // reset so the auto-arm effect fires
    setItemIdx(0);
    setLastVerdict(null);
    setMsRemaining(DRILL_DURATION_MS);
    setPhase("running");
    emit("fluency.drill_started", {
      drillId: drillIdRef.current,
      focalNodeId: focalNode.id,
      itemCount: itemQueueRef.current.length,
    });
    // Mic is auto-armed by the useEffect below; no explicit kickoff needed.
    // The user gesture (this click) gives the browser SR start permission.
  };

  // Tick the timer.
  useEffect(() => {
    if (phase !== "running") return;
    const start = drillStartTsRef.current ?? Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, DRILL_DURATION_MS - elapsed);
      setMsRemaining(remaining);
      if (remaining === 0) finishDrill(elapsed);
    }, TICK_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Auto-arm mic on every (phase | listening | itemIdx) change while running.
  // This replaces the old chained setTimeout(fireMicForCurrentItem) approach
  // which was vulnerable to stale closures and silent chain breakage. The
  // effect is keyed by item so it never double-fires for the same word, and
  // the previous-rec teardown in useSpeechRecognition guarantees a clean
  // start each time.
  useEffect(() => {
    if (phase !== "running") return;
    if (!speechSupported) return;
    if (listening) return;

    const queue = itemQueueRef.current;
    if (!queue || queue.length === 0) return;
    const item = queue[itemIdx % queue.length];
    if (!item) return;

    const key = `${itemIdx}-${item.prompt}`;
    if (lastFiredItemKeyRef.current === key) return;
    lastFiredItemKeyRef.current = key;

    // referenceText lets Azure's pronunciation assessment score
    // against the expected word; useAdaptiveSpeech ignores it on
    // the Web Speech path so the legacy behavior is preserved.
    listen({ referenceText: item.answer || item.prompt }, (asrResult) => {
      if (phaseRef.current !== "running") return;
      handleAsrResult(item, asrResult);
    });
    // listen is stable now (no listening dep); safe in deps.
  }, [phase, listening, itemIdx, speechSupported, listen]);

  function handleAsrResult(item, asrResult) {
    if (asrResult.error && asrResult.error !== "no-speech") {
      speechRecognitionError({
        nodeId: focalNode.id,
        itemId: itemKey(item),
        expected: item.answer || item.prompt,
        errorCode: asrResult.error,
      });
    }
    const scored = scoreReadAloudAuto({ item, asrResult });
    commitAttempt(item, scored);
    advanceAfterFlash();
  }

  // Show the verdict color briefly, then bump itemIdx — that change triggers
  // the auto-arm effect to fire listen() for the next item.
  function advanceAfterFlash() {
    clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      if (phaseRef.current !== "running") return;
      setItemIdx((i) => i + 1);
      setLastVerdict(null);
    }, FEEDBACK_FLASH_MS);
  }

  function handleAdultScoreInDrill(correct) {
    if (phaseRef.current !== "running") return;
    const queue = itemQueueRef.current;
    const idx = itemIdxRef.current;
    const item = queue[idx % queue.length];
    if (!item) return;

    // Adult tap interrupts the mic — abort and treat this as the result.
    stopMic();
    const scored = scoreAdultOverride({
      item,
      correct,
      latencyMs: Math.max(50, Date.now() - (lastTapTsRef.current || Date.now())),
    });
    commitAttempt(item, scored);
    advanceAfterFlash();
  }

  function commitAttempt(item, scored) {
    const itemId = itemKey(item);
    const enginePayload = {
      correct: scored.correct,
      latencyMs: scored.latencyMs,
      prompt: item.prompt,
      transcript: scored.transcript,
      source: scored.source,
      itemId,
      drillId: drillIdRef.current,
    };

    // Update node state via existing engine.
    setState((prev) => {
      const beforeStatus = prev.nodes[focalNode.id]?.status;
      const next = recordAttempt(prev, focalNode.id, enginePayload, focalNode.mastery);
      const afterStatus = next.nodes[focalNode.id]?.status;
      if (beforeStatus !== afterStatus) {
        masteryTransition({
          nodeId: focalNode.id,
          from: beforeStatus || "locked",
          to: afterStatus,
          reason: "fluency",
        });
      }
      return next;
    });

    // Record per-item telemetry (fluency-specific event).
    const withinAutomaticity = scored.correct && itemIsAutomatic(scored.latencyMs, focalNode.mastery);
    const attempt = {
      ...scored,
      itemId,
      withinAutomaticity,
      ts: Date.now(),
    };
    attemptsRef.current.push(attempt);

    emit("fluency.attempt", {
      drillId: drillIdRef.current,
      nodeId: focalNode.id,
      itemId,
      word: item.prompt,
      latencyMs: scored.latencyMs,
      recognized: scored.transcript,
      correct: scored.correct,
      withinTarget: withinAutomaticity,
      asr: { engine: scored.source, confidence: scored.confidence ?? null },
    });

    drillAttempt({
      studentId: state.studentId || null,
      nodeId: focalNode.id,
      itemId,
      expected: scored.expected,
      transcript: scored.transcript,
      correct: scored.correct,
      latencyMs: scored.latencyMs,
      scoringSource: scored.source,
      confidence: scored.confidence,
    });

    // Visual flash for the next 200ms.
    setLastVerdict(scored.correct ? "correct" : "incorrect");
  }

  function finishDrill(actualDurationMs) {
    if (phaseRef.current === "done") return;
    setPhase("done");
    stopMic();
    clearTimeout(flashTimerRef.current);

    const drill = scoreDrill(attemptsRef.current, actualDurationMs ?? DRILL_DURATION_MS);

    // Apply drill result to fluency state (personal bests).
    setState((prev) => {
      const { state: next, isNewOverall: nO, isNewForNode: nN } = applyDrillResult(
        prev,
        focalNode.id,
        drill,
      );
      setIsNewOverall(nO);
      setIsNewForNode(nN);
      return next;
    });

    setDrillScore(drill);

    emit("fluency.drill_complete", {
      drillId: drillIdRef.current,
      durationMs: drill.durationMs,
      wordsAttempted: drill.wordsAttempted,
      wordsCorrect: drill.wordsCorrect,
      wordsAutomatic: drill.wordsAutomatic,
      wcpm: drill.wcpm,
      personalBest: priorBest,
      nodesTouched: [focalNode.id],
    });
  }

  function itemKey(item) {
    const idx = (item && itemQueueRef.current.indexOf(item)) || 0;
    return `${focalNode.id}#${idx}#${item?.prompt || "?"}`;
  }

  // ---- Render ----------------------------------------------------------

  if (phase === "ready") {
    const pb = getPersonalBest(state, focalNode.id);
    return (
      <FluencyFrame node={focalNode}>
        <div className="ra-eyebrow">Reading Facts · 60 seconds</div>
        <h2 className="ra-card-title">{focalNode.topic || focalNode.skill}</h2>
        <p className="ra-card-sub">
          Read each word aloud as fast as you can without making mistakes.
        </p>
        <div className="ra-fluency-prebest">
          <div>
            <strong>{pb.overall}</strong>
            <span>Best WCPM</span>
          </div>
          <div>
            <strong>{pb.forNode}</strong>
            <span>Best on this skill</span>
          </div>
        </div>
        <div className="ra-actions" style={{ marginTop: 18 }}>
          <button
            type="button"
            className="ra-btn ra-btn-primary"
            onClick={handleStart}
          >
            Start drill
          </button>
          <Link to={ROUTES.READING} className="ra-btn">
            Back
          </Link>
        </div>
        {!speechSupported && (
          <p className="ra-drill-fallback-note" style={{ marginTop: 14 }}>
            Mic recognition isn't available in this browser — Reading Facts
            falls back to adult-tap scoring during the drill.
          </p>
        )}
      </FluencyFrame>
    );
  }

  if (phase === "running") {
    const queue = itemQueueRef.current;
    const item = queue[itemIdx % queue.length];
    return (
      <FluencyFrame node={focalNode}>
        <FluencyTimer msRemaining={msRemaining} totalMs={DRILL_DURATION_MS} />
        <FluencyItem
          prompt={item?.prompt || ""}
          listening={listening}
          lastVerdict={lastVerdict}
          speechSupported={speechSupported}
          onMicTap={() => {
            // Manual re-arm: clear the per-item key so the auto-arm effect
            // fires another listen for the same item. This is the user-facing
            // recovery path if a no-speech result was logged but they want
            // another shot before the timer advances them.
            lastFiredItemKeyRef.current = null;
            // Touching itemIdx by setting it to itself would be a no-op —
            // but the effect already runs on `listening` flips, and stop+listen
            // accomplishes that. Easiest: stop any in-flight mic so listening
            // flips to false, which re-triggers the effect for the same item.
            stopMic();
          }}
          onAdultScore={handleAdultScoreInDrill}
        />
      </FluencyFrame>
    );
  }

  // phase === "done"
  return (
    <FluencyFrame node={focalNode}>
      <FluencySummary
        focalNode={focalNode}
        drillScore={drillScore || { wcpm: 0, wordsAttempted: 0, wordsCorrect: 0, wordsAutomatic: 0 }}
        priorBest={priorBest}
        isNewOverall={isNewOverall}
        isNewForNode={isNewForNode}
        onContinue={() => navigate(ROUTES.READING)}
      />
    </FluencyFrame>
  );
}

// ---- Layout helpers ---------------------------------------------------

function FluencyFrame({ node, children }) {
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
          <h1
            className="ra-header-title"
            style={{ fontSize: 18, marginTop: 4 }}
          >
            Reading Facts
            {node && (
              <span
                style={{ marginLeft: 8, fontSize: 14, color: "#666", fontWeight: 400 }}
              >
                — {node.topic || node.skill}
              </span>
            )}
          </h1>
        </header>
        <section className="ra-card">{children}</section>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <div className="ra-actions" style={{ marginTop: 18 }}>
      <Link to={ROUTES.READING} className="ra-btn ra-btn-primary" role="button">
        Back to dashboard
      </Link>
    </div>
  );
}
