// masteryEngine.js
// Pure functions. Takes (state, nodes) and returns derived data or new state.

const MASTERY_DEFAULTS = {
  read_accuracy: 0.9,
  read_latency_ms: 2500,
  rolling_window: 10,
};

// ---------- helpers ----------

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function getNodeRecentAttempts(node, window) {
  const attempts = node.attempts || [];
  return attempts.slice(-window);
}

// ---------- mastery check ----------

export function evaluateMastery(node, criteria = MASTERY_DEFAULTS) {
  const window = criteria.rolling_window ?? MASTERY_DEFAULTS.rolling_window;
  const recent = getNodeRecentAttempts(node, window);
  if (recent.length < window) {
    return {
      mastered: false,
      accuracy: rollingAccuracy(node, window),
      medianLatencyMs: rollingMedianLatency(node, window),
      attemptsNeeded: window - recent.length,
    };
  }
  const accuracy = recent.filter((a) => a.correct).length / recent.length;
  const medianLatencyMs = median(recent.map((a) => a.latencyMs));
  const mastered =
    accuracy >= (criteria.read_accuracy ?? MASTERY_DEFAULTS.read_accuracy) &&
    medianLatencyMs <= (criteria.read_latency_ms ?? MASTERY_DEFAULTS.read_latency_ms);
  return { mastered, accuracy, medianLatencyMs, attemptsNeeded: 0 };
}

export function rollingAccuracy(node, window = MASTERY_DEFAULTS.rolling_window) {
  const recent = getNodeRecentAttempts(node, window);
  if (!recent.length) return 0;
  return recent.filter((a) => a.correct).length / recent.length;
}

export function rollingMedianLatency(node, window = MASTERY_DEFAULTS.rolling_window) {
  const recent = getNodeRecentAttempts(node, window);
  if (!recent.length) return 0;
  return median(recent.map((a) => a.latencyMs));
}

// ---------- attempts ----------

export function recordAttempt(state, nodeId, attempt, criteria) {
  const next = structuredClone(state);
  const node = next.nodes[nodeId];
  if (!node) return state;
  node.attempts = [...(node.attempts || []), { ...attempt, ts: Date.now() }];
  if (node.status === "unlocked") node.status = "active";
  if (node.status === "active" || node.status === "practicing") {
    node.status = "practicing";
  }
  const result = evaluateMastery(node, criteria);
  if (result.mastered) {
    node.status = "mastered";
    node.masteredAt = Date.now();
    cascadeUnlock(next);
  }
  return next;
}

// ---------- prerequisite unlocking ----------

export function cascadeUnlock(state) {
  // mutates state.nodes in place; relies on globalThis.__skillNodes set by app
  const nodes = globalThis.__skillNodes || [];
  for (const def of nodes) {
    const ns = state.nodes[def.id];
    if (!ns) continue;
    if (ns.status !== "locked") continue;
    const allPrereqsMastered = def.prereqs.every(
      (p) => state.nodes[p]?.status === "mastered",
    );
    if (allPrereqsMastered) ns.status = "unlocked";
  }
  return state;
}

// ---------- M16-K3: autonomous-mode prerequisite unlocking ----------
//
// Autonomous students can never master a teacher-led prereq on their own
// (PA_01 isolation, LS_01 letter-sound, etc.). Without special handling,
// every CVC node and most downstream phonics nodes stay locked behind
// teacher-checks the autonomous student has no way to satisfy.
//
// Solution: for autonomous-mode unlocking, treat teacher-led prereqs as
// SOFT — they don't block downstream progression. A teacher-led prereq
// is satisfied if the node is mastered OR if it's teacher-led (the
// student is presumed to have it; teachers can still verify in-person
// via teacher mode and the observation queue).
//
// Hard-mode unlock (the original cascadeUnlock above) is still used by
// the teacher-administered diagnostic and any teacher-mode workflow,
// where teacher-led mastery IS gathered through observation.
function isPrereqSatisfiedAutonomous(prereqId, state, byId) {
  const ns = state.nodes[prereqId];
  if (ns?.status === "mastered") return true;
  const def = byId.get(prereqId);
  // M16-K3: teacher-led prereqs auto-satisfy in autonomous mode. The
  // student is treated as having the underlying skill so downstream
  // auto-scorable work isn't artificially blocked. The actual mastery
  // is then proven (or refuted) by the auto-scorable work itself —
  // a student who can read CVC words demonstrably has the prereqs.
  if (def?.requires_teacher_scoring) return true;
  return false;
}

