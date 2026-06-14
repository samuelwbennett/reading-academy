// Passage recommender — v1 (M1-E).
//
// Implements a simplified version of the Agent #5 recommender contract:
//   - filter by passage-level gpcInventory ⊆ student.mastered ∪ {active}
//     (word-level requiredNodes tagging is M2 work; v1 uses passage-level
//      inventory as a coarse proxy).
//   - filter by intent: cold_gate_attempt → only cold passages for the
//     specified gate; lesson_practice / review → only non-cold passages.
//   - sort by difficultyRank ascending (easier first).
//
// What v1 doesn't do yet (M2+):
//   - 30-day cold-pool consumption lockout per student.
//   - Recency penalty per student-passage pair.
//   - Word-level requiredNodes computation.

import { unrollPrereqs } from "./prereqUtils.js";

export function recommendPassages(request, allPassages, nodeDefs) {
  const masteredSet = unrollPrereqs(
    [
      ...(request.studentMasteredNodeIds || []),
      ...(request.studentActiveNodeId ? [request.studentActiveNodeId] : []),
    ],
    nodeDefs,
  );

  const intent = request.intent || "lesson_practice";
  const candidates = [];

  for (const p of allPassages) {
    // 1. Cold-pool isolation.
    if (intent === "cold_gate_attempt") {
      if (!p.isCold) continue;
      if (request.fluencyGateId && p.gateId !== request.fluencyGateId) continue;
    } else {
      if (p.isCold) continue;
    }

    // 2. Decodability — every node in the passage's gpcInventory must be in
    //    the student's mastered/active prereq closure.
    const inventory = p.gpcInventory || [];
    const decodableInventory = inventory.every((node) => masteredSet.has(node));
    if (!decodableInventory) continue;

    // 3. Surface the candidate.
    candidates.push({
      passageId: p.passageId,
      gateId: p.gateId,
      isCold: !!p.isCold,
      wordCount: p.wordCount,
      difficultyRank: p.difficultyRank,
      topic: p.topic,
      decodabilityScore: 1.0, // passage-level proxy until per-word tagging lands
      passage: p,
    });
  }

  // 4. Sort: easier first by difficulty rank, ties broken by passageId.
  candidates.sort(
    (a, b) =>
      (a.difficultyRank || 0) - (b.difficultyRank || 0) ||
      (a.passageId || "").localeCompare(b.passageId || ""),
  );

  return candidates;
}

// Convenience: pick the next passage to read given full state.
//   1. If active node is a fluency gate (FL_xx), prefer a cold passage for it.
//   2. Else, return the easiest practice passage compatible with the student.
//   3. Returns null if nothing matches.
export function pickNextPassage(state, nodeDefs, allPassages) {
  const masteredIds = Object.entries(state.nodes || {})
    .filter(([_id, ns]) => ns.status === "mastered")
    .map(([id]) => id);
  const activeId = Object.entries(state.nodes || {})
    .find(([_id, ns]) => ns.status === "active" || ns.status === "practicing")
    ?.[0] || null;

  const isGate = (n) => /^FL_\d+/.test(n.id);
  const activeNode = nodeDefs.find((n) => n.id === activeId);

  if (activeNode && isGate(activeNode)) {
    const cold = recommendPassages(
      {
        studentMasteredNodeIds: masteredIds,
        studentActiveNodeId: activeId,
        intent: "cold_gate_attempt",
        fluencyGateId: activeNode.id,
      },
      allPassages,
      nodeDefs,
    );
    if (cold.length) return cold[0];
  }

  const practice = recommendPassages(
    {
      studentMasteredNodeIds: masteredIds,
      studentActiveNodeId: activeId,
      intent: "lesson_practice",
    },
    allPassages,
    nodeDefs,
  );
  return practice[0] || null;
}
