// Local Ollama client for Nemotron. No cloud model calls: every request URL must be a
// loopback host, any other host is refused and counted, and every response's token
// counts and durations are reported as measured by Ollama. A host-RAM guard unloads
// the model before a call when available RAM is low (see docs/nemotron-bench.md).

import { createHash } from "node:crypto";
import os from "node:os";
import { validate, type JsonSchema } from "./schemas.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelOptions {
  temperature: number;
  seed: number;
  num_ctx: number;
  num_predict?: number;
}

export const DEFAULT_OPTIONS: ModelOptions = { temperature: 0, seed: 7, num_ctx: 8192 };
export const DEFAULT_KEEP_ALIVE = "30m";
export const DEFAULT_MODEL = "nemotron-3-nano:4b";

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  /** JSON schema passed as Ollama `format`; omit for free text. */
  schema?: JsonSchema;
  think?: boolean;
  options?: Partial<ModelOptions>;
  keepAlive?: string | number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatMetrics {
  label: "measured";
  promptTokens: number;
  evalTokens: number;
  promptEvalMs: number;
  evalMs: number;
  loadMs: number;
  totalMs: number;
  wallMs: number;
  /** eval_count / eval_duration, as Ollama reports them. */
  tokensPerSecond: number | null;
}

export interface ChatResult {
  model: string;
  think: boolean;
  content: string;
  thinking: string | null;
  doneReason: string | null;
  promptSha256: string;
  metrics: ChatMetrics;
}

export interface JsonAttempt {
  result: ChatResult;
  parseError: string | null;
  schemaErrors: string[];
}

export type JsonOutcome<T> =
  | { ok: true; value: T; attempts: JsonAttempt[] }
  | { ok: false; errors: string[]; attempts: JsonAttempt[] };

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

let refusedHostAttempts = 0;

/** Attempts to reach a non-loopback model host since the process started (the "0 cloud model calls" counter). */
export function refusedModelHostAttempts(): number {
  return refusedHostAttempts;
}

/** Test helper. */
export function resetRefusedModelHostAttempts(): void {
  refusedHostAttempts = 0;
}

export function assertLoopbackUrl(url: string): URL {
  const u = new URL(url);
  if (!LOOPBACK_HOSTS.has(u.hostname)) {
    refusedHostAttempts++;
    throw new OllamaError(`refusing non-local model host ${u.hostname}; Nemotron must run in local Ollama`);
  }
  return u;
}

export interface RamGuardOptions {
  /** Unload the model before a call when available host RAM is below this many MiB. */
  minAvailableMiB: number;
  /** At most one guard unload per this many ms, so RAM pressure from other processes does not reload the model on every call. */
  cooldownMs?: number;
  /** Available host RAM in MiB; defaults to the OS figure. Injected in tests. */
  availableMiB?: () => number;
}

export interface RamGuardEvent {
  at: string;
  model: string;
  minAvailableMiB: number;
  availableBeforeMiB: number;
  availableAfterMiB: number;
}

export const DEFAULT_MIN_AVAILABLE_RAM_MIB = 2048;

function ramGuardFromEnv(): RamGuardOptions {
  const v = Number(process.env.CLEARSHELF_MIN_AVAILABLE_RAM_MIB);
  return { minAvailableMiB: Number.isFinite(v) && v > 0 ? v : DEFAULT_MIN_AVAILABLE_RAM_MIB };
}

const osAvailableMiB = (): number => os.freemem() / 1048576;

const NS_PER_MS = 1_000_000;

