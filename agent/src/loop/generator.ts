// The Markovian generator for an investigation chain (SPEC 4). The vendored orchestrator
// is used unchanged; this file is the `generator` it calls once per chunk. Each chunk:
//
//   1. Nemotron gets our planner system prompt (the tools allowed at this point: a
//      dynamic enum) and the reference-built prompt (goal + carryover state), and
//      answers with planner JSON constrained by a schema.
//   2. A chosen action is run by the host (tools.ts): the NEEDS_TOOL executor. Its digest
//      (at most 800 tokens) goes to a second planner call in the same chunk.
//   3. At most two tool calls per chunk. An invalid reply gets one repair round; if it is
//      still invalid, or the model picks no action while the checklist is open, the host
//      takes the deterministic next step from the checklist ("fallback step").
//   4. The chunk returns typed marker text: content, one <NEEDS_TOOL .../> per executed
//      call (for the record), [TASK_COMPLETE] once the checklist is complete, and
//      [STATE_CHECKPOINT] with the typed state JSON that becomes the next carryover.
//
// The model never decides: policy.propose runs the deterministic policy, and the host
// owns the checklist (the model's echo of it is ignored and counted).

import type { Generator } from "../../../engines/markovian/reference/src/index.ts";
import { estimateTokens } from "../../../engines/markovian/reference/src/index.ts";
import { parseJsonContent, type ChatMessage, type ChatResult, type OllamaClient } from "../llm/ollama.ts";
import { loadPrompt, render } from "../llm/prompts.ts";
import { plannerSchema, plannerSemanticErrors, validate, type JsonSchema, type PlannerOutput } from "../llm/schemas.ts";
import { jobSettings } from "../llm/settings.ts";
import {
  allowedTools,
  completeInput,
  fallbackStep,
  runTool,
  toolDef,
  type LoopToolDef,
  type SkuContext,
  type ToolDeps,
  type ToolInput,
  type ToolOutcome,
} from "./tools.ts";
import { LoopTelemetry, NaiveHistory, sumMetrics, type ChunkRecord } from "./telemetry.ts";

// ---------- typed markers ----------

/** Untrusted or model text inside chunk output can never form a marker. */
export function neutralize(s: string): string {
  return s
    .replace(/[[\]<>]/gu, (c) => ({ "[": "(", "]": ")", "<": "‹", ">": "›" })[c]!)
    .replace(/@{3,}/gu, "@")
    .replace(/-{3,}/gu, "–");
}