export function cascadeUnlockAutonomous(state, nodeDefs) {
  const nodes = nodeDefs || globalThis.__skillNodes || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const def of nodes) {
    const ns = state.nodes[def.id];
    if (!ns) continue;
    if (ns.status !== "locked") continue;
    const ok = (def.prereqs || []).every((p) =>
      isPrereqSatisfiedAutonomous(p, state, byId),
    );
    if (ok) ns.status = "unlocked";
  }
  return state;
}

// ---------- selecting today's task ----------

export function selectActiveNode(state, nodeDefs) {
  // priority: practicing > unlocked-in-graph-order
  const order = nodeDefs.map((n) => n.id);
  const practicing = order.find(
    (id) => state.nodes[id]?.status === "practicing",
  );
  if (practicing) return practicing;
  const active = order.find((id) => state.nodes[id]?.status === "active");
  if (active) return active;
  const unlocked = order.find((id) => state.nodes[id]?.status === "unlocked");
  return unlocked || null;
}

// M16-K2 / M16-K3: autonomous-mode active-node selection. Skips any
// teacher-led node so an autonomous student is never offered a task
// they can't complete on their own. Same priority chain otherwise.
export function selectActiveNodeAutonomous(state, nodeDefs) {
  const order = nodeDefs.filter((n) => !n.requires_teacher_scoring);
  const ids = order.map((n) => n.id);
  const practicing = ids.find(
    (id) => state.nodes[id]?.status === "practicing",
  );
  if (practicing) return practicing;
  const active = ids.find((id) => state.nodes[id]?.status === "active");
  if (active) return active;
  const unlocked = ids.find((id) => state.nodes[id]?.status === "unlocked");
  return unlocked || null;
}

// ---------- diagnostic ----------

// Apply diagnostic results: an array of { nodeId, correctCount, total }.
// Forward-walk semantics: nodes with correctCount === total are marked mastered;
// the first node that fails becomes unlocked (active); everything after stays locked.
export function applyDiagnostic(state, results, nodeDefs) {
  const next = structuredClone(state);
  let stoppedAt = null;
  for (const r of results) {
    const n = next.nodes[r.nodeId];
    if (!n) continue;
    if (r.correctCount >= r.total) {
      n.status = "mastered";
      n.masteredAt = Date.now();
      n.diagnostic = { ...r, ts: Date.now() };
    } else {
      n.status = "unlocked";
      n.diagnostic = { ...r, ts: Date.now() };
      stoppedAt = r.nodeId;
      break;
    }
  }
  // Anything past the stop point stays locked; anything not visited stays locked.
  next.diagnosticComplete = true;
  cascadeUnlock(next);
  return next;
}

export function progressSummary(state, nodeDefs) {
  const total = nodeDefs.length;
  let mastered = 0;
  let unlockedOrActive = 0;
  let locked = 0;
  for (const def of nodeDefs) {
    const s = state.nodes[def.id]?.status;
    if (s === "mastered") mastered++;
    else if (s === "locked") locked++;
    else unlockedOrActive++;
  }
  return { total, mastered, unlockedOrActive, locked };
}

// ---------- XP & activity ----------

const DAY_MS = 24 * 60 * 60 * 1000;
const XP_DAILY_TARGET = 30;

function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function xpForAttempt(node, attempt) {
  if (!attempt?.correct) return 0;
  return node?.xpPerItem ?? 1;
}

