// Per-chunk telemetry for the investigation loop (SPEC 4, Markovian). Every number
// carries its label:
//   measured   prompt_eval_count / eval_count / durations as Ollama reports them
//   estimated  ceil(chars/4), the reference engine's estimator, used for the naive
//              full-history baseline and for the carryover size
// The chart data is the "flat tokens per chunk" series: the measured Markovian prompt
// per chunk against the estimated prompt a full-history agent would send at that point.

import { estimateTokens } from "../../../engines/markovian/reference/src/index.ts";
import type { ChatResult } from "../llm/ollama.ts";

export interface PlannerCallRecord {
  chunk: number;
  /** 1 or 2 within the chunk. */
  call: number;
  /** Model replies in this call (2 when the first reply was invalid and a repair was asked). */
  attempts: number;
  valid: boolean;
  /** Valid on the first reply, without a repair round. */
  valid_first_try: boolean;
  /** Errors of the last reply (empty when the call ended valid). */
  errors: string[];
  /** Errors of the first reply, also when the repair round fixed them. */
  first_errors: string[];
  think: boolean;
  /** The model's action as it chose it (null when it chose none). */
  chosen: { tool: string; input: Record<string, unknown> } | null;
  /** The model's checklist echo differed from the host checklist (the host's wins). */
  checklist_echo_altered: boolean;
  thought: string | null;
  /** Summed over the attempts. */
  prompt_tokens: number;
  /** The first attempt only: the context the chain sends into this call. */
  first_attempt_prompt_tokens: number;
  eval_tokens: number;
  wall_ms: number;
  tokens_per_s: number | null;
  /** Characters of the messages actually sent (first attempt). */
  prompt_chars: number;
  label: "measured";
}

export interface ToolCallRecord {
  chunk: number;
  seq: number;
  tool: string;
  input: Record<string, unknown>;
  /** "model": chosen by Nemotron from the dynamic enum; "fallback": the deterministic next step. */
  source: "model" | "fallback";
  fallback_reason: string | null;
  ok: boolean;
  error: string | null;
  latency_ms: number;
  evidence_ids: string[];
  /** Checklist items this call resolved. */
  resolved: string[];
  /** Nemotron calls made inside the tool (extraction), measured. */
  model_tokens: { in: number; out: number; calls: number } | null;
}

export interface ChunkRecord {
  chunk: number;
  started_at: string;
  wall_ms: number;
  /** Carryover state passed into this chunk, estimated chars/4. */
  carryover_in_tokens: number;
  /** State written at the end of the chunk, estimated chars/4. */
  carryover_out_tokens: number;
  /** The next chunk's prompt carried this chunk's state verbatim (the engine's marker level). */
  carryover_accepted: boolean | null;
  planner_calls: number;
  tool_calls: number;
  fallback_steps: number;
  /** Planner prompt tokens summed over the chunk's calls (measured). */
  prompt_tokens: number;
  eval_tokens: number;
  /** The chunk's first planner prompt (measured): the context the chain carries into a chunk. */
  first_prompt_tokens: number;
  /** Same prompt, estimated chars/4, for a like-for-like comparison with the baseline. */
  first_prompt_tokens_estimated: number;
  /** What a full-history agent would send at the same point, estimated chars/4. */
  naive_prompt_tokens_estimated: number;
  /** Nemotron tokens spent inside tools (extraction), measured; identical with or without Markovian. */
  tool_model_tokens_in: number;
  tool_model_tokens_out: number;
  tool_latency_ms: number;
  task_complete: boolean;
}

export interface ChartPoint {
  chunk: number;
  markovian_prompt_tokens_measured: number;
  markovian_prompt_tokens_estimated: number;
  naive_prompt_tokens_estimated: number;
  carryover_tokens_estimated: number;
}

export interface TelemetrySummary {
  chunks: number;
  planner_calls: number;
  planner_valid: number;
  planner_valid_first_try: number;
  planner_repaired: number;
  fallback_steps: number;
  tool_calls: number;
  tool_calls_by_model: number;
  tool_failures: number;
  planner_prompt_tokens: number;
  planner_eval_tokens: number;
  tool_model_tokens_in: number;
  tool_model_tokens_out: number;
  naive_prompt_tokens_estimated: number;
  markovian_prompt_tokens_estimated: number;
  /** 1 - markovian/naive over the first prompts of every chunk, both estimated chars/4. */
  saving_vs_naive_estimated: number | null;
  max_carryover_tokens_estimated: number;
  median_planner_tokens_per_s: number | null;
  labels: { tokens: "measured (Ollama prompt_eval_count/eval_count)"; baseline: "estimated (chars/4)" };
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * The full-history baseline: system prompt, the goal, and every earlier model reply and
 * tool digest re-sent in full, as the reference measured-run script builds it.
 */
export class NaiveHistory {
  private history = "";

  add(text: string): void {
    this.history += `\n${text}`;
  }

  estimate(systemPrompt: string, goal: string, current: string): number {
    return estimateTokens(`${systemPrompt}\n${goal}\n\n[FULL HISTORY]${this.history}\n\n${current}`);
  }

  get chars(): number {
    return this.history.length;
  }
}

export class LoopTelemetry {
  readonly chunks: ChunkRecord[] = [];
  readonly plannerCalls: PlannerCallRecord[] = [];
  readonly toolCalls: ToolCallRecord[] = [];
  private chunkStart = 0;

