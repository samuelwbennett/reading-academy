// Prereq closure helper. Given a list of "owned" node IDs (mastered or active)
// and the full node definitions, returns a Set containing those IDs plus all
// their transitive prereqs.
//
// Used by passageRecommender to compute the student's effective decoding
// inventory: a student who has mastered DG_sh implicitly has everything
// upstream (BL_FIN, CVC_short_a, LS_01, PA_01, etc.).

export function unrollPrereqs(seedIds, nodeDefs) {
  const byId = new Map(nodeDefs.map((n) => [n.id, n]));
  const out = new Set();
  const stack = [...seedIds];
  while (stack.length) {
    const id = stack.pop();
    if (!id || out.has(id)) continue;
    out.add(id);
    const node = byId.get(id);
    if (!node) continue;
    for (const p of node.prereqs || []) stack.push(p);
  }
  return out;
}
