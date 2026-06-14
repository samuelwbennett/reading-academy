#!/usr/bin/env node
// build-passages.js
//
// Concatenates docs/passages/bank/<gate>/passages.json files into
// src/data/passages.json so the Vite SPA can statically import them.
//
// Filters out drafts (validationStatus !== "passed") and the
// agent-internal commentary fields. Output schema:
//
//   { version, generatedAt, passages: [ {passageId, gateId, ...} ] }
//
// Run manually:  node scripts/build-passages.js
// CI-friendly:   add as "prebuild" in package.json when desired.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const BANK_DIR = join(ROOT, "docs", "passages", "bank");
const OUT_FILE = join(ROOT, "src", "data", "passages.json");

async function main() {
  let bankNames;
  try {
    bankNames = await readdir(BANK_DIR);
  } catch {
    console.warn(`[build-passages] no bank directory at ${BANK_DIR}; writing empty output`);
    await writeOutput([]);
    return;
  }

  const all = [];
  for (const bank of bankNames) {
    const path = join(BANK_DIR, bank, "passages.json");
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue; // not every directory has a passages.json
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      console.warn(`[build-passages] could not parse ${path}: ${e.message}`);
      continue;
    }
    const passages = (json.passages || []).filter(
      (p) => p.validationStatus === "passed",
    );
    for (const p of passages) {
      // Strip commentary/_authoring_note fields the agent leaves for itself.
      const { _authoring_note, _note, ...clean } = p;
      // Also strip per-sentence _note fields.
      if (Array.isArray(clean.paragraphs)) {
        clean.paragraphs = clean.paragraphs.map((para) => ({
          sentences: (para.sentences || []).map(({ text, wordList }) => ({
            text,
            wordList,
          })),
        }));
      }
      all.push(clean);
    }
    console.log(`[build-passages] ${bank}: ${passages.length} passed passage(s)`);
  }

  await writeOutput(all);
}

async function writeOutput(passages) {
  await mkdir(dirname(OUT_FILE), { recursive: true });
  const out = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    passages,
  };
  await writeFile(OUT_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(`[build-passages] wrote ${passages.length} passage(s) to ${OUT_FILE}`);
}

main().catch((e) => {
  console.error("[build-passages] failed:", e);
  process.exit(1);
});