  startChunk(chunk: number, carryoverIn: string): ChunkRecord {
    this.chunkStart = performance.now();
    const rec: ChunkRecord = {
      chunk,
      started_at: new Date().toISOString(),
      wall_ms: 0,
      carryover_in_tokens: estimateTokens(carryoverIn),
      carryover_out_tokens: 0,
      carryover_accepted: null,
      planner_calls: 0,
      tool_calls: 0,
      fallback_steps: 0,
      prompt_tokens: 0,
      eval_tokens: 0,
      first_prompt_tokens: 0,
      first_prompt_tokens_estimated: 0,
      naive_prompt_tokens_estimated: 0,
      tool_model_tokens_in: 0,
      tool_model_tokens_out: 0,
      tool_latency_ms: 0,
      task_complete: false,
    };
    // The previous chunk's state is accepted when this chunk's prompt carries it verbatim.
    const prev = this.chunks[this.chunks.length - 1];
    if (prev && prev.carryover_accepted === null) prev.carryover_accepted = this.lastStateOut !== null && carryoverIn.trim() === this.lastStateOut.trim();
    this.chunks.push(rec);
    return rec;
  }

  private lastStateOut: string | null = null;

  endChunk(rec: ChunkRecord, stateOut: string, taskComplete: boolean): void {
    rec.wall_ms = Math.round(performance.now() - this.chunkStart);
    rec.carryover_out_tokens = estimateTokens(stateOut);
    rec.task_complete = taskComplete;
    this.lastStateOut = stateOut;
  }

  planner(rec: ChunkRecord, call: Omit<PlannerCallRecord, "label">, firstPromptEstimate: number, naiveEstimate: number): void {
    const full: PlannerCallRecord = { ...call, label: "measured" };
    this.plannerCalls.push(full);
    rec.planner_calls += 1;
    rec.prompt_tokens += call.prompt_tokens;
    rec.eval_tokens += call.eval_tokens;
    if (call.call === 1) {
      rec.first_prompt_tokens = call.first_attempt_prompt_tokens;
      rec.first_prompt_tokens_estimated = firstPromptEstimate;
      rec.naive_prompt_tokens_estimated = naiveEstimate;
    }
  }

  tool(rec: ChunkRecord, call: ToolCallRecord): void {
    this.toolCalls.push(call);
    rec.tool_calls += 1;
    if (call.source === "fallback") rec.fallback_steps += 1;
    rec.tool_latency_ms += call.latency_ms;
    if (call.model_tokens) {
      rec.tool_model_tokens_in += call.model_tokens.in;
      rec.tool_model_tokens_out += call.model_tokens.out;
    }
  }

  chart(): ChartPoint[] {
    return this.chunks
      .filter((c) => c.planner_calls > 0)
      .map((c) => ({
        chunk: c.chunk,
        markovian_prompt_tokens_measured: c.first_prompt_tokens,
        markovian_prompt_tokens_estimated: c.first_prompt_tokens_estimated,
        naive_prompt_tokens_estimated: c.naive_prompt_tokens_estimated,
        carryover_tokens_estimated: c.carryover_in_tokens,
      }));
  }

  summary(): TelemetrySummary {
    const pc = this.plannerCalls;
    const tc = this.toolCalls;
    const chart = this.chart();
    const naive = chart.reduce((s, c) => s + c.naive_prompt_tokens_estimated, 0);
    const mark = chart.reduce((s, c) => s + c.markovian_prompt_tokens_estimated, 0);
    return {
      chunks: this.chunks.length,
      planner_calls: pc.length,
      planner_valid: pc.filter((c) => c.valid).length,
      planner_valid_first_try: pc.filter((c) => c.valid_first_try).length,
      planner_repaired: pc.filter((c) => c.valid && !c.valid_first_try).length,
      fallback_steps: tc.filter((c) => c.source === "fallback").length,
      tool_calls: tc.length,
      tool_calls_by_model: tc.filter((c) => c.source === "model").length,
      tool_failures: tc.filter((c) => !c.ok).length,
      planner_prompt_tokens: pc.reduce((s, c) => s + c.prompt_tokens, 0),
      planner_eval_tokens: pc.reduce((s, c) => s + c.eval_tokens, 0),
      tool_model_tokens_in: tc.reduce((s, c) => s + (c.model_tokens?.in ?? 0), 0),
      tool_model_tokens_out: tc.reduce((s, c) => s + (c.model_tokens?.out ?? 0), 0),
      naive_prompt_tokens_estimated: naive,
      markovian_prompt_tokens_estimated: mark,
      saving_vs_naive_estimated: naive > 0 ? Number((1 - mark / naive).toFixed(3)) : null,
      max_carryover_tokens_estimated: Math.max(0, ...this.chunks.map((c) => c.carryover_out_tokens)),
      median_planner_tokens_per_s: median(pc.map((c) => c.tokens_per_s).filter((x): x is number => x !== null)),
      labels: { tokens: "measured (Ollama prompt_eval_count/eval_count)", baseline: "estimated (chars/4)" },
    };
  }
}

/** Measured numbers summed over the replies of one planner call. */
export function sumMetrics(results: ChatResult[]): { prompt: number; eval: number; wall: number; tps: number | null } {
  const last = results[results.length - 1];
  return {
    prompt: results.reduce((s, r) => s + r.metrics.promptTokens, 0),
    eval: results.reduce((s, r) => s + r.metrics.evalTokens, 0),
    wall: Math.round(results.reduce((s, r) => s + r.metrics.wallMs, 0)),
    tps: last?.metrics.tokensPerSecond ?? null,
  };
}
