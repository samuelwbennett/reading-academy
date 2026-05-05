import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import skillNodesData from "./data/skill_nodes.json";
import assessmentItemsData from "./data/assessment_items.json";
import initialStudentState from "./data/student_state.json";
import {
  recordAttempt,
  evaluateMastery,
  rollingAccuracy,
  rollingMedianLatency,
  selectActiveNode,
  progressSummary,
  cascadeUnlock,
  applyDiagnostic,
  getDailyXp,
  getRecentAttempts,
  getRecentMasteries,
  getTodayTasks,
  buildCourseTree,
} from "./lib/masteryEngine.js";

import { useAuth } from "./hooks/useAuth.js";
import { signOut } from "./services/auth.js";
import {
  readLocal,
  writeLocal,
  loadFromSupabase,
  saveToSupabase,
} from "./services/storage.js";
import Login from "./components/Login.jsx";
import AccountUnlinked from "./components/AccountUnlinked.jsx";

// expose nodes to engine helpers
globalThis.__skillNodes = skillNodesData;

// Migrate older localStorage shapes (PA_06_segment_cvc → PA_04_blend_cvc).
function migrateState(s) {
  if (!s) return s;
  if (s?.nodes?.PA_06_segment_cvc && !s.nodes.PA_04_blend_cvc) {
    s.nodes.PA_04_blend_cvc = s.nodes.PA_06_segment_cvc;
    delete s.nodes.PA_06_segment_cvc;
  }
  return s;
}

function freshState() {
  return structuredClone(initialStudentState);
}

