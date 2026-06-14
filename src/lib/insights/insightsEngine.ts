// src/lib/insights/insightsEngine.ts
//
// Rule-based intervention insights. Reads the M3 StudentModel + a
// node graph and emits a list of observations a teacher (or the
// orchestration layer) can act on.
//
// Design rules:
//   - Pure. No I/O. Same model + same graph + same `now` = same output.
//   - Explainable. Every insight names its rule + the evidence.
//   - Conservative. Severity tiers ("watch" → "attention" → "urgent")
//     so a fresh signal doesn't trigger an alert until it's stable.
//
// Replaceable in M8 with model-fit recommendations once telemetry
// volumes justify it.

import type { StudentModel, NodeState } from "../mastery/studentModel";
import { calculateForgettingRisk } from "../mastery/masteryEngine";

const DAY_MS = 24 * 60 * 60 * 1000;

export type InsightSeverity = "watch" | "attention" | "urgent";

export interface Insight {
  id: string;
  rule: InsightRule;
  severity: InsightSeverity;
  headline: string;
  detail: string;
  nodeId?: string;
  evidence: Record<string, unknown>;
}

export type InsightRule =
  | "stalled"
  | "latency_drift"
  | "cold_read_regression"
  | "forgetting_cluster"
  | "ready_to_advance"
  | "diagnostic_gap";

export interface InsightConfig {
  /** Days a node can sit in active/practicing before "stalled". */
  stallDays: number;
  /** Latency increase ratio that flags drift (e.g. 1.5 = 50% slower). */
  latencyDriftRatio: number;
  /** Number of recent cold reads to inspect for regression. */
  coldRegressionWindow: number;
  /** Below this fraction of personal best counts as a regression. */
  coldRegressionFloor: number;
  /** N mastered nodes at risk → fire forgetting_cluster. */
  forgettingClusterMin: number;
  /** Risk threshold individual nodes must cross for the cluster. */
  forgettingClusterRisk: number;
  /** Min attempts + accuracy + fluency to flag ready_to_advance. */
  readyMinAttempts: number;
  readyAccuracy: number;
  readyFluency: number;
}

export const DEFAULT_INSIGHT_CONFIG: InsightConfig = {
  stallDays: 7,
  latencyDriftRatio: 1.5,
  coldRegressionWindow: 2,
  coldRegressionFloor: 0.9,
  forgettingClusterMin: 3,
  forgettingClusterRisk: 0.7,
  readyMinAttempts: 8,
  readyAccuracy: 0.95,
  readyFluency: 0.85,
};

interface MinimalNodeDef {
  id: string;
  topic?: string;
  skill?: string;
}

// ---- helpers ----

