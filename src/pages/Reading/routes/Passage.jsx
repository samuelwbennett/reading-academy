import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import skillNodesData from "../../../data/skill_nodes.json";
import passagesData from "../../../data/passages.json";
import { recordAttempt } from "../../../lib/masteryEngine.js";
import { ROUTES } from "../../../config/routes.js";
import {
  loadState,
  saveState,
  getActiveNodeId,
} from "../lib/readingState.js";
import { useAdaptiveSpeech } from "../lib/useAdaptiveSpeech.js";
import { pickNextPassage } from "../lib/passageRecommender.js";
import {
  alignPassage,
  scorePassage,
  passageToText,
} from "../lib/levenshteinAligner.js";
import {
  emit,
  speechRecognitionError,
  masteryTransition,
} from "../lib/telemetry.js";
import FluencyTimer from "../components/FluencyTimer.jsx";
import PassageReader from "../components/PassageReader.jsx";
import PassageSummary from "../components/PassageSummary.jsx";

const DRILL_DURATION_MS = 60_000;
const TICK_MS = 100;

// Passage Reader — cold-read drill at /reading/passage.
//
// Phases:
//   "ready"   → student sees the passage + Start button.
//   "running" → 60s timer; mic chain accumulates transcript fragments.
//   "done"    → align transcript → expected text, render PassageSummary.
//
// Reuses useSpeechRecognition (the same mic chain pattern as Reading Facts,
// except instead of advancing item-by-item it accumulates transcripts).