// Calculate XP earned from attempts in a window (default: today).
export function getDailyXp(state, nodeDefs, sinceMs = startOfDay()) {
  let xp = 0;
  for (const def of nodeDefs) {
    const ns = state.nodes[def.id];
    if (!ns) continue;
    for (const a of ns.attempts || []) {
      if ((a.ts ?? 0) >= sinceMs && a.correct) xp += def.xpPerItem ?? 1;
    }
    if (ns.masteredAt && ns.masteredAt >= sinceMs) {
      xp += def.xpOnMastery ?? 0;
    }
  }
  return { xp, target: XP_DAILY_TARGET };
}

// All attempts across all nodes, newest first, with node metadata attached.
export function getRecentAttempts(state, nodeDefs, limit = 12) {
  const all = [];
  for (const def of nodeDefs) {
    const ns = state.nodes[def.id];
    if (!ns) continue;
    for (const a of ns.attempts || []) {
      all.push({ ...a, nodeId: def.id, node: def });
    }
  }
  all.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return all.slice(0, limit);
}

// Mastered nodes sorted by most recent first.
export function getRecentMasteries(state, nodeDefs, limit = 5) {
  const list = [];
  for (const def of nodeDefs) {
    const ns = state.nodes[def.id];
    if (ns?.status === "mastered") {
      list.push({ node: def, masteredAt: ns.masteredAt ?? 0 });
    }
  }
  list.sort((a, b) => b.masteredAt - a.masteredAt);
  return list.slice(0, limit);
}

// Build "today's tasks" — Math Academy-style task menu.
// Returns up to `limit` cards: 1 lesson on the active node, 1-2 reviews
// on recently-mastered nodes, and a fluency drill if any fluency node is unlocked.
export function getTodayTasks(state, nodeDefs, limit = 4) {
  const tasks = [];

  // Active lesson
  const activeId = selectActiveNode(state, nodeDefs);
  if (activeId) {
    const def = nodeDefs.find((n) => n.id === activeId);
    tasks.push({
      id: `lesson:${activeId}`,
      type: "Lesson",
      nodeId: activeId,
      node: def,
      title: def.topic || def.skill,
      subtitle: def.module,
      items: 6,
      estMinutes: 3,
      xp: (def.xpPerItem ?? 1) * 6,
    });
  }

  // Reviews — pull mastered nodes, prioritize the most recently mastered
  const masteries = getRecentMasteries(state, nodeDefs, 5);
  for (const { node } of masteries) {
    if (tasks.length >= limit) break;
    if (node.id === activeId) continue;
    tasks.push({
      id: `review:${node.id}`,
      type: "Review",
      nodeId: node.id,
      node,
      title: node.topic || node.skill,
      subtitle: node.module,
      items: 3,
      estMinutes: 1,
      xp: Math.ceil((node.xpPerItem ?? 1) * 3 * 0.5),
    });
  }

  return tasks;
}

// Group nodes by course → unit → module for the tree UI.
export function buildCourseTree(nodeDefs, state) {
  const tree = [];
  const byCourse = new Map();

  for (const def of nodeDefs) {
    const courseKey = def.course || "Uncategorized";
    let course = byCourse.get(courseKey);
    if (!course) {
      course = { name: courseKey, units: new Map() };
      byCourse.set(courseKey, course);
      tree.push(course);
    }
    const unitKey = def.unit || "—";
    let unit = course.units.get(unitKey);
    if (!unit) {
      unit = { name: unitKey, modules: new Map() };
      course.units.set(unitKey, unit);
    }
    const moduleKey = def.module || "—";
    let mod = unit.modules.get(moduleKey);
    if (!mod) {
      mod = { name: moduleKey, topics: [] };
      unit.modules.set(moduleKey, mod);
    }
    mod.topics.push({
      def,
      state: state.nodes[def.id] || { status: "locked", attempts: [] },
    });
  }

  // Convert maps to arrays + counts
  return tree.map((course) => ({
    name: course.name,
    units: Array.from(course.units.values()).map((unit) => ({
      name: unit.name,
      modules: Array.from(unit.modules.values()).map((m) => {
        const masteredCount = m.topics.filter((t) => t.state.status === "mastered").length;
        return {
          name: m.name,
          topics: m.topics,
          masteredCount,
          total: m.topics.length,
        };
      }),
    })),
  }));
}