export function needsToolMarker(tool: string, input: Record<string, unknown>): string {
  // Single-quoted input attribute; apostrophes are JSON-escaped so the attribute cannot close early.
  const json = JSON.stringify(input, (_k, v: unknown) => (typeof v === "string" ? neutralize(v) : v)).replace(/'/gu, "\\u0027");
  return `<NEEDS_TOOL tool="${neutralize(tool)}" input='${json}'/>`;
}

export const STATE_MARKER = "[STATE_CHECKPOINT]";
export const COMPLETE_MARKER = "[TASK_COMPLETE]";

/**
 * Chunk text in the marker protocol. [TASK_COMPLETE] precedes the state marker because the
 * engine reads the state as everything after [STATE_CHECKPOINT].
 */
export function chunkText(content: string, calls: { tool: string; input: Record<string, unknown> }[], stateJson: string, complete: boolean): string {
  const parts = [content.trim(), ...calls.map((c) => needsToolMarker(c.tool, c.input))];
  if (complete) parts.push(COMPLETE_MARKER);
  parts.push(`${STATE_MARKER}\n${stateJson}`);
  return parts.join("\n");
}

// ---------- typed carryover state ----------

export interface LoopState {
  v: 1;
  chain: "sku";
  sku: string;
  market: string;
  as_of: string;
  chunk: number;
  checklist: Record<string, string>;
  facts: string[];
  hypotheses: string[];
  open_contradictions: string[];
  evidence_ids: string[];
  next: string;
  tool_calls: number;
  fallback_steps: number;
  decision: string | null;
}

/** Facts carried from chunk to chunk (the most recent ones). */
export const CARRY_FACTS = 4;

/**
 * Serialises the state compactly and trims it until it fits the carryover budget
 * (estimated chars/4), dropping the least useful parts first: older hypotheses, the
 * model's contradictions beyond two, older evidence ids, then the oldest facts.
 */
export function fitState(state: LoopState, budgetTokens: number): string {
  const s: LoopState = JSON.parse(JSON.stringify(state)) as LoopState;
  const clean = (xs: string[]) => xs.map(neutralize);
  // The last few facts only: the checklist carries what is done, so the state stays flat across chunks instead of growing to the budget.
  s.facts = clean(s.facts).slice(-CARRY_FACTS);
  s.hypotheses = clean(s.hypotheses).slice(-3);
  s.open_contradictions = clean(s.open_contradictions).slice(0, 5);
  s.next = neutralize(s.next).slice(0, 200);
  s.checklist = Object.fromEntries(Object.entries(s.checklist).map(([k, v]) => [k, neutralize(v)]));
  s.evidence_ids = s.evidence_ids.slice(-8);
  let json = JSON.stringify(s);
  const fits = () => estimateTokens(json) <= budgetTokens;
  const steps: (() => boolean)[] = [
    () => (s.hypotheses.length > 1 ? (s.hypotheses.shift(), true) : false),
    () => (s.open_contradictions.length > 2 ? (s.open_contradictions.pop(), true) : false),
    () => (s.evidence_ids.length > 3 ? (s.evidence_ids.shift(), true) : false),
    () => (s.facts.length > 2 ? (s.facts.shift(), true) : false),
    () => (s.next.length > 60 ? ((s.next = `${s.next.slice(0, 57)}…`), true) : false),
    () => (s.hypotheses.length > 0 ? (s.hypotheses.shift(), true) : false),
    () => (s.open_contradictions.length > 0 ? (s.open_contradictions.pop(), true) : false),
    () => (s.facts.length > 0 ? (s.facts.shift(), true) : false),
  ];
  for (const step of steps) {
    while (!fits() && step()) json = JSON.stringify(s);
  }
  return json;
}

// ---------- planner prompt and schema ----------

const LOOP_PROTOCOL = `
Loop protocol (ClearShelf host):
- This is one chunk of a bounded chain. The user message holds the goal and, after the first chunk, the CARRYOVER STATE the host wrote at the end of the previous chunk: checklist status, one-line facts with their evidence ids, your earlier hypotheses and next step. Earlier tool results reach you only as those facts.
- You get at most two steps per chunk. After your first step the host runs the tool and appends its result digest.
- The host owns the checklist. Copy the host checklist into state.checklist unchanged.
- policy_proposed is a checklist item too. While it is false the work is not done: when it is the only open item, choose policy.propose.
- Choose action.tool only from the allowed tools above, and fill action.input with the identifiers it needs.
- Reply with one JSON object only. The host writes the chunk markers.`;

export function plannerSystemPrompt(tools: readonly LoopToolDef[]): string {
  const lines = tools
    .map((t) => `- ${t.name}: ${t.description} Input: ${t.input}. Completes: ${t.completes.join(", ") || "nothing (optional, reference only)"}.`)
    .join("\n");
  return `${render(loadPrompt("planner"), { chain_label: "SKU clearance (one product, one market)", tools: lines })}\n${LOOP_PROTOCOL}`;
}

/** The reference prompt without its marker rules: the host writes the markers, the model writes JSON. */
export function stripMarkerRules(referencePrompt: string): string {
  return referencePrompt.replace(/\n*End every non-final chunk with \[STATE_CHECKPOINT\][\s\S]*$/u, "").trimEnd();
}

export function carryoverOf(referencePrompt: string): string {
  const m = /\[CARRYOVER STATE\]\n([\s\S]*?)(?:\n\n|$)/u.exec(referencePrompt);
  return m ? m[1]!.trim() : "";
}

/** The planner schema with this chain's checklist items, the dynamic tool enum and the recorded evidence ids. */
export function loopPlannerSchema(items: readonly string[], tools: readonly string[], evidenceIds: readonly string[]): JsonSchema {
  const schema = plannerSchema("sku", tools, evidenceIds) as { properties: { state: { properties: { checklist: JsonSchema } } } };
  const props: Record<string, JsonSchema> = {};
  for (const i of items) props[i] = { type: "boolean" };
  schema.properties.state.properties.checklist = { type: "object", additionalProperties: false, required: [...items], properties: props };
  return schema as unknown as JsonSchema;
}

export function hostBlock(ctx: SkuContext, inChunk: string[]): string {
  const cl = ctx.checklist;
  const open = cl.pending().map((i) => i.id);
  const notes = cl.notes();
  return [
    `Host checklist (owned by the host): ${JSON.stringify(cl.booleans())}`,
    `Open items in order: ${open.join(", ") || "none"}`,
    notes.length ? `Checklist notes: ${notes.join("; ")}` : null,
    inChunk.length ? `This chunk so far:\n${inChunk.join("\n\n")}` : null,
    "Choose the next step.",
  ]
    .filter((x): x is string => x !== null)
    .join("\n\n");
}

// ---------- the generator ----------

export interface TimelineEntry {
  chunk: number;
  seq: number;
  source: "model" | "fallback";
  tool: string;
  input: Record<string, unknown>;
  thought: string | null;
  fallback_reason: string | null;
  ok: boolean;
  fact: string;
  evidence_ids: string[];
}

export type LoopEvent =
  | { type: "chunk_start"; chunk: number; carryover_tokens: number }
  | { type: "planner"; chunk: number; call: number; valid: boolean; attempts: number; tool: string | null; thought: string | null; prompt_tokens: number; eval_tokens: number }
  | { type: "tool"; chunk: number; seq: number; tool: string; source: "model" | "fallback"; fallback_reason: string | null; ok: boolean; fact: string; evidence_ids: string[]; latency_ms: number }
  | { type: "chunk_end"; chunk: number; state_tokens: number; complete: boolean };

export interface GeneratorOptions {
  goal: string;
  carryoverTokens: number;
  maxToolCallsPerChunk?: number;
  think?: boolean;
  numPredict?: number;
  onEvent?: (e: LoopEvent) => void;
  abortSignal?: AbortSignal;
}

interface PlanResult {
  output: PlannerOutput | null;
  errors: string[];
  /** Errors of the first reply, kept when the repair round succeeds. */
  firstErrors: string[];
  results: ChatResult[];
  promptChars: number;
  validFirstTry: boolean;
  firstPromptTokens: number;
  callError: string | null;
}

export class PlannerSession {
  readonly telemetry = new LoopTelemetry();
  readonly timeline: TimelineEntry[] = [];
  private readonly naive = new NaiveHistory();

  /** Text a full-history agent would also have sent from its first prompt on (chunk 0's memory context). */
  seedBaseline(text: string): void {
    if (text.trim()) this.naive.add(text);
  }
  private chunk = 0;
  private seq = 0;
  private hypotheses: string[] = [];
  private modelContradictions: string[] = [];
  private cited: string[] = [];
  private facts: string[] = [];
  private next = "";
  private readonly think: boolean;
  private readonly numPredict: number;
  private readonly maxCalls: number;
  lastState = "";

  constructor(
    readonly ctx: SkuContext,
    readonly deps: ToolDeps,
    readonly opts: GeneratorOptions,
  ) {
    const s = jobSettings("planner");
    this.think = opts.think ?? s.think;
    this.numPredict = opts.numPredict ?? s.num_predict;
    this.maxCalls = opts.maxToolCallsPerChunk ?? 2;
  }

  get chunks(): number {
    return this.chunk;
  }

  /** The Generator the vendored orchestrator calls once per chunk. */
  readonly generator: Generator = async (prompt, _attachments, _systemPrompt, _onStream, abortSignal) => {
    return { text: await this.runChunk(prompt, abortSignal ?? this.opts.abortSignal) };
  };

  state(): LoopState {
    const ctx = this.ctx;
    const host = ctx.contradictions.map((c) => `${c.kind}: ${c.text}`.slice(0, 140));
    return {
      v: 1,
      chain: "sku",
      sku: ctx.gtin,
      market: ctx.market,
      as_of: ctx.asOf,
      chunk: this.chunk,
      checklist: ctx.checklist.compact(),
      facts: [...this.facts],
      hypotheses: [...this.hypotheses],
      open_contradictions: [...host.slice(0, 3), ...this.modelContradictions.map((c) => `model: ${c}`.slice(0, 140))],
      evidence_ids: [...this.cited],
      next: this.next,
      tool_calls: this.telemetry.toolCalls.length,
      fallback_steps: this.telemetry.toolCalls.filter((t) => t.source === "fallback").length,
      decision: ctx.policy ? ctx.policy.decision.status : null,
    };
  }

  private emit(e: LoopEvent): void {
    try {
      this.opts.onEvent?.(e);
    } catch {
      // an observer never breaks the chain
    }
  }

  /** Resolves items no allowed tool can reach, so the policy can always run (and holds on them). */
  private unstick(): void {
    const cl = this.ctx.checklist;
    if (cl.complete() || allowedTools(this.ctx, this.deps).some((t) => !t.optional)) return;
    for (const item of cl.pending()) {
      if (item.id === "policy_proposed") continue;
      cl.set(item.id, "failed", "no tool could resolve it");
      this.ctx.incomplete.push({ step: item.id, error: "no tool could resolve this checklist item", evidenceIds: [] });
    }
  }

  private async plan(messages: ChatMessage[], tools: LoopToolDef[], abortSignal?: AbortSignal): Promise<PlanResult> {
    const ctx = this.ctx;
    const items = ctx.checklist.all().map((i) => i.id);
    const ids = this.deps.evidence.all().slice(ctx.evStart).map((e) => e.id);
    const schema = loopPlannerSchema(items, tools.map((t) => t.name), ids);
    const results: ChatResult[] = [];
    let msgs = messages;
    let errors: string[] = [];
    let firstErrors: string[] = [];
    let callError: string | null = null;
    const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
    for (let attempt = 1; attempt <= 2; attempt++) {
      let res: ChatResult;
      try {
        res = await this.deps.ollama.chat({ messages: msgs, schema, think: this.think, options: { num_predict: this.numPredict }, signal: abortSignal });
      } catch (e) {
        callError = (e as Error).message.slice(0, 200);
        errors = [`planner call failed: ${callError}`];
        if (abortSignal?.aborted) break;
        continue;
      }
      results.push(res);
      const parsed = parseJsonContent(res.content);
      if (parsed.error !== undefined) {
        errors = [`parse: ${parsed.error}${res.doneReason === "length" ? " (output cut at num_predict)" : ""}`];
      } else {
        errors = validate(schema, parsed.value);
        if (errors.length === 0) {
          const out = parsed.value as PlannerOutput;
          // The host owns completion and ignores `done`, so "done with an action" (the model
          // calling policy.propose as the last step) is not an error here.
          errors = plannerSemanticErrors(out).filter((e) => !e.startsWith("done is true but an action is set"));
          if (out.action) {
            const input = out.action.input ?? {};
            const def = tools.find((t) => t.name === out.action!.tool);
            if (!def) errors.push(`action.tool ${out.action.tool} is not allowed at this step`);
            else errors.push(...def.checkInput(input, ctx));
            // Whatever the tool, a GTIN or market in the input must be the subject's.
            if (input.gtin !== undefined && input.gtin !== ctx.gtin && !errors.some((x) => x.includes("GTIN under investigation"))) {
              errors.push(`action.input.gtin ${input.gtin} is not the GTIN under investigation (${ctx.gtin})`);
            }
            if (input.market !== undefined && input.market !== ctx.market && !errors.some((x) => x.includes("market under investigation"))) {
              errors.push(`action.input.market ${input.market} is not the market under investigation (${ctx.market})`);
            }
          }
          if (errors.length === 0) {
            return { output: out, errors: [], firstErrors, results, promptChars, validFirstTry: attempt === 1, firstPromptTokens: results[0]!.metrics.promptTokens, callError };
          }
        }
      }
      if (attempt === 1) firstErrors = errors;
      // One repair round: show the model its reply and the errors.
      msgs = [
        ...messages,
        { role: "assistant", content: res.content.slice(0, 4000) },
        { role: "user", content: `That reply is not valid: ${errors.slice(0, 4).join("; ")}. Reply again with one JSON object that follows the schema and uses only the allowed tools and inputs.` },
      ];
    }
    return { output: null, errors, firstErrors, results, promptChars, validFirstTry: false, firstPromptTokens: results[0]?.metrics.promptTokens ?? 0, callError };
  }

  private async runChunk(referencePrompt: string, abortSignal?: AbortSignal): Promise<string> {
    const ctx = this.ctx;
    this.chunk += 1;
    const carryIn = carryoverOf(referencePrompt);
    const rec: ChunkRecord = this.telemetry.startChunk(this.chunk, carryIn);
    this.emit({ type: "chunk_start", chunk: this.chunk, carryover_tokens: rec.carryover_in_tokens });
    const base = stripMarkerRules(referencePrompt);
    const contentLines: string[] = [`Chunk ${this.chunk}`];
    const executed: { tool: string; input: Record<string, unknown> }[] = [];
    const inChunk: string[] = [];

    for (let call = 1; call <= this.maxCalls; call++) {
      this.unstick();
      if (ctx.checklist.complete() || abortSignal?.aborted) break;
      const tools = allowedTools(ctx, this.deps);
      if (tools.length === 0) break;
      const system = plannerSystemPrompt(tools);
      const host = hostBlock(ctx, inChunk);
      const user = `${base}\n\n${host}`;
      const messages: ChatMessage[] = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
      const naiveEstimate = call === 1 ? this.naive.estimate(system, this.opts.goal, host) : 0;
      const plan = await this.plan(messages, tools, abortSignal);
      const m = sumMetrics(plan.results);
      const out = plan.output;
      const echo = out ? JSON.stringify(out.state.checklist) !== JSON.stringify(ctx.checklist.booleans()) : false;
      this.telemetry.planner(
        rec,
        {
          chunk: this.chunk,
          call,
          attempts: plan.results.length,
          valid: out !== null,
          valid_first_try: plan.validFirstTry,
          errors: plan.errors,
          first_errors: plan.firstErrors,
          think: this.think,
          chosen: out?.action ? { tool: out.action.tool, input: { ...out.action.input } } : null,
          checklist_echo_altered: echo,
          thought: out?.thought ?? null,
          prompt_tokens: m.prompt,
          first_attempt_prompt_tokens: plan.firstPromptTokens,
          eval_tokens: m.eval,
          wall_ms: m.wall,
          tokens_per_s: m.tps,
          prompt_chars: plan.promptChars,
        },
        estimateTokens(`${system}\n${user}`),
        naiveEstimate,
      );
      this.emit({ type: "planner", chunk: this.chunk, call, valid: out !== null, attempts: plan.results.length, tool: out?.action?.tool ?? null, thought: out?.thought ?? null, prompt_tokens: m.prompt, eval_tokens: m.eval });
      for (const r of plan.results) this.naive.add(r.content);

      if (out) {
        this.hypotheses = [...this.hypotheses, ...out.state.hypotheses].slice(-3);
        this.modelContradictions = out.state.open_contradictions.slice(0, 2);
        this.cited = [...new Set([...this.cited, ...out.state.evidence_ids])].slice(-8);
        if (out.state.next) this.next = out.state.next;
      }

      let def: LoopToolDef | undefined;
      let input: ToolInput = {};
      let source: "model" | "fallback" = "model";
      let reason: string | null = null;
      if (out?.action) {
        def = toolDef(out.action.tool);
        input = def ? completeInput(def, out.action.input ?? {}, ctx) : {};
      } else {
        const fb = fallbackStep(ctx, this.deps);
        if (!fb) break;
        def = fb.tool;
        input = fb.input;
        source = "fallback";
        reason = out
          ? `the model chose no action while ${ctx.checklist.pending().length} checklist item(s) are open`
          : `planner reply invalid after a repair round (${plan.errors.slice(0, 2).join("; ")})`;
      }
      if (!def) break;

      const before = new Set(ctx.checklist.all().filter((i) => i.status !== "pending").map((i) => i.id));
      const t0 = performance.now();
      const res: ToolOutcome = await runTool(def, input, ctx, this.deps);
      const latency = Math.round(performance.now() - t0);
      const resolved = ctx.checklist.all().filter((i) => i.status !== "pending" && !before.has(i.id)).map((i) => i.id);
      this.seq += 1;
      this.telemetry.tool(rec, {
        chunk: this.chunk,
        seq: this.seq,
        tool: def.name,
        input: { ...input },
        source,
        fallback_reason: reason,
        ok: res.ok,
        error: res.error ?? null,
        latency_ms: latency,
        evidence_ids: res.evidenceIds,
        resolved,
        model_tokens: res.modelTokens ?? null,
      });
      this.timeline.push({ chunk: this.chunk, seq: this.seq, source, tool: def.name, input: { ...input }, thought: out?.thought ?? null, fallback_reason: reason, ok: res.ok, fact: res.fact, evidence_ids: res.evidenceIds });
      this.emit({ type: "tool", chunk: this.chunk, seq: this.seq, tool: def.name, source, fallback_reason: reason, ok: res.ok, fact: res.fact, evidence_ids: res.evidenceIds, latency_ms: latency });
      this.facts.push(res.fact);
      this.naive.add(res.digest);
      executed.push({ tool: def.name, input: { ...input } });
      inChunk.push(res.digest);
      contentLines.push(
        `${call}. ${source === "model" ? `planner: ${neutralize(out?.thought ?? "")}` : `fallback step (${neutralize(reason ?? "")})`}`,
        `   ${def.name} ${neutralize(JSON.stringify(input))} -> ${neutralize(res.fact)}`,
      );
    }

    const complete = ctx.checklist.complete() && ctx.policy !== null;
    const stateJson = fitState(this.state(), this.opts.carryoverTokens);
    this.lastState = stateJson;
    this.telemetry.endChunk(rec, stateJson, complete);
    this.emit({ type: "chunk_end", chunk: this.chunk, state_tokens: estimateTokens(stateJson), complete });
    return chunkText(contentLines.join("\n"), executed, stateJson, complete);
  }
}

export function createPlannerSession(ctx: SkuContext, deps: ToolDeps, opts: GeneratorOptions): PlannerSession {
  return new PlannerSession(ctx, deps, opts);
}

export type { OllamaClient };
