#!/usr/bin/env node
// validate-content.js
//
// CI-friendly validator for the three live data files:
//   - src/data/skill_nodes.json
//   - src/data/assessment_items.json
//   - src/data/passages.json
//
// Runs a series of named checks. Each check produces:
//   - errors   → block CI (exit 1)
//   - warnings → log but don't block
//   - info     → log under -v
//
// Usage:
//   node scripts/validate-content.js          # check + summary
//   node scripts/validate-content.js -v       # also print info lines
//   node scripts/validate-content.js --strict # warnings count as errors
//
// Add to package.json scripts as "validate": "node scripts/validate-content.js"
// to run before deployment.

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const VERBOSE = process.argv.includes("-v") || process.argv.includes("--verbose");
const STRICT = process.argv.includes("--strict");

// Item-type → minimum bank size, per Agent #3 catalog v1.0.
const MIN_ITEMS = {
  phoneme_isolate_initial: 20,
  phoneme_isolate_final: 20,
  phoneme_isolate_medial: 20,
  phoneme_blend: 20,
  phoneme_segment: 20,
  phoneme_delete_initial: 20,
  phoneme_delete_final: 20,
  phoneme_substitute: 20,
  letter_sound: 8, // bank IS the letter set; varies by node
  read_aloud: 24,
  cold_passage: 6,
};

const KNOWN_ASSESSMENTS = new Set(Object.keys(MIN_ITEMS));

// Per-node bank-size overrides: when a node's inventory has a hard ceiling
// (HFW = N words; TG_tch_dge = ~16 viable -tch/-dge words; vowel-only LS
// nodes are 2–3 letters lowercase). The validator honors these as the
// minimum instead of the type-level floor.
const BANK_MIN_OVERRIDES = {
  HFW_01a_anchors: 6,
  HFW_01b_set1: 19,
  HFW_02_set2: 23,
  TG_tch_dge: 16,
  LS_03_short_vowels_ai: 2,
  LS_04_short_vowels_oue: 3,
};

const errors = [];
const warnings = [];
const info = [];