export default function Passage() {
  const navigate = useNavigate();
  const [state, setState] = useState(() => loadState());
  const allPassages = passagesData?.passages || [];

  const candidate = useMemo(
    () => pickNextPassage(state, skillNodesData, allPassages),
    [state, allPassages],
  );
  const passage = candidate?.passage || null;
  const expectedText = useMemo(
    () => (passage ? passageToText(passage) : ""),
    [passage],
  );

  // Determine if the active node is a fluency gate so we can score against
  // its thresholds + record per-attempt to that node.
  const activeNodeId = useMemo(() => getActiveNodeId(state), [state]);
  const activeNode = useMemo(
    () => (activeNodeId ? skillNodesData.find((n) => n.id === activeNodeId) : null),
    [activeNodeId],
  );
  const gateNode = activeNode && /^FL_\d+/.test(activeNode.id) ? activeNode : null;

  const [phase, setPhase] = useState("ready"); // ready | running | done
  const [msRemaining, setMsRemaining] = useState(DRILL_DURATION_MS);
  const [score, setScore] = useState(null);
  const [aligned, setAligned] = useState(null);

  // Refs for the mic chain.
  const phaseRef = useRef(phase);
  const transcriptFragmentsRef = useRef([]);
  const drillStartTsRef = useRef(null);
  const drillIdRef = useRef(`passage-${Date.now()}`);
  const lastFiredKeyRef = useRef(null);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { saveState(state); }, [state]);

  // M16-A: adaptive engine (Azure when available, Web Speech fallback).
  const { supported: speechSupported, listening, listen, stop: stopMic, engine } =
    useAdaptiveSpeech({ engine: "auto" });

  // ----- Empty / unsupported guards ------------------------------------

  if (!passage) {
    return (
      <PassageFrame>
        <h2 className="ra-card-title">Cold-read passages unlock at CVC fluency</h2>
        <p className="ra-card-sub">
          The passage reader is for connected text, not single words. It opens
          when you've mastered the letter–sound and CVC skills that make up
          its first gate (FL_01). Keep going on today's drill and it'll unlock
          on its own.
        </p>
        <p className="ra-card-sub" style={{ marginTop: 12 }}>
          Bank status: 24 cold-read passages across FL_01–FL_04 are authored;
          the recommender is matching against your current decodable
          inventory.
        </p>
        <BackLink />
      </PassageFrame>
    );
  }

  // ----- Drill control --------------------------------------------------

  function handleStart() {
    transcriptFragmentsRef.current = [];
    drillIdRef.current = `passage-${Date.now()}`;
    drillStartTsRef.current = Date.now();
    lastFiredKeyRef.current = null;
    setMsRemaining(DRILL_DURATION_MS);
    setAligned(null);
    setScore(null);
    setPhase("running");
    emit("passage.drill_started", {
      drillId: drillIdRef.current,
      passageId: passage.passageId,
      gateId: passage.gateId,
      isCold: !!passage.isCold,
      expectedWordCount: expectedText.split(/\s+/).filter(Boolean).length,
    });
    // Mic auto-arms via the effect below; this click counts as the user
    // gesture browsers require for SpeechRecognition.start().
  }

  // Timer.
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

  // Mic chain — re-arm on every (phase | listening) change while running.
  // Each onresult contributes a fragment; transcripts concatenate at finish.
  useEffect(() => {
    if (phase !== "running") return;
    if (!speechSupported) return;
    if (listening) return;

    // Use a key tied to fragment count so we always fire a fresh listen
    // whenever the previous one resolved.
    const key = `${transcriptFragmentsRef.current.length}-${msRemaining}`;
    if (lastFiredKeyRef.current === key) return;
    lastFiredKeyRef.current = key;

    // For passages, the reference text is the full expected passage —
    // Azure can score the read against it. Web Speech ignores the
    // referenceText option, preserving legacy behavior.
    listen({ referenceText: expectedText }, (asrResult) => {
      if (phaseRef.current !== "running") return;
      if (asrResult.error && asrResult.error !== "no-speech") {
        speechRecognitionError({
          nodeId: gateNode?.id || passage.passageId,
          itemId: passage.passageId,
          expected: expectedText,
          errorCode: asrResult.error,
        });
      }
      if (asrResult.transcript) {
        transcriptFragmentsRef.current.push(asrResult.transcript);
      }
      // Don't advance — let the effect re-fire listen for more audio.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, listening, speechSupported, listen]);

  function finishDrill(actualDurationMs) {
    if (phaseRef.current === "done") return;
    setPhase("done");
    stopMic();

    const fullTranscript = transcriptFragmentsRef.current.join(" ").trim();
    const alignment = alignPassage(expectedText, fullTranscript);
    const passageScore = scorePassage(alignment, actualDurationMs ?? DRILL_DURATION_MS);

    setAligned(alignment.aligned);
    setScore(passageScore);

    // If this is a fluency-gate read, record an attempt against the gate node
    // so the existing mastery engine can promote it on threshold.
    if (gateNode) {
      const targetWcpm = gateNode.mastery?.wcpm_min ?? 30;
      const targetAccuracy = gateNode.mastery?.passage_accuracy ?? 0.95;
      const passes =
        passageScore.wcpm >= targetWcpm &&
        passageScore.accuracy >= targetAccuracy;

      setState((prev) => {
        const beforeStatus = prev.nodes[gateNode.id]?.status;
        const next = recordAttempt(
          prev,
          gateNode.id,
          {
            correct: passes,
            latencyMs: passageScore.durationMs,
            prompt: passage.passageId,
            transcript: fullTranscript,
            source: "web_speech_passage",
            itemId: passage.passageId,
            drillId: drillIdRef.current,
          },
          gateNode.mastery,
        );
        const afterStatus = next.nodes[gateNode.id]?.status;
        if (beforeStatus !== afterStatus) {
          masteryTransition({
            nodeId: gateNode.id,
            from: beforeStatus || "locked",
            to: afterStatus,
            reason: "passage",
          });
        }
        return next;
      });
    }

    emit("passage.drill_complete", {
      drillId: drillIdRef.current,
      passageId: passage.passageId,
      gateId: passage.gateId,
      isCold: !!passage.isCold,
      durationMs: passageScore.durationMs,
      wcpm: passageScore.wcpm,
      accuracy: passageScore.accuracy,
      correctWords: passageScore.correctWords,
      totalExpected: passageScore.totalExpected,
      totalAttempted: passageScore.totalAttempted,
    });
  }

  function handleManualStop() {
    if (phaseRef.current !== "running") return;
    finishDrill(Date.now() - (drillStartTsRef.current ?? Date.now()));
  }

  // ----- Render ---------------------------------------------------------

  if (phase === "ready") {
    return (
      <PassageFrame>
        <div className="ra-eyebrow">
          {passage.isCold ? "Cold-read passage" : "Practice passage"}
          {gateNode ? <> · gate {gateNode.id}</> : null}
        </div>
        <h2 className="ra-card-title">{passage.topic}</h2>
        <p className="ra-card-sub">
          {passage.wordCount} words ·{" "}
          {gateNode
            ? <>Target: ≥{gateNode.mastery.wcpm_min} WCPM at ≥{Math.round((gateNode.mastery.passage_accuracy || 0) * 100)}% accuracy</>
            : "Practice — no gate threshold."}
        </p>

        <div className="ra-passage-body" style={{ marginTop: 12, marginBottom: 14 }}>
          {passage.paragraphs?.map((para, pi) => (
            <p key={pi} className="ra-passage-para">
              {para.sentences?.map((s, si) => (
                <span key={si} className="ra-passage-sentence">
                  {s.text}{" "}
                </span>
              ))}
            </p>
          ))}
        </div>

        <div className="ra-actions">
          <button
            type="button"
            className="ra-btn ra-btn-primary"
            onClick={handleStart}
          >
            Start reading
          </button>
          <Link to={ROUTES.READING} className="ra-btn">Back</Link>
        </div>
        {!speechSupported && (
          <p className="ra-drill-fallback-note" style={{ marginTop: 12 }}>
            Mic recognition isn't available — passage scoring needs Chrome, Edge, or Safari.
          </p>
        )}
      </PassageFrame>
    );
  }

  if (phase === "running") {
    return (
      <PassageFrame>
        <FluencyTimer msRemaining={msRemaining} totalMs={DRILL_DURATION_MS} />
        <PassageReader
          passage={passage}
          aligned={null}
          listening={listening}
          speechSupported={speechSupported}
          onMicTap={() => {
            // Manual re-arm: stop any in-flight mic so the auto-arm effect refires.
            stopMic();
          }}
        />
        <div className="ra-actions" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="ra-btn"
            onClick={handleManualStop}
          >
            I'm done
          </button>
        </div>
      </PassageFrame>
    );
  }

  // phase === "done"
  return (
    <PassageFrame>
      <PassageSummary
        passage={passage}
        gateNode={gateNode}
        score={score || { wcpm: 0, accuracy: 0, correctWords: 0, totalExpected: 0, totalAttempted: 0, durationMs: 0 }}
        onContinue={() => navigate(ROUTES.READING)}
      />
      {aligned && aligned.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="ra-eyebrow" style={{ marginBottom: 10 }}>
            Word-by-word alignment
          </div>
          <PassageReader
            passage={passage}
            aligned={aligned}
            listening={false}
            speechSupported={speechSupported}
          />
        </div>
      )}
    </PassageFrame>
  );
}

// ---- Layout helpers ---------------------------------------------------

function PassageFrame({ children }) {
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
          <h1 className="ra-header-title" style={{ fontSize: 18, marginTop: 4 }}>
            Read this story
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
