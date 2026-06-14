// src/lib/diagnosticPlan.js
//
// Grade-aware placement support for the Reading Academy diagnostic.
//
// The diagnostic used to walk every testable node from the front of the
// graph (K phonemic awareness) forward, stopping at the first miss. That
// is fine for a kindergartener but unusable for a 4th grader: they had to
// grind through ~50 phonics nodes before reaching grade-level work, and a
// single slip on an obscure phonics node placed them in kindergarten.
//
// This module gives the diagnostic two things:
//   1. A grade band (K=0 .. 5) for every node, derived from id/strand —
//      no data migration, the band is computed.
//   2. Helpers to order nodes easy->hard and to find the entry point for
//      a student's declared grade, so the walk can START at grade level
//      and adaptively descend only if the student misses.
//
// Pure functions. No React, no side effects.

// Phonics strands map cleanly onto K-2 bands.
const STRAND_BAND = {
  "Phonemic Awareness": 0,
  "Letter-Sound Foundations": 0,
  CVC: 1,
  "High-Frequency Words": 1,
  "Initial Blends": 1,
  "Final Blends": 1,
  Digraph: 1,
  Trigraph: 1,
  "Inflectional Endings": 2,
  "Silent-e": 2,
  "Vowel Teams": 2,
  "R-Controlled": 2,
  "Soft C/G": 2,
  Multisyllabic: 2,
};

/**
 * Grade band for a node: 0 (Kindergarten) through 5 (5th grade).
 *
 * Phase B strands (Comprehension, Morphology, Knowledge Arcs, Fluency)
 * are keyed off the node id so a single strand can span several grades
 * (e.g. COMP_01-04 are 2nd grade, COMP_14-16 are 5th).
 */
export function gradeBandForNode(node) {
  if (!node) return 0;
  const id = node.id || "";

  // Comprehension: COMP_NN — 01-04 G2, 05-08 G3, 09-13 G4, 14+ G5.
  let m = id.match(/^COMP_(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n <= 4) return 2;
    if (n <= 8) return 3;
    if (n <= 13) return 4;
    return 5;
  }

  // Knowledge arcs: KARC_NN — 01 G3, 02-03 G4, 04+ G5.
  m = id.match(/^KARC_(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n <= 1) return 3;
    if (n <= 3) return 4;
    return 5;
  }

  // Morphology: decomposition probes (G4) and roots (G4) are harder
  // than prefixes/suffixes (G3).
  if (id.startsWith("MORPH_SEG_")) return 4;
  if (id.startsWith("MORPH_R_")) return 4;
  if (id.startsWith("MORPH_")) return 3;

  // Fluency gates: FL_NN — 01-02 G1, 03 G2, 04-05 G3, 06 G4, 07+ G5.
  m = id.match(/^FL_(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n <= 2) return 1;
    if (n === 3) return 2;
    if (n <= 5) return 3;
    if (n === 6) return 4;
    return 5;
  }

  // Phonics strands by name.
  if (node.strand && STRAND_BAND[node.strand] != null) {
    return STRAND_BAND[node.strand];
  }
  return 0;
}

/**
 * Order a node list easy -> hard: primary key grade band, secondary key
 * the node's original position (preserves within-strand sequencing).
 * Returns a NEW array; input is not mutated.
 */
export function orderByDifficulty(nodes) {
  return nodes
    .map((node, idx) => ({ node, band: gradeBandForNode(node), idx }))
    .sort((a, b) => a.band - b.band || a.idx - b.idx)
    .map((x) => x.node);
}

/**
 * Index into an already-difficulty-ordered list where a student of the
 * given grade should START. Grade 0 (or unknown) starts at the front,
 * preserving the original K-first behavior.
 */
export function entryIndexForGrade(orderedNodes, grade) {
  if (!grade || grade <= 0) return 0;
  const i = orderedNodes.findIndex((n) => gradeBandForNode(n) >= grade);
  if (i === -1) return Math.max(0, orderedNodes.length - 1);
  return i;
}

/**
 * Given a difficulty-ordered list and a current index, return the index
 * of the first node in the band immediately below the current node's
 * band — the next checkpoint to drop to when a student misses at their
 * declared level. Returns -1 when the current node is already in the
 * easiest band (nothing lower to test).
 */
export function prevBandStartIndex(orderedNodes, currentIndex) {
  const cur = orderedNodes[currentIndex];
  if (!cur) return -1;
  let targetBand = gradeBandForNode(cur) - 1;
  while (targetBand >= 0) {
    const i = orderedNodes.findIndex(
      (n) => gradeBandForNode(n) === targetBand,
    );
    if (i !== -1) return i;
    targetBand -= 1;
  }
  return -1;
}

/**
 * Reduce a difficulty-ordered node list to a short list of CHECKPOINT
 * nodes — at most `perBand` per grade band, spread evenly across the
 * band (always including the band's first and last node when perBand
 * >= 2). The adaptive walk tests checkpoints rather than every node so
 * placement stays short (~3-8 skills) instead of grinding a strong
 * reader through all 35 nodes of a band.
 *
 * Input must already be difficulty-ordered (see orderByDifficulty).
 */
export function pickCheckpoints(orderedNodes, perBand = 2) {
  const byBand = new Map();
  for (const n of orderedNodes) {
    const b = gradeBandForNode(n);
    if (!byBand.has(b)) byBand.set(b, []);
    byBand.get(b).push(n);
  }
  const out = [];
  for (const band of [...byBand.keys()].sort((a, b) => a - b)) {
    const group = byBand.get(band);
    if (perBand <= 1) {
      out.push(group[0]);
      continue;
    }
    if (group.length <= perBand) {
      out.push(...group);
      continue;
    }
    for (let i = 0; i < perBand; i += 1) {
      const idx = Math.round((i * (group.length - 1)) / (perBand - 1));
      out.push(group[idx]);
    }
  }
  return out;
}

// Grade choices for the placement picker. `grade` feeds entryIndexForGrade;
// 0 == "start from the very beginning" (Kindergarten / unsure).
export const GRADE_OPTIONS = [
  { grade: 0, label: "Kindergarten", hint: "Just starting to read" },
  { grade: 1, label: "1st Grade", hint: "Sounding out words" },
  { grade: 2, label: "2nd Grade", hint: "Reading short stories" },
  { grade: 3, label: "3rd Grade", hint: "Reading to learn" },
  { grade: 4, label: "4th Grade", hint: "Longer passages" },
  { grade: 5, label: "5th Grade", hint: "Complex texts" },
];

export const GRADE_LABELS = [
  "Kindergarten",
  "1st Grade",
  "2nd Grade",
  "3rd Grade",
  "4th Grade",
  "5th Grade",
];