function nsToMs(ns: unknown): number {
  return typeof ns === "number" ? ns / NS_PER_MS : 0;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Accepts bare JSON and, defensively, a single fenced block. */
export function parseJsonContent(content: string): { value?: unknown; error?: string } {
  let text = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(text);
  if (fenced) text = fenced[1];
  if (text === "") return { error: "empty content" };
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export interface OllamaClientOptions {
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
  /** Host-RAM guard; on by default (CLEARSHELF_MIN_AVAILABLE_RAM_MIB, else 2048 MiB). `false` turns it off. */
  ramGuard?: RamGuardOptions | false;
}

export class OllamaClient {
  readonly baseUrl: string;
  readonly model: string;
  /** Every unload the RAM guard made, in order. */
  readonly ramGuardEvents: RamGuardEvent[] = [];
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly ramGuard: Required<RamGuardOptions> | null;
  private lastGuardUnloadAt = Number.NEGATIVE_INFINITY;

  constructor(opts: OllamaClientOptions = {}) {
    const base = opts.baseUrl ?? process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
    this.baseUrl = assertLoopbackUrl(base).origin;
    this.model = opts.model ?? process.env.CLEARSHELF_MODEL ?? DEFAULT_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 300_000;
    const guard = opts.ramGuard === undefined ? ramGuardFromEnv() : opts.ramGuard;
    this.ramGuard = guard
      ? { minAvailableMiB: guard.minAvailableMiB, cooldownMs: guard.cooldownMs ?? 60_000, availableMiB: guard.availableMiB ?? osAvailableMiB }
      : null;
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const url = assertLoopbackUrl(`${this.baseUrl}${path}`);
    const res = await this.fetchImpl(url.href, init);
    const text = await res.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new OllamaError(`Ollama ${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status);
    }
    if (!res.ok || typeof data.error === "string") {
      throw new OllamaError(`Ollama ${path} failed (HTTP ${res.status}): ${String(data.error ?? text.slice(0, 200))}`, res.status);
    }
    return data;
  }

  private post(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  }

  /**
   * Host-RAM guard, run before every call. When available RAM is under the threshold
   * and the model is loaded, it unloads the model (the runner process exits and its
   * memory returns to the OS); the call that follows loads it again. A cooldown stops
   * low RAM caused by other processes from forcing a reload on every call.
   */
  async guardRam(model: string = this.model): Promise<RamGuardEvent | null> {
    const g = this.ramGuard;
    if (!g) return null;
    const before = g.availableMiB();
    if (before >= g.minAvailableMiB) return null;
    const now = Date.now();
    if (now - this.lastGuardUnloadAt < g.cooldownMs) return null;
    if (!(await this.loaded()).some((m) => m.name === model)) return null;
    this.lastGuardUnloadAt = now;
    await this.unload(model);
    for (let i = 0; i < 20 && (await this.loaded()).some((m) => m.name === model); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const event: RamGuardEvent = {
      at: new Date().toISOString(),
      model,
      minAvailableMiB: g.minAvailableMiB,
      availableBeforeMiB: Math.round(before),
      availableAfterMiB: Math.round(g.availableMiB()),
    };
    this.ramGuardEvents.push(event);
    return event;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const model = req.model ?? this.model;
    const think = req.think ?? false;
    await this.guardRam(model);
    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      stream: false,
      think,
      keep_alive: req.keepAlive ?? DEFAULT_KEEP_ALIVE,
      options: { ...DEFAULT_OPTIONS, ...req.options },
    };
    if (req.schema) body.format = req.schema;

    const started = performance.now();
    const data = await this.post("/api/chat", body, req.timeoutMs ?? this.defaultTimeoutMs, req.signal);
    const wallMs = performance.now() - started;

    const message = (data.message ?? {}) as { content?: string; thinking?: string };
    const evalTokens = typeof data.eval_count === "number" ? data.eval_count : 0;
    const evalMs = nsToMs(data.eval_duration);
    return {
      model,
      think,
      content: message.content ?? "",
      thinking: message.thinking ?? null,
      doneReason: typeof data.done_reason === "string" ? data.done_reason : null,
      promptSha256: sha256(JSON.stringify(req.messages)),
      metrics: {
        label: "measured",
        promptTokens: typeof data.prompt_eval_count === "number" ? data.prompt_eval_count : 0,
        evalTokens,
        promptEvalMs: nsToMs(data.prompt_eval_duration),
        evalMs,
        loadMs: nsToMs(data.load_duration),
        totalMs: nsToMs(data.total_duration),
        wallMs,
        tokensPerSecond: evalMs > 0 ? evalTokens / (evalMs / 1000) : null,
      },
    };
  }

  /**
   * Structured call: the schema goes to Ollama as `format` and the reply is parsed
   * and validated here. An invalid reply is retried (once by default) with the same
   * request; the caller takes its deterministic fallback when `ok` is false.
   */
  async chatJson<T>(
    req: ChatRequest & { schema: JsonSchema; semanticCheck?: (value: T) => string[] },
    maxAttempts = 2,
  ): Promise<JsonOutcome<T>> {
    const attempts: JsonAttempt[] = [];
    let lastErrors: string[] = [];
    for (let i = 0; i < maxAttempts; i++) {
      const result = await this.chat(req);
      const parsed = parseJsonContent(result.content);
      if (parsed.error !== undefined) {
        const reason = result.doneReason === "length" ? `${parsed.error} (output cut at num_predict)` : parsed.error;
        attempts.push({ result, parseError: reason, schemaErrors: [] });
        lastErrors = [`parse: ${reason}`];
        continue;
      }
      const schemaErrors = validate(req.schema, parsed.value);
      if (schemaErrors.length === 0 && req.semanticCheck) schemaErrors.push(...req.semanticCheck(parsed.value as T));
      attempts.push({ result, parseError: null, schemaErrors });
      if (schemaErrors.length === 0) return { ok: true, value: parsed.value as T, attempts };
      lastErrors = schemaErrors;
    }
    return { ok: false, errors: lastErrors, attempts };
  }

  /** Unloads a model from memory (keep_alive 0). */
  async unload(model: string = this.model): Promise<void> {
    await this.post("/api/generate", { model, keep_alive: 0 }, 60_000);
  }

  /** Models currently loaded, with their VRAM share as Ollama reports it. */
  async loaded(): Promise<Array<{ name: string; size: number; size_vram: number; context_length?: number }>> {
    const data = (await this.request("/api/ps", { signal: AbortSignal.timeout(10_000) })) as {
      models?: Array<{ name: string; size: number; size_vram: number; context_length?: number }>;
    };
    return data.models ?? [];
  }
}
