// SKU clearance as a Markovian investigation chain (SPEC 4 and 7.1). The vendored
// Markovian orchestrator runs unchanged; our generator (generator.ts) plans each chunk
// with local Nemotron and executes the chosen tools (tools.ts). The run stops when the
// checklist is complete and the deterministic policy has proposed a decision. A chain
// that ends any other way (max chunks, an error, an abort) is decided by the same policy
// with "investigation incomplete", which holds the SKU.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Markovian, type ChunkConfig, type MarkovianRun } from "../../../engines/markovian/reference/src/index.ts";
import { REPO_ROOT_URL } from "../config.ts";
import type { ClearResult } from "../pipeline.ts";
import type { Market } from "../policy/decide.ts";
import { PlannerSession, type LoopEvent, type TimelineEntry } from "./generator.ts";
import type { ChartPoint, ChunkRecord, PlannerCallRecord, TelemetrySummary, ToolCallRecord } from "./telemetry.ts";
import { newSkuContext, proposePolicy, toClearResult, type ToolDeps } from "./tools.ts";

/**
 * SPEC 4 asks for chunkSize 2000 with carryoverTokens 768, but the vendored engine rejects
 * any chunkSize below framing (400) + carryover + output budget (1200) = 2368. chunkSize
 * only feeds the engine's own estimated savings figure, so it is raised to 3000; the
 * carryover budget stays at 768.
 */
export const SKU_CHUNK_CONFIG: ChunkConfig = { chunkSize: 3000, maxChunks: 8, carryoverTokens: 768, overlapTokens: 0 };

export interface InvestigateOptions {
  gtin: string;
  market: Market;
  /** YYYY-MM-DD; recalls reported after it are hidden from the chain (as-of replay). Default today. */
  asOf?: string;
  maxChunks?: number;
  /** H-MEM retrieval context for chunk 0 (rulings, approved invariants, source notes). */
  memoryContext?: string;
  onEvent?: (e: LoopEvent) => void;
  abortSignal?: AbortSignal;
  /** Planner think mode; defaults to the adopted planner setting (CLEARSHELF_THINK=off forces off). */
  think?: boolean;
  /** Where the engine persists its run history (history.json); null keeps it in memory. Default data/markovian. */
  historyDir?: string | null;
  /** Where the loop report is written as <runId>-<gtin>-<market>.loop.json (a sweep shares one run id across SKUs); null skips it. Default data/markovian. */
  telemetryDir?: string | null;
}

export interface LoopReport {
  chain: "sku";
  markovian_run_id: string;
  /** The engine's run status: completed, max-chunks, errored or aborted. */
  status: MarkovianRun["status"];
  error: string | null;
  chunk_config: ChunkConfig;
  chunks: number;
  /** The policy ran because the chain completed its checklist (false: the host decided an incomplete investigation). */
  checklist_complete: boolean;
  checklist: Array<{ id: string; status: string; note: string | null; evidenceIds: string[] }>;
  timeline: TimelineEntry[];
  chunk_telemetry: ChunkRecord[];
  planner_calls: PlannerCallRecord[];
  tool_calls: ToolCallRecord[];
  chart: ChartPoint[];
  summary: TelemetrySummary;
  memory_context_chars: number;
  wall_ms: number;
  report_file: string | null;
  /** The engine's own savings figure: estimated (chars/4), against chunkSize, not our measured telemetry. */
  engine_estimate: { total_tokens_used: number; tokens_saved: number; efficiency_percent: number; label: "estimated" };
}

export type InvestigationResult = ClearResult & { loop: LoopReport };

const DEFAULT_DIR = fileURLToPath(new URL("data/markovian/", REPO_ROOT_URL));

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function skuGoal(gtin: string, market: Market, asOf: string): string {
  return `Clear GTIN ${gtin} for the ${market} market as of ${asOf}: work through the host checklist with the allowed tools, one tool per step, then call policy.propose. The deterministic policy makes the decision; you plan the checks and note contradictions between sources.`;
}