// ---------- XP Ring ----------
function XpRing({ xp, target, size = 60, stroke = 6 }) {
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.min(1, target > 0 ? xp / target : 0);
  const offset = circumference * (1 - pct);
  const reached = pct >= 1;

  return (
    <div className={`xp-ring ${reached ? "reached" : ""}`} role="img" aria-label={`${xp} of ${target} XP today`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id="xp-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   stopColor="#ffd76a" />
            <stop offset="50%"  stopColor="#f5b800" />
            <stop offset="100%" stopColor="#c98a00" />
          </linearGradient>
        </defs>
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke="var(--xp-track)"
          strokeWidth={stroke}
        />
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke="url(#xp-grad)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{ transition: "stroke-dashoffset 0.5s ease" }}
        />
      </svg>
      <div className="xp-ring-text">
        <div className="xp-ring-num">{xp}</div>
        <div className="xp-ring-target">XP</div>
      </div>
    </div>
  );
}

function NodeBadge({ status }) {
  const label =
    status === "mastered" ? "Mastered" :
    status === "active" || status === "practicing" ? "In progress" :
    status === "unlocked" ? "Unlocked" :
    "Locked";
  return <span className={`badge ${status}`}>{label}</span>;
}

// ---------- Today's Tasks (Math Academy-style task menu) ----------
function TodayTasks({ state, nodes, onStart }) {
  const tasks = useMemo(() => getTodayTasks(state, nodes, 4), [state, nodes]);

  if (!tasks.length) {
    return (
      <div className="card">
        <div className="section-label">Today's tasks</div>
        <h2 style={{ fontSize: 22, margin: "8px 0 4px" }}>You're all caught up</h2>
        <p style={{ color: "var(--muted)", margin: 0 }}>
          Every available skill is mastered. New material unlocks as the graph grows.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="section-label">Today's tasks</div>
      <ul className="task-list">
        {tasks.map((t) => (
          <li key={t.id} className="task-card">
            <div className="task-meta">
              <span className={`task-pill ${t.type.toLowerCase()}`}>{t.type}</span>
              <span className="task-xp">+{t.xp} XP</span>
            </div>
            <div className="task-title">{t.title}</div>
            <div className="task-sub">{t.subtitle}</div>
            <div className="task-foot">
              <span className="task-stats">{t.items} items · ~{t.estMinutes} min</span>
              <button className="btn task-start" onClick={() => onStart(t.nodeId)}>
                Start →
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Recent Work ----------
function RecentWork({ state, nodes }) {
  const masteries = useMemo(() => getRecentMasteries(state, nodes, 3), [state, nodes]);
  const attempts  = useMemo(() => getRecentAttempts(state, nodes, 8), [state, nodes]);

  if (!masteries.length && !attempts.length) {
    return null;
  }

  const fmtAgo = (ts) => {
    if (!ts) return "";
    const ms = Date.now() - ts;
    if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
  };

  return (
    <div className="card">
      <div className="section-label">Recent work</div>
      {masteries.length > 0 && (
        <ul className="recent-list">
          {masteries.map(({ node, masteredAt }) => (
            <li key={node.id} className="recent-row mastery">
              <span className="recent-icon">✓</span>
              <div className="recent-text">
                <div className="recent-title">Mastered · {node.topic || node.skill}</div>
                <div className="recent-sub">{node.module} · {fmtAgo(masteredAt)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {attempts.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 14 }}>Recent attempts</div>
          <ul className="recent-list">
            {attempts.map((a, i) => (
              <li key={i} className={`recent-row ${a.correct ? "good" : "bad"}`}>
                <span className="recent-icon">{a.correct ? "●" : "○"}</span>
                <div className="recent-text">
                  <div className="recent-title">
                    {a.prompt} · {a.correct ? "correct" : "incorrect"}
                    {a.heard && <span className="recent-heard"> · heard "{a.heard}"</span>}
                  </div>
                  <div className="recent-sub">
                    {a.node.topic || a.node.skill} · {(a.latencyMs / 1000).toFixed(2)}s · {fmtAgo(a.ts)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------- Course Tree (left rail) ----------
function CourseTree({ state, nodes, activeNodeId, onPickTopic, mode = "compact" }) {
  const tree = useMemo(() => buildCourseTree(nodes, state), [nodes, state]);
  const [expanded, setExpanded] = useState(() => new Set(tree.flatMap((c) =>
    c.units.flatMap((u) => u.modules.map((m) => `${c.name}>${u.name}>${m.name}`))
  )));
  const toggle = (key) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <nav className={`course-tree ${mode}`}>
      {tree.map((course) => (
        <div key={course.name} className="ct-course">
          <div className="ct-course-name">{course.name}</div>
          {course.units.map((unit) => (
            <div key={unit.name} className="ct-unit">
              <div className="ct-unit-name">{unit.name}</div>
              {unit.modules.map((mod) => {
                const key = `${course.name}>${unit.name}>${mod.name}`;
                const open = expanded.has(key);
                return (
                  <div key={mod.name} className="ct-module">
                    <button
                      className="ct-module-name"
                      onClick={() => toggle(key)}
                    >
                      <span className="ct-caret">{open ? "▾" : "▸"}</span>
                      <span className="ct-module-text">{mod.name}</span>
                      <span className="ct-module-count">{mod.masteredCount}/{mod.total}</span>
                    </button>
                    {open && (
                      <ul className="ct-topics">
                        {mod.topics.map(({ def, state: ns }) => {
                          const isActive = def.id === activeNodeId;
                          const status = ns.status;
                          return (
                            <li
                              key={def.id}
                              className={`ct-topic ${status} ${isActive ? "current" : ""}`}
                              title={`${course.name} > ${unit.name} > ${mod.name} > ${def.topic}`}
                            >
                              <button
                                className="ct-topic-btn"
                                onClick={() => onPickTopic?.(def.id)}
                                disabled={status === "locked"}
                              >
                                <span className="ct-status-dot" data-status={status} />
                                <span className="ct-topic-text">{def.topic}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}

function Dashboard({ state, nodes, onStart, activeNodeId }) {
  return (
    <>
      <TodayTasks state={state} nodes={nodes} onStart={(nodeId) => onStart(nodeId)} />
      <RecentWork state={state} nodes={nodes} />
    </>
  );
}

// ---------- Speech recognition ----------

function getRecognitionCtor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

// Accept the expected word as exact-match against any returned alternative,
// allowing leading/trailing fluff like "the cat" or "cat!".
function matchWord(expected, alternatives) {
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  const exp = norm(expected);
  if (!exp) return false;
  for (const alt of alternatives) {
    const altN = norm(alt);
    if (!altN) continue;
    if (altN === exp) return true;
    const tokens = altN.split(/\s+/);
    if (tokens.includes(exp)) return true;
  }
  return false;
}

function useSpeechRecognition() {
  const supported = !!getRecognitionCtor();
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState(null);
  const [error, setError] = useState(null);
  const ref = useRef(null);

  const stop = useCallback(() => {
    try { ref.current?.stop(); } catch {}
    setListening(false);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const listen = useCallback((expected, onComplete) => {
    if (!supported) {
      onComplete?.({ matched: false, heard: null, error: "unsupported", latencyMs: 0 });
      return;
    }
    const Ctor = getRecognitionCtor();
    const r = new Ctor();
    r.lang = "en-US";
    r.continuous = false;
    r.interimResults = false;
    r.maxAlternatives = 5;

    const startedAt = Date.now();
    let resolved = false;

    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      setListening(false);
      setHeard(payload.heard || null);
      setError(payload.error || null);
      onComplete?.({ ...payload, latencyMs: Date.now() - startedAt });
    };

    r.onresult = (e) => {
      const alts = [];
      for (let i = 0; i < e.results[0].length; i++) {
        alts.push(e.results[0][i].transcript);
      }
      const matched = matchWord(expected, alts);
      finish({ matched, heard: alts[0] || null, alts, error: null });
    };
    r.onerror = (e) => finish({ matched: false, heard: null, error: e.error || "error" });
    r.onend = () => finish({ matched: false, heard: null, error: "no-speech" });

    setHeard(null);
    setError(null);
    setListening(true);
    try { r.start(); } catch (e) { finish({ matched: false, heard: null, error: "start-failed" }); }
    ref.current = r;
  }, [supported]);

  return { supported, listening, heard, error, listen, stop };
}

function MicButton({ expected, onResult, label = "Tap to speak", disabled = false }) {
  const { supported, listening, heard, error, listen } = useSpeechRecognition();

  if (!supported) {
    return (
      <div className="mic-fallback">
        Mic recognition needs Chrome, Edge, or Safari.<br/>
        Use the Correct / Incorrect buttons below.
      </div>
    );
  }

  const handleClick = () => {
    if (listening || disabled) return;
    listen(expected, (result) => onResult?.(result));
  };

  return (
    <div className="mic-block">
      <button
        type="button"
        className={`mic-btn ${listening ? "listening" : ""}`}
        onClick={handleClick}
        disabled={disabled || listening}
        aria-label={listening ? "Listening" : label}
      >
        <span className="mic-icon">🎤</span>
        <span className="mic-label">
          {listening ? "Listening…" : label}
        </span>
      </button>
      <div className="mic-status">
        {error === "not-allowed" && "Mic blocked — allow microphone in the address bar."}
        {error === "no-speech" && "Didn't hear anything. Tap to try again."}
        {error && error !== "not-allowed" && error !== "no-speech" && `Mic error: ${error}.`}
        {!error && heard && <>Heard: <strong>"{heard}"</strong></>}
      </div>
    </div>
  );
}

// ---------- Blend task ----------
// App plays phonemes one at a time, lighting a bubble per phoneme.
// Then mic listens for the spoken whole word. ASR scores it.
function BlendTask({ item, onResult, onAdultScore }) {
  const phonemes = item.phonemes || [];
  const labels = item.phonemeLabels || phonemes.map((p) => `/${p}/`);
  const [activeIdx, setActiveIdx] = useState(-1);   // -1 before first plays
  const [played, setPlayed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const playedKeyRef = useRef(null);
  const supported = !!getRecognitionCtor();

  // Auto-play sequence on first mount per item
  useEffect(() => {
    const key = item.prompt;
    if (playedKeyRef.current === key) return;
    playedKeyRef.current = key;
    setActiveIdx(-1);
    setPlayed(false);
    setRevealed(false);

    let cancelled = false;
    const playSeq = async () => {
      for (let i = 0; i < phonemes.length; i++) {
        if (cancelled) return;
        setActiveIdx(i);
        // Speak the phoneme. Browser TTS approximates — for /sh/ we say "sh".
        speak(phonemes[i], { rate: 0.7 });
        await new Promise((r) => setTimeout(r, 850));
      }
      if (!cancelled) setPlayed(true);
    };
    const start = setTimeout(playSeq, 250);
    return () => { cancelled = true; clearTimeout(start); };
  }, [item.prompt]);

  const replay = () => {
    playedKeyRef.current = null;   // force the auto-play effect to re-run
    setActiveIdx(-1);
    setPlayed(false);
    // trigger by mutating a ref-ish dep — easiest: schedule the same logic inline
    let cancelled = false;
    (async () => {
      for (let i = 0; i < phonemes.length; i++) {
        if (cancelled) return;
        setActiveIdx(i);
        speak(phonemes[i], { rate: 0.7 });
        await new Promise((r) => setTimeout(r, 850));
      }
      if (!cancelled) setPlayed(true);
      playedKeyRef.current = item.prompt;
    })();
    return () => { cancelled = true; };
  };

  return (
    <>
      <div className="bubble-row">
        {labels.map((p, i) => (
          <div
            key={i}
            className={`bubble ${activeIdx >= i ? "filled" : ""} ${activeIdx === i ? "pulse" : ""}`}
            aria-label={`phoneme ${i + 1}`}
          >
            {activeIdx >= i ? p : i + 1}
          </div>
        ))}
      </div>
      <div className="bubble-instructions">
        {played
          ? "Now blend the sounds and say the whole word."
          : "Listen…"}
      </div>

      <div className="row" style={{ justifyContent: "center", gap: 10, marginBottom: 10 }}>
        <button className="btn ghost" onClick={replay}>▶︎ Play again</button>
        <button className="btn ghost" onClick={() => speak(item.answer, { rate: 0.85 })}>
          ▶︎ Hear blended
        </button>
        <button className="btn ghost" onClick={() => setRevealed((v) => !v)}>
          {revealed ? "Hide word" : "Reveal word"}
        </button>
      </div>
      {revealed && (
        <div className="timer">word: <strong>{item.answer}</strong></div>
      )}

      <MicButton
        expected={item.answer}
        label={`Say "${"●".repeat(item.answer.length)}"`}
        disabled={!played}
        onResult={(result) => {
          onResult({
            correct: result.matched,
            latencyMs: result.latencyMs,
            heard: result.heard,
            error: result.error,
          });
        }}
      />

      {!supported && (
        <div className="scoring-row" style={{ marginTop: 14 }}>
          <button className="btn danger" onClick={() => onAdultScore(false)}>Incorrect</button>
          <button className="btn success" onClick={() => onAdultScore(true)}>Correct</button>
        </div>
      )}
    </>
  );
}

// ---------- TTS ----------
function speak(text, { rate = 0.85, pitch = 1.05 } = {}) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = rate;
    utter.pitch = pitch;
    utter.lang = "en-US";
    // prefer a clear English voice if available
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find((v) =>
      /Samantha|Karen|Aria|Jenny|Google US English|en-US/i.test(`${v.name} ${v.lang}`),
    );
    if (preferred) utter.voice = preferred;
    window.speechSynthesis.speak(utter);
  } catch (e) {
    console.warn("TTS failed", e);
  }
}

// ---------- Read-aloud task ----------
function ReadAloudTask({ item, elapsedMs, onResult, onAdultScore }) {
  const supported = !!getRecognitionCtor();
  return (
    <>
      <div className="word">{item.prompt}</div>
      <div className="timer">
        {(elapsedMs / 1000).toFixed(1)}s · read this word out loud
      </div>
      <div className="row" style={{ justifyContent: "center", marginBottom: 14 }}>
        <button className="btn ghost" onClick={() => speak(item.prompt)}>
          ▶︎ Hear word
        </button>
      </div>
      <MicButton
        expected={item.answer}
        label="Tap and read the word"
        onResult={(result) => {
          onResult({
            correct: result.matched,
            latencyMs: result.latencyMs,
            heard: result.heard,
            error: result.error,
          });
        }}
      />
      {!supported && (
        <div className="scoring-row" style={{ marginTop: 14 }}>
          <button className="btn danger" onClick={() => onAdultScore(false)}>Incorrect</button>
          <button className="btn success" onClick={() => onAdultScore(true)}>Correct</button>
        </div>
      )}
    </>
  );
}

function Drill({ activeNode, state, items, onScore, onExit }) {
  const [idx, setIdx] = useState(0);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  const [lastResult, setLastResult] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const tickRef = useRef();
  const lastSpokenRef = useRef(null);

  useEffect(() => {
    tickRef.current = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(tickRef.current);
  }, []);

  useEffect(() => {
    setStartedAt(Date.now());
    setLastResult(null);
    setRevealed(false);
  }, [idx, activeNode?.id]);

  // Warm up voices list (Chrome/Safari load asynchronously)
  useEffect(() => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
      };
    }
  }, []);

  // Compute item info up front so all hooks run unconditionally
  const itemList = (activeNode && items[activeNode.id]) || [];
  const item = itemList.length ? itemList[idx % itemList.length] : null;
  const isAudioFirst = activeNode?.assessment === "phoneme_blend";

  // (No auto-speak here: BlendTask handles its own phoneme sequence,
  // and ReadAloudTask shows the word — no audio prompt needed.)

  if (!activeNode) {
    return (
      <div className="card empty">
        Nothing to practice. Master a node to unlock more.
      </div>
    );
  }
  if (!itemList.length || !item) {
    return (
      <div className="card empty">
        No items defined for {activeNode.id}.
      </div>
    );
  }

  const elapsedMs = Date.now() - startedAt;
  const ns = state.nodes[activeNode.id];
  const result = evaluateMastery(ns, activeNode.mastery);

  const handleScore = (correct) => {
    const latencyMs = Date.now() - startedAt;
    setLastResult({ correct, latencyMs });
    onScore(activeNode.id, { correct, latencyMs, prompt: item.prompt });
    setTimeout(() => setIdx((i) => i + 1), 350);
  };

  return (
    <>
      <div className="card">
        <div className="section-label">
          {activeNode.strand} · {activeNode.skill}
        </div>

        {isAudioFirst ? (
          <>
            <div className="section-label" style={{ textAlign: "center" }}>
              {(elapsedMs / 1000).toFixed(1)}s
            </div>
            <BlendTask
              key={`${activeNode.id}-${idx}`}
              item={item}
              onResult={({ correct, latencyMs, heard, error }) => {
                setLastResult({ correct, latencyMs, heard, error });
                onScore(activeNode.id, { correct, latencyMs, prompt: item.prompt, heard, error });
                setTimeout(() => setIdx((i) => i + 1), 600);
              }}
              onAdultScore={(correct) => handleScore(correct)}
            />
          </>
        ) : (
          <ReadAloudTask
            key={`${activeNode.id}-${idx}`}
            item={item}
            elapsedMs={elapsedMs}
            onResult={({ correct, latencyMs, heard, error }) => {
              setLastResult({ correct, latencyMs, heard, error });
              onScore(activeNode.id, { correct, latencyMs, prompt: item.prompt, heard, error });
              setTimeout(() => setIdx((i) => i + 1), 600);
            }}
            onAdultScore={(correct) => handleScore(correct)}
          />
        )}
        {lastResult && (
          <div className="toast" style={{ background: lastResult.correct ? "#e7f8ec" : "#fde7e6", color: lastResult.correct ? "#0a7a30" : "#a10a07" }}>
            {lastResult.correct ? "Correct" : "Incorrect"} · {(lastResult.latencyMs / 1000).toFixed(2)}s
            {lastResult.heard && <> · heard "{lastResult.heard}"</>}
          </div>
        )}
      </div>

      <div className="card">
        <div className="section-label">Live mastery</div>
        <div className="metric-grid">
          <div className="metric">
            <div className="v">{(result.accuracy * 100).toFixed(0)}%</div>
            <div className="l">Accuracy</div>
          </div>
          <div className="metric">
            <div className="v">{result.medianLatencyMs ? result.medianLatencyMs.toFixed(0) : 0}ms</div>
            <div className="l">Median latency</div>
          </div>
          <div className="metric">
            <div className="v">{(ns.attempts || []).length}</div>
            <div className="l">Attempts</div>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>
              Need ≥{(activeNode.mastery.read_accuracy * 100).toFixed(0)}% acc, ≤{activeNode.mastery.read_latency_ms}ms median, last {activeNode.mastery.rolling_window} attempts
            </span>
          </div>
          <div className="progress-bar" style={{ marginTop: 10 }}>
            <span style={{ width: `${Math.min(100, (Math.min((ns.attempts || []).length, activeNode.mastery.rolling_window) / activeNode.mastery.rolling_window) * 100)}%` }} />
          </div>
          {result.mastered && (
            <div className="toast" style={{ marginTop: 14 }}>Node mastered. Next node unlocked.</div>
          )}
        </div>
        <div className="row" style={{ marginTop: 18 }}>
          <button className="btn ghost" onClick={onExit}>Back to dashboard</button>
        </div>
      </div>
    </>
  );
}

// ---------- Diagnostic ----------
const DIAG_ITEMS_PER_NODE = 3;

function Diagnostic({ nodes, items, onComplete, onSkip }) {
  // Walk forward through the chain. 3 items per node.
  // Node passes when correctCount === DIAG_ITEMS_PER_NODE → mark mastered, advance.
  // Otherwise → mark active, stop. (Anything past stays locked.)
  const [nodeIdx, setNodeIdx] = useState(0);
  const [itemIdx, setItemIdx] = useState(0);
  const [nodeCorrect, setNodeCorrect] = useState(0);
  const [results, setResults] = useState([]); // { nodeId, correctCount, total }
  const [revealed, setRevealed] = useState(false);
  const [intro, setIntro] = useState(true);
  const lastSpokenRef = useRef(null);

  const node = nodes[nodeIdx];
  const itemList = (node && items[node.id]) || [];
  const item = itemList[itemIdx % itemList.length];
  const isAudioFirst = node?.assessment === "phoneme_blend";

  // Reset reveal state when item changes
  useEffect(() => { setRevealed(false); }, [nodeIdx, itemIdx]);

  if (intro) {
    return (
      <div className="card">
        <div className="section-label">Placement</div>
        <h2 style={{ fontSize: 24, margin: "8px 0 6px", letterSpacing: "-0.01em" }}>
          Quick check before we start
        </h2>
        <p style={{ color: "var(--muted)", margin: "0 0 18px" }}>
          We'll show you a few short tasks across the skill chain to figure out where to start.
          About 3 minutes. {nodes.length} skills × {DIAG_ITEMS_PER_NODE} items max.
        </p>
        <div className="row">
          <button className="btn large" onClick={() => setIntro(false)}>
            Start placement
          </button>
          <button className="btn ghost" onClick={onSkip}>
            Skip — start at the beginning
          </button>
        </div>
      </div>
    );
  }

  const recordAndAdvance = (correct) => {
    const nextCorrect = nodeCorrect + (correct ? 1 : 0);
    const nextItemIdx = itemIdx + 1;
    const itemsAnswered = itemIdx + 1;

    if (itemsAnswered < DIAG_ITEMS_PER_NODE) {
      setNodeCorrect(nextCorrect);
      setItemIdx(nextItemIdx);
      return;
    }

    // Node complete
    const nodeResult = {
      nodeId: node.id,
      correctCount: nextCorrect,
      total: DIAG_ITEMS_PER_NODE,
    };
    const nextResults = [...results, nodeResult];
    const passed = nextCorrect >= DIAG_ITEMS_PER_NODE;

    if (passed && nodeIdx + 1 < nodes.length) {
      // Advance to next node
      setResults(nextResults);
      setNodeIdx(nodeIdx + 1);
      setItemIdx(0);
      setNodeCorrect(0);
    } else {
      // Either failed (stop here) or passed last node (all mastered)
      onComplete(nextResults);
    }
  };

  if (!node || !item) {
    return <div className="card empty">Loading…</div>;
  }

  return (
    <>
      <div className="card">
        <div className="section-label">
          Placement · skill {nodeIdx + 1} of {nodes.length} · item {itemIdx + 1}/{DIAG_ITEMS_PER_NODE}
        </div>
        <div className="progress-bar" style={{ marginTop: 8 }}>
          <span style={{ width: `${((nodeIdx + (itemIdx + 1) / DIAG_ITEMS_PER_NODE) / nodes.length) * 100}%` }} />
        </div>
        <h2 style={{ fontSize: 18, margin: "16px 0 4px", letterSpacing: "-0.01em" }}>
          {node.skill}
        </h2>
        <div className="id" style={{ marginBottom: 8 }}>{node.id}</div>

        {isAudioFirst ? (
          <BlendTask
            key={`diag-${node.id}-${itemIdx}`}
            item={item}
            onResult={({ correct }) => recordAndAdvance(correct)}
            onAdultScore={(correct) => recordAndAdvance(correct)}
          />
        ) : (
          <ReadAloudTask
            key={`diag-${node.id}-${itemIdx}`}
            item={item}
            elapsedMs={0}
            onResult={({ correct }) => recordAndAdvance(correct)}
            onAdultScore={(correct) => recordAndAdvance(correct)}
          />
        )}
      </div>

      <div className="card">
        <div className="section-label">Placement so far</div>
        <ul className="node-list">
          {nodes.map((n, i) => {
            const r = results.find((x) => x.nodeId === n.id);
            const isCurrent = i === nodeIdx && !r;
            const status =
              r && r.correctCount >= r.total ? "mastered" :
              r ? "unlocked" :
              isCurrent ? "active" :
              "locked";
            return (
              <li key={n.id} className="node-row">
                <div>
                  <div className="name">{n.skill}</div>
                  <div className="id">
                    {n.id}
                    {r && <> · {r.correctCount}/{r.total} correct</>}
                  </div>
                </div>
                <NodeBadge status={status} />
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

function ProgressView({ state, nodes }) {
  const tree = useMemo(() => buildCourseTree(nodes, state), [nodes, state]);
  const summary = progressSummary(state, nodes);

  return (
    <>
      <div className="card">
        <div className="section-label">Course progress</div>
        <div className="row" style={{ marginTop: 4 }}>
          <strong style={{ fontSize: 24, letterSpacing: "-0.01em" }}>
            {summary.mastered} / {summary.total} topics mastered
          </strong>
          <div className="spacer" />
          <span style={{ color: "var(--muted)", fontSize: 14 }}>
            {summary.unlockedOrActive} in progress · {summary.locked} locked
          </span>
        </div>
        <div className="progress-bar" style={{ marginTop: 12 }}>
          <span style={{ width: `${(summary.mastered / summary.total) * 100}%` }} />
        </div>
      </div>

      {tree.map((course) => (
        <div className="card" key={course.name}>
          <div className="section-label">{course.name}</div>
          {course.units.map((unit) => (
            <div key={unit.name} className="pv-unit">
              <div className="pv-unit-name">{unit.name}</div>
              {unit.modules.map((mod) => (
                <div key={mod.name} className="pv-module">
                  <div className="pv-module-head">
                    <span className="pv-module-name">{mod.name}</span>
                    <span className="pv-module-count">{mod.masteredCount}/{mod.total}</span>
                  </div>
                  <ul className="pv-topic-list">
                    {mod.topics.map(({ def, state: ns }) => {
                      const result = evaluateMastery(ns, def.mastery);
                      const attempts = (ns.attempts || []).length;
                      return (
                        <li key={def.id} className="pv-topic">
                          <div className="pv-topic-head">
                            <div>
                              <div className="pv-topic-name">{def.topic}</div>
                              <div className="id">{def.id} · {def.skill}</div>
                            </div>
                            <NodeBadge status={ns.status} />
                          </div>
                          {attempts > 0 && (
                            <>
                              <div className="pv-stats">
                                <div className="pv-stat">
                                  <div className="pv-stat-v">{(result.accuracy * 100).toFixed(0)}%</div>
                                  <div className="pv-stat-l">accuracy</div>
                                </div>
                                <div className="pv-stat">
                                  <div className="pv-stat-v">{result.medianLatencyMs ? result.medianLatencyMs.toFixed(0) : 0}ms</div>
                                  <div className="pv-stat-l">median latency</div>
                                </div>
                                <div className="pv-stat">
                                  <div className="pv-stat-v">{attempts}</div>
                                  <div className="pv-stat-l">attempts</div>
                                </div>
                              </div>
                              <div className="progress-bar" style={{ marginTop: 10 }}>
                                <span style={{
                                  width: `${Math.min(100, (Math.min(attempts, def.mastery.rolling_window) / def.mastery.rolling_window) * 100)}%`
                                }} />
                              </div>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

export default function App() {
  const { session, student, status, refresh: refreshAuth, continueAsGuest } = useAuth();

  if (status === "loading") {
    return <FullScreenMessage>Loading…</FullScreenMessage>;
  }
  if (status === "anonymous") {
    return <Login onGuest={continueAsGuest} />;
  }
  if (status === "unlinked") {
    return (
      <AccountUnlinked
        email={session?.user?.email}
        onRefresh={refreshAuth}
        onGuest={continueAsGuest}
      />
    );
  }

  // Either "ready" (authed + linked student) or "guest" (no auth).
  // Pass studentId=null to the inner component for guest mode so it
  // skips Supabase reads/writes.
  const studentId = status === "ready" ? student?.id : null;
  const studentName = status === "ready" ? student?.display_name : null;
  const isAuthed = status === "ready";

  return (
    <ReadingAcademyApp
      studentId={studentId}
      studentName={studentName}
      isAuthed={isAuthed}
    />
  );
}

function FullScreenMessage({ children }) {
  return (
    <div className="login-shell">
      <div className="login-card" style={{ textAlign: "center" }}>
        <div className="brand-mark">VPA · Reading Academy</div>
        <p className="login-sub">{children}</p>
      </div>
    </div>
  );
}

function ReadingAcademyApp({ studentId, studentName, isAuthed }) {
  // First paint comes from localStorage (warm cache + offline-safe).
  // If a Supabase student is signed in, we hydrate from the cloud
  // afterwards.
  const [state, setState] = useState(() => {
    const local = migrateState(readLocal());
    const initial = local || freshState();
    if (studentName && initial.name !== studentName) {
      initial.name = studentName;
    }
    return cascadeUnlock(initial);
  });
  const initialView = state.diagnosticComplete ? "dashboard" : "diagnostic";
  const [view, setView] = useState(initialView);
  const [drillNodeId, setDrillNodeId] = useState(null);

  const nodes = skillNodesData;
  const items = assessmentItemsData;
  const activeNodeId = useMemo(() => selectActiveNode(state, nodes), [state, nodes]);
  const drillNode = nodes.find((n) => n.id === (drillNodeId || activeNodeId));
  const xp = useMemo(() => getDailyXp(state, nodes), [state, nodes]);

  // Hydrate from Supabase once on sign-in. If there's nothing there,
  // upload the local state we already have so the cloud has a copy.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!studentId || hydratedRef.current) return;
    let cancelled = false;
    (async () => {
      const cloudState = await loadFromSupabase(studentId);
      if (cancelled) return;
      if (cloudState) {
        const next = cascadeUnlock(migrateState(cloudState));
        setState(next);
        if (next.diagnosticComplete) setView("dashboard");
      } else {
        // First-time signed-in student — push the current local state
        // up so the row exists.
        await saveToSupabase(studentId, state);
      }
      hydratedRef.current = true;
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);

  // Persist on every state change. Local always; Supabase only when
  // we have a linked student.
  useEffect(() => {
    writeLocal(state);
    if (studentId && hydratedRef.current) {
      saveToSupabase(studentId, state);
    }
  }, [state, studentId]);

  const handleScore = (nodeId, attempt) => {
    setState((prev) => {
      const node = nodes.find((n) => n.id === nodeId);
      return recordAttempt(prev, nodeId, attempt, node?.mastery);
    });
  };

  const handleDiagnosticComplete = (results) => {
    setState((prev) => applyDiagnostic(prev, results, nodes));
    setView("dashboard");
  };

  const handleDiagnosticSkip = () => {
    setState((prev) => {
      const next = structuredClone(prev);
      next.diagnosticComplete = true;
      return cascadeUnlock(next);
    });
    setView("dashboard");
  };

  const handleReset = () => {
    if (!confirm("Reset all progress and re-take placement?")) return;
    const fresh = cascadeUnlock(freshState());
    if (studentName) fresh.name = studentName;
    setState(fresh);
    setView("diagnostic");
  };

  const startDrill = (nodeId) => {
    setDrillNodeId(nodeId || null);
    setView("drill");
  };

  const showTabs = view !== "diagnostic";
  const showRail = view !== "diagnostic";

  return (
    <div className={`app ${showRail ? "with-rail" : ""}`}>
      <div className="header">
        <h1>Reading Academy</h1>
        <div className="header-right">
          <div className="xp-block" title={`${xp.xp} of ${xp.target} XP today`}>
            <XpRing xp={xp.xp} target={xp.target} />
            <div className="xp-meta">
              <div className="xp-meta-top">Daily goal</div>
              <div className="xp-meta-mid">{xp.xp} <span>/ {xp.target}</span></div>
              <div className="xp-meta-bot">{state.name}</div>
            </div>
          </div>
          {isAuthed && (
            <button
              type="button"
              className="btn ghost"
              onClick={signOut}
              title="Sign out"
              style={{ marginLeft: 12 }}
            >
              Sign out
            </button>
          )}
        </div>
      </div>

      <div className="shell">
        {showRail && (
          <aside className="rail">
            <CourseTree
              state={state}
              nodes={nodes}
              activeNodeId={activeNodeId}
              onPickTopic={(nodeId) => {
                const ns = state.nodes[nodeId];
                if (!ns || ns.status === "locked") return;
                startDrill(nodeId);
              }}
            />
          </aside>
        )}

        <main className="main">
          {showTabs && (
            <div className="tabs">
              <button className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}>Today</button>
              <button className={view === "drill" ? "active" : ""} onClick={() => setView("drill")}>Practice</button>
              <button className={view === "progress" ? "active" : ""} onClick={() => setView("progress")}>Progress</button>
            </div>
          )}

          {view === "diagnostic" && (
            <Diagnostic
              nodes={nodes}
              items={items}
              onComplete={handleDiagnosticComplete}
              onSkip={handleDiagnosticSkip}
            />
          )}
          {view === "dashboard" && (
            <Dashboard
              state={state}
              nodes={nodes}
              activeNodeId={activeNodeId}
              onStart={(nodeId) => startDrill(nodeId)}
            />
          )}
          {view === "drill" && (
            <Drill
              activeNode={drillNode}
              state={state}
              items={items}
              onScore={handleScore}
              onExit={() => { setDrillNodeId(null); setView("dashboard"); }}
            />
          )}
          {view === "progress" && (
            <ProgressView state={state} nodes={nodes} />
          )}

          <div style={{ textAlign: "center", marginTop: 32 }}>
            <button className="btn ghost" onClick={handleReset}>Reset progress</button>
          </div>
        </main>
      </div>
    </div>
  );
}