function err(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }
function inf(msg) { info.push(msg); }

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    err(`could not read ${path}: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log("[validate-content] running…");

  const nodes = await readJson(join(ROOT, "src/data/skill_nodes.json"));
  const items = await readJson(join(ROOT, "src/data/assessment_items.json"));
  const passagesDoc = await readJson(join(ROOT, "src/data/passages.json"));
  const passages = passagesDoc?.passages || [];

  if (!nodes || !items) {
    print();
    process.exit(1);
  }

  // ----- 1. Skill graph integrity ---------------------------------------
  const nodeIds = new Set(nodes.map((n) => n.id));
  const adj = new Map(nodes.map((n) => [n.id, n.prereqs || []]));

  for (const n of nodes) {
    if (!n.id) err(`node missing 'id'`);
    if (!Array.isArray(n.prereqs)) err(`${n.id}: prereqs must be array`);
    if (!KNOWN_ASSESSMENTS.has(n.assessment)) {
      warn(`${n.id}: unknown assessment type "${n.assessment}"`);
    }
    if (!n.mastery) warn(`${n.id}: missing mastery config`);
    for (const p of n.prereqs || []) {
      if (!nodeIds.has(p)) err(`${n.id}: prereq "${p}" not in graph`);
      if (p === n.id) err(`${n.id}: self-prerequisite`);
    }
  }

  // DAG check (Tarjan).
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...nodeIds].map((id) => [id, WHITE]));
  const cycles = [];
  function dfs(u, path) {
    color.set(u, GRAY);
    for (const v of adj.get(u) || []) {
      if (!nodeIds.has(v)) continue;
      if (color.get(v) === GRAY) {
        cycles.push([...path, u, v].join(" → "));
        continue;
      }
      if (color.get(v) === WHITE) dfs(v, [...path, u]);
    }
    color.set(u, BLACK);
  }
  for (const id of nodeIds) if (color.get(id) === WHITE) dfs(id, []);
  for (const c of cycles) err(`cycle in skill graph: ${c}`);

  const roots = nodes.filter((n) => (n.prereqs || []).length === 0);
  const leaves = nodes.filter((n) => !nodes.some((m) => (m.prereqs || []).includes(n.id)));
  if (roots.length === 0) err(`no root node — graph is unreachable`);
  if (roots.length > 1) warn(`multiple root nodes (${roots.length}): ${roots.map((n) => n.id).join(", ")}`);
  inf(`skill graph: ${nodes.length} nodes, ${roots.length} root, ${leaves.length} leaf`);

  // ----- 2. Item bank checks --------------------------------------------
  for (const itemKey of Object.keys(items)) {
    if (!nodeIds.has(itemKey)) {
      warn(`orphan item bank "${itemKey}" — node not in graph (drop or migrate)`);
    }
  }

  for (const node of nodes) {
    const bank = items[node.id];
    if (!bank || !Array.isArray(bank) || bank.length === 0) {
      inf(`${node.id}: no items authored yet (M2 backlog)`);
      continue;
    }
    const minRequired =
      BANK_MIN_OVERRIDES[node.id] ?? MIN_ITEMS[node.assessment] ?? 10;
    if (bank.length < minRequired) {
      warn(`${node.id}: ${bank.length} items, minimum ${minRequired} for type ${node.assessment}`);
    }

    // Per-item shape checks.
    for (let i = 0; i < bank.length; i++) {
      const item = bank[i];
      if (!item || typeof item !== "object") {
        err(`${node.id} item[${i}]: not an object`);
        continue;
      }
      if (!item.prompt) err(`${node.id} item[${i}]: missing 'prompt'`);
      if (!("answer" in item)) err(`${node.id} item[${i}]: missing 'answer'`);

      // Type-specific.
      if (node.assessment === "phoneme_blend" || node.assessment === "phoneme_segment") {
        if (!Array.isArray(item.phonemes)) {
          warn(`${node.id} item[${i}] (${node.assessment}): missing 'phonemes' array`);
        }
      }
    }

    // Diversity heuristic — flag if ≥40% of items share the same CVC pattern
    // (rough check via first+last consonant signature). Read-aloud only.
    if (node.assessment === "read_aloud") {
      const sigCounts = {};
      for (const it of bank) {
        const w = (it.prompt || "").toLowerCase().replace(/[^a-z]/g, "");
        if (w.length < 2) continue;
        const sig = `${w[0]}_${w[w.length - 1]}`;
        sigCounts[sig] = (sigCounts[sig] || 0) + 1;
      }
      const max = Math.max(0, ...Object.values(sigCounts));
      if (max / bank.length >= 0.4) {
        warn(`${node.id}: ≥40% of items share a single first-last consonant signature; spread the bank`);
      }
    }
  }

  // ----- 3. Passages --------------------------------------------------------
  inf(`passages: ${passages.length}`);

  for (let i = 0; i < passages.length; i++) {
    const p = passages[i];
    if (!p.passageId) err(`passage[${i}]: missing passageId`);
    if (!p.gateId && !p.module) warn(`${p.passageId}: missing gateId/module`);
    if (p.validationStatus !== "passed") err(`${p.passageId}: validationStatus is "${p.validationStatus}", expected "passed"`);

    // Every node in gpcInventory must exist in the graph.
    for (const nid of p.gpcInventory || []) {
      if (!nodeIds.has(nid)) err(`${p.passageId}: gpcInventory references non-existent node "${nid}"`);
    }

    // Word count sanity vs target.
    if (p.targetWordCount) {
      const wc = p.wordCount || 0;
      const lo = p.targetWordCount * 0.85;
      const hi = p.targetWordCount * 1.15;
      if (wc < lo || wc > hi) {
        warn(`${p.passageId}: wordCount ${wc} outside 85–115% of target ${p.targetWordCount}`);
      }
    }

    // Anti-three-cueing scan: ≥3 same-template sentences.
    const sentences = (p.paragraphs || []).flatMap((pa) => (pa.sentences || []).map((s) => s.text || ""));
    if (sentences.length >= 3) {
      const tmpl = sentences.map((s) =>
        s.toLowerCase().split(/\s+/).slice(0, 3).join(" "),
      );
      const counts = {};
      for (const t of tmpl) counts[t] = (counts[t] || 0) + 1;
      const overload = Object.entries(counts).find(([_t, c]) => c >= 4);
      if (overload) {
        warn(`${p.passageId}: ${overload[1]} sentences share opener "${overload[0]}…" (predictable-pattern risk)`);
      }
    }
  }

  // Cold-pool sanity: each gate should have at least 3 cold passages.
  const gateBuckets = {};
  for (const p of passages) {
    if (!p.gateId) continue;
    const bucket = gateBuckets[p.gateId] || (gateBuckets[p.gateId] = { cold: 0, practice: 0 });
    p.isCold ? bucket.cold++ : bucket.practice++;
  }
  for (const [gate, b] of Object.entries(gateBuckets)) {
    if (b.cold < 3) warn(`gate ${gate}: only ${b.cold} cold passage(s); minimum 3 for the gate to be re-attemptable without overlap`);
    if (b.practice < 3) warn(`gate ${gate}: only ${b.practice} practice passage(s); minimum 3 for lesson rotation`);
  }

  // ----- 3.5. Student-scoring path (M16-B5) ------------------------------
  //
  // Per the M16-B architecture rule, student-facing nodes must be
  // ASR-scorable. Nodes whose assessment is in the teacher-scored set
  // are excluded from the session planner — but they should be
  // explicitly flagged in the content so authors know the planner
  // skips them. Warn if the flag is missing; warn separately if a
  // node carries the flag but uses a student-scorable assessment
  // (drift the other direction).
  const TEACHER_SCORED = new Set([
    "phoneme_isolate_initial",
    "phoneme_isolate_final",
    "phoneme_isolate_medial",
    "phoneme_segment",
    "phoneme_segment_4_5",
    "letter_sound",
  ]);
  const STUDENT_SCORED = new Set([
    "read_aloud",
    "cold_passage",
    "phoneme_blend",
    "phoneme_delete_initial",
    "phoneme_delete_final",
    "phoneme_substitute",
  ]);
  for (const n of nodes) {
    if (!n.assessment) continue;
    const teacherTyped = TEACHER_SCORED.has(n.assessment);
    const studentTyped = STUDENT_SCORED.has(n.assessment);
    const flagged = n.requires_teacher_scoring === true;
    if (teacherTyped && !flagged) {
      warn(
        `${n.id}: assessment "${n.assessment}" is teacher-scored but ` +
          `the node lacks "requires_teacher_scoring: true". Session planner ` +
          `excludes it from student assignments either way; add the flag for clarity.`,
      );
    }
    if (flagged && studentTyped) {
      warn(
        `${n.id}: requires_teacher_scoring=true but assessment "${n.assessment}" ` +
          `is student-scorable. Drop the flag or change the assessment.`,
      );
    }
    if (!teacherTyped && !studentTyped && n.assessment !== "cold_passage") {
      // An assessment type the matrix doesn't recognise — could be a
      // future type that needs a routing decision.
      warn(
        `${n.id}: assessment "${n.assessment}" not in TEACHER_SCORED or ` +
          `STUDENT_SCORED matrix; classify it before relying on the planner.`,
      );
    }
  }

  // ----- 3.6. Autonomous placement contract (M16-I3 / M16-J1) ----------
  //
  // The autonomous placement (Diagnostic in normal student mode) walks
  // testable nodes in graph order and excludes:
  //   (a) anything with `requires_teacher_scoring: true`
  //   (b) every phoneme_* assessment, because browser TTS can't render
  //       phonemes intelligibly (M16-J1)
  //
  // The first remaining node is what the student literally sees on
  // tap-to-begin. Hard error if no such node exists, or if the chosen
  // first node still belongs to either excluded set (defensive).
  const itemsByNode = items;
  const PHONEME_ASSESSMENTS_VALIDATOR = new Set([
    "phoneme_isolate_initial",
    "phoneme_isolate_final",
    "phoneme_isolate_medial",
    "phoneme_blend",
    "phoneme_segment",
    "phoneme_segment_4_5",
    "phoneme_delete_initial",
    "phoneme_delete_final",
    "phoneme_substitute",
    "letter_sound",
  ]);
  const autonomousFirst = nodes.find(
    (n) =>
      Array.isArray(itemsByNode[n.id]) &&
      itemsByNode[n.id].length > 0 &&
      n.requires_teacher_scoring !== true &&
      !PHONEME_ASSESSMENTS_VALIDATOR.has(n.assessment),
  );
  if (!autonomousFirst) {
    err(
      `autonomous-placement: no auto-scorable testable node exists in the ` +
        `graph. Students cannot complete placement without a teacher.`,
    );
  } else {
    inf(
      `autonomous-placement: first student-mode placement node is ${autonomousFirst.id} (${autonomousFirst.assessment})`,
    );
    if (TEACHER_SCORED.has(autonomousFirst.assessment)) {
      err(
        `autonomous-placement: first node ${autonomousFirst.id} has ` +
          `teacher-scored assessment "${autonomousFirst.assessment}". ` +
          `Either flag it requires_teacher_scoring=true or change the ` +
          `assessment so students can score it themselves.`,
      );
    }
    if (PHONEME_ASSESSMENTS_VALIDATOR.has(autonomousFirst.assessment)) {
      err(
        `autonomous-placement: first node ${autonomousFirst.id} has ` +
          `assessment "${autonomousFirst.assessment}" which depends on ` +
          `phoneme TTS — browser SpeechSynthesis cannot render phonemes ` +
          `intelligibly. Pick a read_aloud node as the entry point.`,
      );
    }
  }

  // ----- 3.7. Autonomous DAG continuation (M16-K5) ----------------------
  //
  // Beyond the entry node, the autonomous student must have a path
  // forward. We walk the prereq graph treating teacher-led prereqs as
  // soft (mirroring cascadeUnlockAutonomous in the runtime) and count
  // how many auto-scorable nodes the student can eventually reach.
  // Hard error if the autonomous reachable set is too small to call a
  // working product.
  function isAutonomousNode(n) {
    return (
      n.requires_teacher_scoring !== true &&
      !PHONEME_ASSESSMENTS_VALIDATOR.has(n.assessment) &&
      n.assessment !== "cold_passage" &&
      Array.isArray(itemsByNode[n.id]) &&
      itemsByNode[n.id].length > 0
    );
  }
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  // Treat teacher-led prereqs as automatically satisfied (soft).
  function softPrereqsSatisfied(def, satisfiedSet) {
    return (def.prereqs || []).every((p) => {
      if (satisfiedSet.has(p)) return true;
      const dp = nodesById.get(p);
      if (dp?.requires_teacher_scoring) return true;
      return false;
    });
  }
  // Iteratively expand the satisfied set: any auto-scorable node whose
  // soft-prereqs are satisfied joins, and unlocks others.
  const reachable = new Set();
  let added = true;
  while (added) {
    added = false;
    for (const n of nodes) {
      if (reachable.has(n.id)) continue;
      if (!isAutonomousNode(n)) continue;
      if (softPrereqsSatisfied(n, reachable)) {
        reachable.add(n.id);
        added = true;
      }
    }
  }
  inf(
    `autonomous-progression: ${reachable.size} auto-scorable node(s) reachable for an autonomous student`,
  );
  if (reachable.size < 5) {
    err(
      `autonomous-progression: only ${reachable.size} auto-scorable node(s) ` +
        `reachable. Autonomous students will dead-end almost immediately. ` +
        `Check requires_teacher_scoring flags and prereq chains.`,
    );
  }
  // Also verify each autonomous node has at least one autonomous
  // continuation (a downstream auto-scorable node that lists it as a
  // prereq, OR no downstream constraint — the student finishing this
  // node and idling is fine if they're at the leaf).
  const autonomousLeaves = [];
  for (const id of reachable) {
    const downstream = nodes.filter(
      (n) =>
        isAutonomousNode(n) &&
        (n.prereqs || []).includes(id) &&
        reachable.has(n.id),
    );
    if (downstream.length === 0) autonomousLeaves.push(id);
  }
  if (autonomousLeaves.length === reachable.size && reachable.size > 0) {
    err(
      `autonomous-progression: every reachable autonomous node is a leaf — ` +
        `there are no autonomous-only continuation chains. Students would ` +
        `finish placement and immediately have nothing further to drill.`,
    );
  }

  // ----- 4. Cross-system ID & reference checks (M3-E) -------------------
  //
  // Catches drift between the skill graph, item banks, passage bank, and
  // the M3 telemetry/student-model code. We do *static* checks only —
  // we don't import the .ts files at validate time.

  // 4a. Duplicate passage IDs across the bank.
  const seenPassageIds = new Set();
  for (const p of passages) {
    if (!p.passageId) continue;
    if (seenPassageIds.has(p.passageId)) {
      err(`duplicate passageId across bank: "${p.passageId}"`);
    } else {
      seenPassageIds.add(p.passageId);
    }
  }

  // 4b. Duplicate item IDs within a node bank, and across the whole
  //     item-bank file (item IDs SHOULD be globally unique).
  const seenItemIds = new Set();
  for (const [nodeKey, bank] of Object.entries(items)) {
    if (!Array.isArray(bank)) continue;
    const localSeen = new Set();
    for (const item of bank) {
      if (!item || typeof item !== "object" || !item.id) continue;
      if (localSeen.has(item.id)) {
        err(`${nodeKey}: duplicate item id within bank "${item.id}"`);
      }
      localSeen.add(item.id);
      if (seenItemIds.has(item.id)) {
        warn(`item id "${item.id}" appears in multiple banks (collision risk for telemetry)`);
      } else {
        seenItemIds.add(item.id);
      }
    }
  }

  // 4c. Each passage's gateId must match a known FL_xx node in the graph.
  for (const p of passages) {
    if (!p.gateId) continue;
    if (!nodeIds.has(p.gateId)) {
      err(`${p.passageId}: gateId "${p.gateId}" not in skill graph`);
    }
  }

  // 4d. Telemetry contract — confirm the events.md doc & lib exist and
  //     reference the same canonical event names.
  try {
    const docPath = join(ROOT, "docs/telemetry/events.md");
    const validatePath = join(ROOT, "src/lib/telemetry/validate.ts");
    const doc = await readFile(docPath, "utf8");
    const validateSrc = await readFile(validatePath, "utf8");

    const docEvents = new Set(
      Array.from(doc.matchAll(/####\s+`([a-z_]+)`/g)).map((m) => m[1]),
    );
    const codeEvents = new Set(
      Array.from(
        validateSrc.matchAll(
          /^\s*(session_started|session_ended|item_started|response_submitted|response_correct|response_incorrect|hint_used|item_completed|mastery_awarded|mastery_revoked|passage_started|passage_completed|fluency_recorded):/gm,
        ),
      ).map((m) => m[1]),
    );

    for (const e of docEvents) {
      if (!codeEvents.has(e)) {
        warn(`telemetry: event "${e}" documented but not in validate.ts`);
      }
    }
    for (const e of codeEvents) {
      if (!docEvents.has(e)) {
        warn(`telemetry: event "${e}" in validate.ts but not documented`);
      }
    }
    inf(`telemetry: ${docEvents.size} doc event(s), ${codeEvents.size} code event(s)`);
  } catch (e) {
    inf(`telemetry: skipping cross-check (${e.message})`);
  }

  // 4e. Student-model schema: ensure FluencyGate union covers every
  //     gate referenced by passages.
  try {
    const modelPath = join(ROOT, "src/lib/mastery/studentModel.ts");
    const modelSrc = await readFile(modelPath, "utf8");
    const gateMatch = modelSrc.match(
      /export type FluencyGate[\s\S]*?;/,
    );
    if (gateMatch) {
      const declaredGates = new Set(
        Array.from(gateMatch[0].matchAll(/"(FL_\d+_[a-z0-9_]+)"/g)).map(
          (m) => m[1],
        ),
      );
      for (const gateId of Object.keys(gateBuckets)) {
        if (!declaredGates.has(gateId)) {
          err(`studentModel: FluencyGate type missing "${gateId}" (passage bank uses it)`);
        }
      }
    }
  } catch (e) {
    inf(`studentModel: skipping check (${e.message})`);
  }

  // ----- 5. Print + exit -------------------------------------------------
  print();

  const failure =
    errors.length > 0 || (STRICT && warnings.length > 0);
  process.exit(failure ? 1 : 0);
}

function print() {
  if (VERBOSE) {
    for (const i of info) console.log(`  info: ${i}`);
  }
  for (const w of warnings) console.warn(`  warn: ${w}`);
  for (const e of errors) console.error(`  error: ${e}`);

  console.log(
    `\n[validate-content] ${errors.length === 0 ? "✓" : "✗"} ` +
    `${errors.length} error(s), ${warnings.length} warning(s), ${info.length} info`,
  );
}

main().catch((e) => {
  console.error("[validate-content] unexpected failure:", e);
  process.exit(1);
});