export async function investigateSku(opts: InvestigateOptions, deps: ToolDeps): Promise<InvestigationResult> {
  const t0 = performance.now();
  const asOf = opts.asOf ?? today();
  const ctx = newSkuContext(opts.gtin, opts.market, asOf, deps.evidence);
  const chunkConfig: ChunkConfig = { ...SKU_CHUNK_CONFIG, ...(opts.maxChunks ? { maxChunks: opts.maxChunks } : {}) };
  const goal = skuGoal(opts.gtin, opts.market, asOf);
  const session = new PlannerSession(ctx, deps, {
    goal,
    carryoverTokens: chunkConfig.carryoverTokens,
    onEvent: opts.onEvent,
    abortSignal: opts.abortSignal,
    think: opts.think,
  });

  let memoryContext = opts.memoryContext;
  if (memoryContext === undefined && deps.memory?.context) {
    try {
      memoryContext = await deps.memory.context({ gtin: opts.gtin, market: opts.market });
    } catch (e) {
      ctx.gaps.push(`memory context for chunk 0 failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }

  // The full-history baseline carries the same memory context from its first prompt on.
  if (memoryContext) session.seedBaseline(memoryContext);

  const historyDir = opts.historyDir === undefined ? DEFAULT_DIR : opts.historyDir;
  const markovian = new Markovian({ chunkConfig, generator: session.generator, ...(historyDir ? { historyDir } : {}) });
  const run = await markovian.run({
    goal,
    mode: "RESEARCH",
    memoryContext,
    stopWhen: () => ctx.checklist.complete() && ctx.policy !== null,
    reflect: false,
    abortSignal: opts.abortSignal,
  });

  const checklistComplete = ctx.checklist.complete() && ctx.policy !== null;
  if (!ctx.policy) {
    const open = ctx.checklist.pending().map((i) => i.id);
    proposePolicy(ctx, deps, [
      {
        step: "investigation loop",
        error: `${run.status} after ${run.chunks.length} chunk(s)${run.error ? ` (${run.error.slice(0, 160)})` : ""}; open checklist items: ${open.join(", ") || "none"}`,
        evidenceIds: [],
      },
    ]);
    for (const id of open) if (id !== "policy_proposed") ctx.checklist.set(id, "failed", `not reached before the chain ended (${run.status})`);
    ctx.checklist.set("policy_proposed", "done", "decided by the host after the chain ended", [ctx.policy!.evidenceId]);
  }

  const card = toClearResult(ctx, deps);
  const tel = session.telemetry;
  const report: LoopReport = {
    chain: "sku",
    markovian_run_id: run.id,
    status: run.status,
    error: run.error ?? null,
    chunk_config: run.chunkConfig,
    chunks: run.chunks.length,
    checklist_complete: checklistComplete,
    checklist: ctx.checklist.snapshot(),
    timeline: session.timeline,
    chunk_telemetry: tel.chunks,
    planner_calls: tel.plannerCalls,
    tool_calls: tel.toolCalls,
    chart: tel.chart(),
    summary: tel.summary(),
    memory_context_chars: memoryContext?.length ?? 0,
    wall_ms: Math.round(performance.now() - t0),
    report_file: null,
    engine_estimate: { total_tokens_used: run.totalTokensUsed, tokens_saved: run.totalTokensSaved, efficiency_percent: Number(run.efficiencyPercent.toFixed(1)), label: "estimated" },
  };

  const telemetryDir = opts.telemetryDir === undefined ? DEFAULT_DIR : opts.telemetryDir;
  if (telemetryDir) {
    mkdirSync(telemetryDir, { recursive: true });
    const file = `${telemetryDir.replace(/[\\/]$/u, "")}/${card.run_id}-${card.gtin}-${card.market}.loop.json`;
    report.report_file = file;
    writeFileSync(
      file,
      `${JSON.stringify({ run_id: card.run_id, gtin: card.gtin, market: card.market, as_of: card.as_of, decision: card.decision.status, rules: [...new Set(card.decision.firings.map((f) => f.rule))], evidence_file: card.evidence_file, loop: report }, null, 2)}\n`,
      "utf8",
    );
  }
  return { ...card, loop: report };
}