function days(ms: number): number {
  return ms / DAY_MS;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function nodeLabel(graph: MinimalNodeDef[], nodeId: string): string {
  const def = graph.find((n) => n.id === nodeId);
  return def?.topic ?? def?.skill ?? nodeId;
}

// ---- rules ----

function ruleStalled(
  model: StudentModel,
  graph: MinimalNodeDef[],
  cfg: InsightConfig,
  now: number,
): Insight[] {
  const out: Insight[] = [];
  for (const ns of Object.values(model.nodes)) {
    if (ns.status !== "active" && ns.status !== "practicing") continue;
    if (ns.lastPracticedAt == null) continue;
    if (ns.attempts < 3) continue;
    const idleDays = days(now - ns.lastPracticedAt);
    if (idleDays < cfg.stallDays) continue;
    out.push({
      id: `stalled:${ns.nodeId}`,
      rule: "stalled",
      severity: idleDays >= cfg.stallDays * 2 ? "urgent" : "attention",
      headline: `Stalled at ${nodeLabel(graph, ns.nodeId)}`,
      detail: `${Math.round(idleDays)} days since last practice; status ${ns.status} with ${ns.attempts} attempts logged.`,
      nodeId: ns.nodeId,
      evidence: {
        idleDays: Math.round(idleDays),
        attempts: ns.attempts,
        accuracy: ns.rollingAccuracy,
        status: ns.status,
      },
    });
  }
  return out;
}

function ruleLatencyDrift(
  model: StudentModel,
  graph: MinimalNodeDef[],
  cfg: InsightConfig,
): Insight[] {
  const out: Insight[] = [];
  for (const ns of Object.values(model.nodes)) {
    if (ns.history.length < 6) continue;
    const correct = ns.history.filter((a) => a.correct).map((a) => a.latencyMs);
    if (correct.length < 6) continue;
    const recent = correct.slice(-3);
    const baseline = correct.slice(0, correct.length - 3);
    const recentMed = median(recent);
    const baselineMed = median(baseline);
    if (baselineMed <= 0) continue;
    const ratio = recentMed / baselineMed;
    if (ratio < cfg.latencyDriftRatio) continue;
    out.push({
      id: `latency_drift:${ns.nodeId}`,
      rule: "latency_drift",
      severity: ratio >= cfg.latencyDriftRatio * 1.4 ? "urgent" : "attention",
      headline: `Latency drift on ${nodeLabel(graph, ns.nodeId)}`,
      detail: `Recent median ${Math.round(recentMed)} ms vs baseline ${Math.round(baselineMed)} ms (${Math.round(ratio * 100)}%).`,
      nodeId: ns.nodeId,
      evidence: { recentMed, baselineMed, ratio: +ratio.toFixed(2) },
    });
  }
  return out;
}

function ruleColdReadRegression(
  model: StudentModel,
  cfg: InsightConfig,
): Insight[] {
  const out: Insight[] = [];
  for (const fluency of Object.values(model.fluency)) {
    if (!fluency) continue;
    const cold = fluency.history.filter((h) => h.isCold);
    if (cold.length < cfg.coldRegressionWindow) continue;
    const personalBest = fluency.coldWcpm;
    if (personalBest <= 0) continue;
    const recent = cold.slice(-cfg.coldRegressionWindow);
    const allBelow = recent.every(
      (h) => h.wcpm < personalBest * cfg.coldRegressionFloor,
    );
    if (!allBelow) continue;
    const recentAvg = recent.reduce((a, b) => a + b.wcpm, 0) / recent.length;
    out.push({
      id: `cold_read_regression:${fluency.gateId}`,
      rule: "cold_read_regression",
      severity: "attention",
      headline: `Cold-read regression at ${fluency.gateId}`,
      detail: `Last ${cfg.coldRegressionWindow} cold passages averaged ${Math.round(recentAvg)} WCPM vs personal best ${Math.round(personalBest)}.`,
      nodeId: fluency.gateId,
      evidence: {
        recentAvgWcpm: Math.round(recentAvg),
        personalBest: Math.round(personalBest),
        floor: cfg.coldRegressionFloor,
      },
    });
  }
  return out;
}

function ruleForgettingCluster(
  model: StudentModel,
  cfg: InsightConfig,
  now: number,
): Insight[] {
  const masteredAtRisk: NodeState[] = [];
  for (const ns of Object.values(model.nodes)) {
    if (
      ns.status !== "mastered_for_acquisition" &&
      ns.status !== "in_automaticity_zone" &&
      ns.status !== "automatic"
    ) {
      continue;
    }
    const risk = calculateForgettingRisk(ns, now);
    if (risk >= cfg.forgettingClusterRisk) masteredAtRisk.push(ns);
  }
  if (masteredAtRisk.length < cfg.forgettingClusterMin) return [];
  return [
    {
      id: "forgetting_cluster",
      rule: "forgetting_cluster",
      severity: masteredAtRisk.length >= cfg.forgettingClusterMin * 2
        ? "urgent"
        : "attention",
      headline: `${masteredAtRisk.length} mastered skills at forgetting risk`,
      detail: `Risk floor is ${Math.round(cfg.forgettingClusterRisk * 100)}%. Surface a review session before today's lesson.`,
      evidence: {
        nodeIds: masteredAtRisk.map((n) => n.nodeId),
        floor: cfg.forgettingClusterRisk,
      },
    },
  ];
}

function ruleReadyToAdvance(
  model: StudentModel,
  graph: MinimalNodeDef[],
  cfg: InsightConfig,
): Insight[] {
  const out: Insight[] = [];
  for (const ns of Object.values(model.nodes)) {
    if (ns.status !== "active" && ns.status !== "practicing") continue;
    if (ns.attempts < cfg.readyMinAttempts) continue;
    if (ns.rollingAccuracy < cfg.readyAccuracy) continue;
    if (ns.fluencyConfidence < cfg.readyFluency) continue;
    out.push({
      id: `ready:${ns.nodeId}`,
      rule: "ready_to_advance",
      severity: "watch",
      headline: `Ready to advance from ${nodeLabel(graph, ns.nodeId)}`,
      detail: `Accuracy ${Math.round(ns.rollingAccuracy * 100)}% over ${ns.attempts} attempts; fluency confidence ${Math.round(ns.fluencyConfidence * 100)}%.`,
      nodeId: ns.nodeId,
      evidence: {
        attempts: ns.attempts,
        accuracy: +ns.rollingAccuracy.toFixed(2),
        fluencyConfidence: +ns.fluencyConfidence.toFixed(2),
      },
    });
  }
  return out;
}

function ruleDiagnosticGap(model: StudentModel): Insight[] {
  const populated = Object.keys(model.nodes).length;
  if (populated > 0) return [];
  return [
    {
      id: "diagnostic_gap",
      rule: "diagnostic_gap",
      severity: "watch",
      headline: "No placement data yet",
      detail: "The student hasn't completed the diagnostic. Surface placement before today's lesson.",
      evidence: { populatedNodes: populated },
    },
  ];
}

// ---- public ----

export function generateInsights(
  model: StudentModel,
  graph: MinimalNodeDef[],
  cfgIn: Partial<InsightConfig> = {},
  now: number = Date.now(),
): Insight[] {
  const cfg: InsightConfig = { ...DEFAULT_INSIGHT_CONFIG, ...cfgIn };
  const all: Insight[] = [
    ...ruleDiagnosticGap(model),
    ...ruleStalled(model, graph, cfg, now),
    ...ruleLatencyDrift(model, graph, cfg),
    ...ruleColdReadRegression(model, cfg),
    ...ruleForgettingCluster(model, cfg, now),
    ...ruleReadyToAdvance(model, graph, cfg),
  ];
  const order: InsightSeverity[] = ["urgent", "attention", "watch"];
  return all.sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity),
  );
}
