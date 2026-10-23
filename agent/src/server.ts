// ClearShelf agent server: the HTTP API for the officer UI, server-sent events on
// /api/events, and the static UI files (ui/), on 127.0.0.1 only (UI_PORT, default 8790).
//
// Safety:
// - HOLD and BLOCK are applied automatically (low-risk contract the agent issues).
// - CLEAR, CLEAR_WITH_STATEMENT and RELEASE run only through POST /api/execute with an
//   officer-signed contract (POST /api/approvals/sign issues it for the local demo identity
//   "officer"; a real deployment needs SSO). Without a valid contract the reply is 403, the
//   refusal is logged in data/contracts/verifier-agent-ops.jsonl and nothing is written.
// - Requests must name this server as Host (DNS rebinding) and, for writes, come with a
//   JSON body and no foreign Origin (cross-site requests).
// - Model work (clearances and sweeps) runs one job at a time.
//
//   npx tsx src/server.ts            (npm run dev)

import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, REPO_ROOT_URL } from "./config.ts";
import { OFFICER } from "./contract/scout.ts";
import { EvidenceStore, type EvidenceRecord } from "./evidence/store.ts";
import { refusedModelHostAttempts, type OllamaClient } from "./llm/ollama.ts";
import { AGENT_ACTOR, applyAutomatic, executeDecision, overDecision, signApproval, supersedeBy } from "./ops/actions.ts";
import type { ApprovalQueue } from "./ops/queue.ts";
import { RunStore } from "./ops/runStore.ts";
import { ContractRefused, decisionContractParams, OpsError, type OpsStore } from "./ops/store.ts";
import { clearSku, type ClearResult, type PipelineDeps } from "./pipeline.ts";
import type { Decision, Market } from "./policy/decide.ts";
import { AsOfGateway, replayBanner, ReplayEvidenceStore } from "./watch/asOf.ts";
import type { Catalogue, RecallWatch } from "./watch/recallWatch.ts";
import { DqGate, GatewayError, rowsAsObjects, validateParam, writebackDq, type GatewayClient, type WritebackDqResult } from "./zetaris/client.ts";
import { normalise } from "./verify/gtin.ts";
import { keywordBaseline, lexiconScan } from "./verify/lexicon.ts";
import { agentWatch, clearWithAgent, openRuntime, recordExecuted, whyTrace, type ExecutedContext, type Runtime } from "./runtime.ts";
import type { DecisionRow } from "./ops/store.ts";

// ---------- events ----------

export interface BusEvent {
  id: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export class EventBus {
  private seq = 0;
  private readonly ring: BusEvent[] = [];
  private readonly clients = new Set<ServerResponse>();

  constructor(private readonly keep = 500) {}

  publish(type: string, data: Record<string, unknown>): BusEvent {
    const e: BusEvent = { id: ++this.seq, type, at: new Date().toISOString(), data };
    this.ring.push(e);
    if (this.ring.length > this.keep) this.ring.splice(0, this.ring.length - this.keep);
    for (const c of this.clients) EventBus.write(c, e);
    return e;
  }

  recent(after = 0): BusEvent[] {
    return this.ring.filter((e) => e.id > after);
  }

  private static write(res: ServerResponse, e: BusEvent): void {
    res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e.data, at: e.at })}\n\n`);
  }

  attach(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 3000\n\n");
    // Only a reconnect (Last-Event-ID) or an explicit ?since gets the missed events; a new
    // connection starts with what happens from now on.
    const since = req.headers["last-event-id"] ?? new URL(req.url ?? "/", "http://x").searchParams.get("since");
    if (since !== undefined && since !== null && since !== "") {
      const last = Number(since);
      for (const e of this.recent(Number.isFinite(last) ? last : 0)) EventBus.write(res, e);
    }
    this.clients.add(res);
    const beat = setInterval(() => res.write(`: keep-alive ${Date.now()}\n\n`), 15_000);
    req.on("close", () => {
      clearInterval(beat);
      this.clients.delete(res);
    });
  }

  get listeners(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}

// ---------- serial jobs ----------

export interface Job {
  id: string;
  kind: string;
  state: "queued" | "running" | "done" | "failed";
  input: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

export class JobQueue {
  private seq = 0;
  readonly jobs = new Map<string, Job>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly bus: EventBus) {}

  submit(kind: string, input: Record<string, unknown>, run: (job: Job) => Promise<Record<string, unknown>>): Job {
    const job: Job = { id: `j${Date.now().toString(36)}${(++this.seq).toString(36)}`, kind, state: "queued", input, created_at: new Date().toISOString(), started_at: null, finished_at: null, result: null, error: null };
    this.jobs.set(job.id, job);
    this.bus.publish("job.queued", { job_id: job.id, kind, input });
    const go = async () => {
      job.state = "running";
      job.started_at = new Date().toISOString();
      this.bus.publish("job.started", { job_id: job.id, kind });
      try {
        job.result = await run(job);
        job.state = "done";
        this.bus.publish("job.done", { job_id: job.id, kind, result: job.result });
      } catch (e) {
        job.state = "failed";
        job.error = (e as Error).message.slice(0, 500);
        this.bus.publish("job.failed", { job_id: job.id, kind, error: job.error });
      } finally {
        job.finished_at = new Date().toISOString();
      }
    };
    this.tail = this.tail.then(go, go);
    return job;
  }

  get pending(): number {
    return [...this.jobs.values()].filter((j) => j.state === "queued" || j.state === "running").length;
  }

  idle(): Promise<unknown> {
    return this.tail;
  }
}

// ---------- server ----------

export interface ServerDeps {
  gateway: GatewayClient;
  ollama: OllamaClient;
  ops: OpsStore;
  queue: ApprovalQueue;
  watch: RecallWatch;
  catalogue: Catalogue;
  bus?: EventBus;
  /** ui/ directory to serve; null serves no files. */
  uiDir?: string | null;
  /** data/runs/ for clearance results; null keeps them in memory. */
  runsDir?: string | null;
  /** The run store to save clearances in (default one on runsDir); main() shares it with the recall watch. */
  runStore?: RunStore;
  /** data/evidence/ for evidence files; null keeps evidence in memory. */
  evidenceDir?: string | null;
  /** data/watch/sweeps/ to read sweep records from. */
  sweepDir?: string | null;
  /** data/markovian/ loop reports for /api/loops and the telemetry footer; null serves none. */
  loopDir?: string | null;
  /** data/eval/ results (VRAM, cold vs warm) for the telemetry footer; null serves none. */
  evalDir?: string | null;
  /** docs/eval-report.md for the /eval page; null serves none. */
  evalReport?: string | null;
  clear?: typeof clearSku;
  /**
   * The wired runtime (runtime.ts): clearances run as Markovian investigations with H-MEM and
   * the World Model, executed decisions are recorded in both, officer reasons are mined into
   * H-MEM, and the memory and World Model endpoints are served. Without it the server runs the
   * straight pipeline (tests).
   */
  runtime?: Runtime;
  /** Officer reasons (approve, edit, reject, confirm): the memory lane mines these into H-MEM. */
  onOfficerReason?: (r: { kind: string; gtin: string | null; market: string | null; reason: string; contract_id?: string; decision_id?: string }) => void;
  log?: (line: string) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "error",
  ) {
    super(message);
  }
}

const MAX_BODY = 256 * 1024;
const RUN_ID = /^[rw]\d{8}T\d{6}[0-9a-f]{4}$/u;
const EV_ID = /^ev-[rw]\d{8}T\d{6}[0-9a-f]{4}-\d{2,4}$/u;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const ct = String(req.headers["content-type"] ?? "");
  if (!ct.toLowerCase().startsWith("application/json")) throw new HttpError(415, "send a JSON body (content-type: application/json)", "content_type");
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new HttpError(413, "body too large", "too_large");
    chunks.push(c as Buffer);
  }
  if (!n) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body is not a JSON object", "bad_json");
  }
}

function s(v: unknown, name: string, required = true): string {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${name} is required`, "missing_field");
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `${name} must be a string`, "bad_field");
  return v;
}

function gtinOf(v: unknown): string {
  const g = s(v, "gtin");
  try {
    return validateParam("gtin", g);
  } catch (e) {
    throw new HttpError(400, (e as Error).message, "bad_gtin");
  }
}

/**
 * A barcode typed at intake as the GTIN-13 the catalogue and Zetaris use: UPC-A (12 digits)
 * and EAN-8 are zero-padded, a GTIN-14 with indicator 0 drops it. `input` is what was typed
 * when it differs.
 */
function intakeGtinOf(v: unknown): { gtin: string; input: string | null } {
  const raw = s(v, "gtin").trim();
  if (/^(?:\d{8}|\d{12}|\d{14})$/u.test(raw)) {
    const n = normalise(raw);
    if (!n.ok) {
      throw new HttpError(400, n.reason === "gtin14_case_level" ? `${raw} is a case code (GTIN-14 indicator 1 to 9), not a product` : `GTIN check digit fails: ${raw}`, "bad_gtin");
    }
    return { gtin: gtinOf(n.gtin13), input: raw };
  }
  return { gtin: gtinOf(raw), input: null };
}

/** A write-back DQ result for the API: the rule, its invalid decision ids, and the SQL as the citation. */
function dqOut(d: WritebackDqResult, rowInvalid?: boolean) {
  return {
    rule: d.rule,
    invalid: d.invalid.length,
    invalid_decisions: d.invalid.map((x) => String(x.decision_id ?? "")).slice(0, 50),
    ...(rowInvalid === undefined ? {} : { row_invalid: rowInvalid }),
    sql: d.result?.sql ?? null,
    sql_sha256: d.result?.sql_sha256 ?? null,
    executed_at: d.result?.executed_at ?? null,
    elapsed_ms: d.result?.elapsed_ms ?? null,
    error: d.error,
  };
}

function marketOf(v: unknown): Market {
  const m = s(v, "market").toUpperCase();
  if (m !== "UK" && m !== "US") throw new HttpError(400, "market must be UK or US", "bad_market");
  return m;
}

function dateOf(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const d = s(v, name);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(d)) throw new HttpError(400, `${name} must be YYYY-MM-DD`, "bad_date");
  return d;
}

export interface ClearShelfServer {
  server: http.Server;
  bus: EventBus;
  jobs: JobQueue;
  runs: Map<string, ClearResult>;
  runStore: RunStore;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  /** Queues a poll of the live recall watch (the CLEARSHELF_WATCH_EVERY_MIN timer); null when the watch is not live, or is already polling. */
  schedulePoll(): Job | null;
}

export function createServer(deps: ServerDeps): ClearShelfServer {
  const bus = deps.bus ?? new EventBus();
  const jobs = new JobQueue(bus);
  const log = deps.log ?? (() => {});
  const clear = deps.clear ?? clearSku;
  const runStore = deps.runStore ?? new RunStore(deps.runsDir === undefined ? fileURLToPath(new URL("data/runs/", REPO_ROOT_URL)) : deps.runsDir);
  const evidenceDir = deps.evidenceDir === undefined ? fileURLToPath(new URL("data/evidence/", REPO_ROOT_URL)) : deps.evidenceDir;
  const sweepDir = deps.sweepDir === undefined ? fileURLToPath(new URL("data/watch/sweeps/", REPO_ROOT_URL)) : deps.sweepDir;
  const uiDir = deps.uiDir === undefined ? fileURLToPath(new URL("ui/", REPO_ROOT_URL)) : deps.uiDir;
  const loopDir = deps.loopDir === undefined ? fileURLToPath(new URL("data/markovian/", REPO_ROOT_URL)) : deps.loopDir;
  const evalDir = deps.evalDir === undefined ? fileURLToPath(new URL("data/eval/", REPO_ROOT_URL)) : deps.evalDir;
  const evalReport = deps.evalReport === undefined ? fileURLToPath(new URL("docs/eval-report.md", REPO_ROOT_URL)) : deps.evalReport;
  const rt = deps.runtime ?? null;
  const officerReason = (r: Parameters<NonNullable<ServerDeps["onOfficerReason"]>>[0]) => {
    bus.publish("officer.reason", r);
    deps.onOfficerReason?.(r);
    if (rt) {
      // Mining the reason is a model call: it runs in the serial job queue.
      const action = ({ approve: "approve", release: "release", reject: "reject", manual: "hold", confirm_name_match: "hold", dismiss_name_match: "reject" } as const)[r.kind as "approve"] ?? "edit";
      jobs.submit("memory.officer_reason", { kind: r.kind, gtin: r.gtin, market: r.market }, async () => {
        const mems = await rt.hmem.officerAction({ action, reason: r.reason, gtin: r.gtin, market: r.market as Market, decisionId: r.decision_id ?? null, contractId: r.contract_id ?? null });
        bus.publish("memory.officer_reason", { gtin: r.gtin, market: r.market, memories: mems.map((m) => m.id) });
        return { memories: mems.map((m) => m.id) };
      });
    }
  };
  /**
   * What an executed decision rests on, for the trace: the signed proposal's run (firings,
   * policy version, policy evidence) or, for a RELEASE, the hold it overrode; plus the reason.
   */
  const executedContext = (row: DecisionRow, reason: string, release: boolean): ExecutedContext => {
    const item = release ? null : (deps.queue.all().find((i) => i.kind === "proposal" && i.resolution?.decision_id === row.decision_id) ?? null);
    const run = item?.run_id ? loadRun(item.run_id) : release ? runStore.latest(row.gtin, row.market as Market) : null;
    if (!run) return { reason };
    const policyEv = [...evidenceOf(run.run_id)].reverse().find((r) => r.kind === "policy")?.id ?? null;
    if (release) {
      const over = [...new Set(run.decision.firings.filter((f) => f.effect === "HOLD" || f.effect === "BLOCK").map((f) => f.rule))];
      return { reason, runId: run.run_id, evidenceId: policyEv, policyVersion: run.decision.policyVersion ?? null, releasedOver: over };
    }
    return { reason, runId: run.run_id, firings: run.decision.firings, evidenceId: policyEv, policyVersion: run.decision.policyVersion ?? null };
  };
  /** An executed decision into the World Model and the H-MEM decision log. */
  const recordRow = async (row: DecisionRow, ctx: ExecutedContext = {}) => {
    if (!rt) return null;
    try {
      const r = await recordExecuted(rt, row, ctx);
      bus.publish("world.recorded", { gtin: row.gtin, market: row.market, decision_id: row.decision_id, snapshot_id: r.snapshot_id, decision_memory: r.decision_memory_id });
      return r;
    } catch (e) {
      log(`recording ${row.decision_id} in memory failed: ${(e as Error).message}`);
      return null;
    }
  };
  let port = 0;

  const submitPoll = (until?: string | null, scheduled = false): Job =>
    jobs.submit("watch.poll", { until: until ?? null, ...(scheduled ? { scheduled: true } : {}) }, async () => {
      const r = await deps.watch.poll({ until: until ?? undefined });
      return { sweep_id: r.sweep_id, banner: r.banner, window: r.window, notices: r.notices.length, exact_matches: r.exact_matches, name_matches: r.name_matches.length, actions: r.actions, recheck_rows: r.recheck.rows.length, gaps: r.gaps };
    });

  const loadRun = (id: string): ClearResult | null => runStore.load(id);

  function evidenceOf(runId: string): EvidenceRecord[] {
    if (!evidenceDir) return [];
    const p = `${evidenceDir.replace(/[\\/]$/u, "")}/${runId}.jsonl`;
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as EvidenceRecord);
  }

  /**
   * Deterministic checks over the run's label text, for the card: what the keyword baseline
   * (system K, comparison only) flags, and the verifier's trap readings (e.g. "cocoa butter is
   * not milk fat"). Offsets index the text in the run's `product` evidence record.
   */
  function labelChecks(run: ClearResult): { text_field: string; keyword: { group: string; term: string; start: number; end: number }[]; traps: { group: string; term: string; start: number; end: number; reason: string }[] } | null {
    const rec = evidenceOf(run.run_id).find((r) => r.template_id === "product" && Array.isArray(r.columns) && Array.isArray(r.rows) && r.rows.length);
    if (!rec) return null;
    const field = run.product?.text_field ?? "ingredients_text";
    const idx = (rec.columns as string[]).indexOf(field);
    const text = idx >= 0 ? (rec.rows as unknown[][])[0]?.[idx] : null;
    if (typeof text !== "string" || !text.trim() || text !== text.normalize("NFC")) return null;
    return {
      text_field: field,
      keyword: keywordBaseline(text).map((h) => ({ group: h.group, term: h.term, start: h.start, end: h.end })),
      traps: lexiconScan(text)
        .filter((h) => h.trap)
        .map((h) => ({ group: h.group, term: h.term, start: h.start, end: h.end, reason: h.trap!.reason })),
    };
  }

  /** JSON files in a configured directory, newest first; names come from the directory listing only. */
  function newestFiles(dir: string | null, keep: (name: string) => boolean): { name: string; path: string }[] {
    if (!dir || !existsSync(dir)) return [];
    const base = dir.replace(/[\\/]$/u, "");
    return readdirSync(dir)
      .filter((n) => n.endsWith(".json") && keep(n))
      .map((name) => {
        const path = `${base}/${name}`;
        return { name, path, mtime: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
  }

  function readObject(path: string): Record<string, unknown> | null {
    try {
      const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** The footer's figures: every number is copied from a measured file with its label, or null. */
  function telemetry(): Record<string, unknown> {
    let latest: Record<string, unknown> | null = null;
    const rates: number[] = [];
    for (const f of newestFiles(loopDir, (n) => n.endsWith(".loop.json"))) {
      if (latest && rates.length >= 5) break;
      const d = readObject(f.path);
      const loop = d?.loop as { chunks?: number; chart?: unknown[]; summary?: { median_planner_tokens_per_s?: number | null } } | undefined;
      if (!d || !loop || typeof loop !== "object") continue;
      latest ??= { file: f.name, run_id: d.run_id ?? null, gtin: d.gtin ?? null, market: d.market ?? null, chunks: loop.chunks ?? null, chart: loop.chart ?? [], summary: loop.summary ?? null };
      const r = loop.summary?.median_planner_tokens_per_s;
      if (rates.length < 5 && typeof r === "number" && Number.isFinite(r)) rates.push(r);
    }
    rates.sort((a, b) => a - b);
    const mid = Math.floor(rates.length / 2);
    const median = rates.length ? (rates.length % 2 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2) : null;

    let vram: unknown = null;
    let coldWarm: unknown = null;
    const files: { vram: string | null; cold_warm: string | null } = { vram: null, cold_warm: null };
    for (const f of newestFiles(evalDir, () => true)) {
      if (vram && coldWarm) break;
      const d = readObject(f.path);
      if (!d) continue;
      if (!vram && d.vram && typeof d.vram === "object") {
        vram = d.vram;
        files.vram = f.name;
      }
      if (!coldWarm && (d.cold_warm || (f.name.startsWith("cold-warm-") && Array.isArray(d.runs)))) {
        coldWarm = d.cold_warm ?? d;
        files.cold_warm = f.name;
      }
    }
    return {
      model: deps.ollama.model,
      model_host: (deps.ollama as { baseUrl?: string }).baseUrl ?? null,
      cloud_model_calls: 0,
      refused_non_local_model_hosts: refusedModelHostAttempts(),
      planner_tokens_per_s: median === null ? null : { value: median, label: "measured", runs: rates.length },
      latest_loop: latest,
      vram,
      cold_warm: coldWarm,
      eval_file: files,
    };
  }

  function hostOk(req: IncomingMessage): boolean {
    const h = String(req.headers.host ?? "").toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  }

  function originOk(req: IncomingMessage): boolean {
    const o = req.headers.origin;
    if (!o) return true;
    return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  }

  /** Clears one SKU; HOLD/BLOCK applied automatically, CLEAR proposals queued. Runs inside a job. */
  async function runClear(gtin: string, market: Market, asOf: string | undefined): Promise<Record<string, unknown>> {
    const banner = asOf ? replayBanner(asOf) : null;
    const gw = asOf ? new AsOfGateway(deps.gateway, asOf, banner) : deps.gateway;
    const evidence = asOf ? new ReplayEvidenceStore({ as_of: asOf, banner: banner! }, undefined, evidenceDir) : new EvidenceStore(undefined, evidenceDir);
    if (rt) {
      const o = await clearWithAgent(rt, {
        gtin,
        market,
        asOf,
        gateway: gw,
        evidence,
        trigger: "intake",
        intake: true,
        replay: asOf ? { asOf, banner: banner! } : null,
        onEvent: (type, data) => bus.publish(type, { ...data, banner }),
        log: (l) => bus.publish("clear.log", { gtin, market, line: l.trim() }),
      });
      runStore.save(o.result, {
        source: "server",
        applied: !!o.applied,
        decision_id: o.applied?.decision_id ?? null,
        queue_id: o.queued?.queue_id ?? null,
        replay: banner,
        note: o.applied ? `${o.applied.status} applied automatically` : o.queued ? `${o.queued.status} queued for the officer's signed approval` : "not applied",
      });
      return {
        run_id: o.result.run_id,
        gtin,
        market,
        status: o.result.decision.status,
        rules: [...new Set(o.result.decision.firings.map((f) => f.rule))],
        banner,
        engine: "markovian",
        chunks: o.result.loop.chunks,
        applied: !!o.applied,
        ...(o.applied ? { decision_id: o.applied.decision_id, contract_id: o.applied.contract_id, visible_in_zetaris: o.applied.visible_in_zetaris } : {}),
        ...(o.queued ? { queue_id: o.queued.queue_id } : {}),
        memory: o.recorded?.memory ?? null,
        world: o.recorded?.world ?? null,
      };
    }
    const pdeps: PipelineDeps = {
      gateway: gw,
      dq: new DqGate(gw),
      ollama: deps.ollama,
      evidence,
      log: (l) => bus.publish("clear.log", { gtin, market, line: l.trim() }),
    };
    bus.publish("clear.started", { gtin, market, as_of: asOf ?? null, banner, run_id: evidence.runId });
    const r = await clear(gtin, market, pdeps, asOf);
    const out: Record<string, unknown> = { run_id: r.run_id, gtin, market, status: r.decision.status, rules: [...new Set(r.decision.firings.map((f) => f.rule))], banner };
    if (r.decision.status === "HOLD" || r.decision.status === "BLOCK") {
      const reason = `auto ${r.decision.status} at intake (policy ${r.decision.policyVersion}): ${r.decision.firings
        .filter((f) => f.effect === "HOLD" || f.effect === "BLOCK")
        .map((f) => `${f.rule} ${f.reason}`)
        .join("; ")}`.slice(0, 900);
      const applied = await applyAutomatic(deps.ops, deps.gateway, { gtin, market, status: r.decision.status, reason, runId: r.run_id, replay: asOf ? { asOf, banner: banner! } : null }, deps.queue).catch((e: unknown) => {
        runStore.save(r, { source: "server", applied: false, replay: banner, note: `auto ${r.decision.status} not written: ${(e as Error).message.slice(0, 200)}` });
        throw e;
      });
      Object.assign(out, { applied: true, decision_id: applied.row.decision_id, contract_id: applied.contract.contractId, visible_in_zetaris: applied.visibility.visible, superseded: applied.superseded });
      runStore.save(r, { source: "server", applied: true, decision_id: applied.row.decision_id, replay: banner, note: `${r.decision.status} applied automatically (straight pipeline)` });
      bus.publish("decision.written", { ...out, auto: true });
    } else {
      const item = deps.queue.add({
        kind: "proposal",
        gtin,
        market,
        status: r.decision.status,
        statement: r.statement?.text ?? null,
        summary: `${r.decision.status} proposed at intake; pending the officer's signed approval`,
        reasons: r.decision.firings.map((f) => `${f.rule} ${f.reason}`),
        evidence_ids: r.evidence_ids.slice(0, 20),
        run_id: r.run_id,
        source: "clear",
        replay: asOf ? { as_of: asOf, banner: banner! } : null,
        over_decision: overDecision(deps.ops, gtin, market),
      });
      Object.assign(out, { applied: false, queue_id: item.id });
      runStore.save(r, { source: "server", applied: false, queue_id: item.id, replay: banner, note: `${r.decision.status} queued for the officer's signed approval (straight pipeline)` });
      bus.publish("approval.queued", { ...out });
    }
    bus.publish("clear.done", out);
    return out;
  }

  /**
   * What a RELEASE may not override (an open recall is checked at execution): an allergen
   * conflict H-MEM still has queued for the SKU (the officer resolves it first), and untrusted
   * text found by the SKU's latest clearance (it is re-cleared once the source is corrected).
   */
  function releaseBlockers(gtin: string, market: Market): string[] {
    const out: string[] = [];
    if (rt) {
      const brand = deps.catalogue.skus.find((k) => k.gtin === gtin)?.brand ?? null;
      const queued = rt.hmem.queuedConflicts(gtin, brand);
      if (queued.length) out.push(`the queued allergen conflict(s) ${queued.map((c) => `${c.id} (${c.allergen})`).join(", ")} are resolved`);
    }
    const run = runStore.latest(gtin, market);
    if (run?.contradictions.some((c) => c.kind === "untrusted_text")) out.push(`the untrusted text found by run ${run.run_id} is corrected at the source and the SKU re-cleared`);
    return out;
  }

  function contractError(e: unknown): never {
    if (e instanceof ContractRefused) {
      bus.publish("contract.refused", { code: e.refusal, reason: e.message });
      throw new HttpError(403, e.message, e.refusal);
    }
    if (e instanceof OpsError) throw new HttpError(e.status, e.message, e.code);
    if (e instanceof GatewayError) throw new HttpError(502, e.message, "gateway");
    throw e;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const p = url.pathname;
    const m = req.method ?? "GET";
    if (m !== "GET" && m !== "HEAD" && !originOk(req)) throw new HttpError(403, "cross-origin request refused", "origin");

    if (m === "GET" && p === "/api/events") return bus.attach(req, res);

    if (m === "GET" && p === "/api/health") {
      const st = deps.watch.state();
      const out: Record<string, unknown> = {
        ok: true,
        service: "clearshelf-agent",
        model: deps.ollama.model,
        gateway: deps.gateway.baseUrl,
        watch: { mode: st?.mode ?? "off", as_of: st?.as_of ?? null, banner: deps.watch.banner(), busy: deps.watch.busy },
        jobs_pending: jobs.pending,
        sse_listeners: bus.listeners,
      };
      if (url.searchParams.get("deep") === "1") {
        try {
          const h = await deps.gateway.health();
          out.gateway_health = { ok: h.ok, reader_mode: h.reader_mode, last_warmup: h.last_warmup };
        } catch (e) {
          out.gateway_health = { ok: false, error: (e as Error).message.slice(0, 200) };
        }
      }
      return send(res, 200, out);
    }

    if (m === "GET" && p === "/api/catalogue") {
      const cur = deps.ops.current();
      const pending = deps.queue.pending();
      return send(res, 200, {
        source: deps.catalogue.source,
        banner: deps.watch.banner(),
        skus: deps.catalogue.skus.map((k) => ({
          gtin: k.gtin,
          name: k.name,
          brand: k.brand,
          markets: k.markets,
          scenarios: k.scenarios,
          decisions: Object.fromEntries(k.markets.map((mk) => [mk, cur.get(`${k.gtin}|${mk}`) ?? null])),
          latest_runs: Object.fromEntries(k.markets.map((mk) => [mk, runStore.latestId(k.gtin, mk)])),
          pending: pending.filter((q) => q.gtin === k.gtin).map((q) => ({ id: q.id, kind: q.kind, market: q.market, status: q.status })),
        })),
      });
    }

    if (m === "POST" && p === "/api/clear") {
      const b = await readJson(req);
      const { gtin, input } = intakeGtinOf(b.gtin);
      const market = marketOf(b.market);
      const asOf = dateOf(b.as_of, "as_of");
      const job = jobs.submit("clear", { gtin, market, as_of: asOf ?? null }, () => runClear(gtin, market, asOf));
      return send(res, 202, { job_id: job.id, state: job.state, gtin, ...(input ? { normalised_from: input } : {}) });
    }

    const jm = /^\/api\/jobs\/([A-Za-z0-9]+)$/u.exec(p);
    if (m === "GET" && jm) {
      const job = jobs.jobs.get(jm[1]!);
      if (!job) throw new HttpError(404, "no such job", "not_found");
      return send(res, 200, job);
    }

    const rm = /^\/api\/runs\/([^/]+)$/u.exec(p);
    if (m === "GET" && rm) {
      if (!RUN_ID.test(rm[1]!)) throw new HttpError(400, "bad run id", "bad_id");
      const r = loadRun(rm[1]!);
      if (!r) throw new HttpError(404, "no such run", "not_found");
      return send(res, 200, r);
    }

    const sm = /^\/api\/sku\/(\d{13})$/u.exec(p);
    if (m === "GET" && sm) {
      const gtin = gtinOf(sm[1]);
      const sku = deps.catalogue.skus.find((k) => k.gtin === gtin) ?? null;
      const cur = deps.ops.current();
      const markets: Market[] = sku?.markets ?? ["UK", "US"];
      return send(res, 200, {
        gtin,
        sku,
        banner: deps.watch.banner(),
        markets: Object.fromEntries(
          markets.map((mk) => {
            const run = runStore.latest(gtin, mk);
            return [mk, { decision: cur.get(`${gtin}|${mk}`) ?? null, run, pending: deps.queue.pending().filter((q) => q.gtin === gtin && q.market === mk), label_checks: run ? labelChecks(run) : null }];
          }),
        ),
      });
    }

    const em = /^\/api\/evidence\/([^/]+)(?:\/([^/]+))?$/u.exec(p);
    if (m === "GET" && em) {
      if (!RUN_ID.test(em[1]!)) throw new HttpError(400, "bad run id", "bad_id");
      const recs = evidenceOf(em[1]!);
      if (em[2]) {
        if (!EV_ID.test(em[2])) throw new HttpError(400, "bad evidence id", "bad_id");
        const one = recs.find((r) => r.id === em[2]);
        if (!one) throw new HttpError(404, "no such evidence record", "not_found");
        return send(res, 200, one);
      }
      return send(res, 200, { run_id: em[1], records: recs });
    }

    if (m === "GET" && p === "/api/approvals") {
      const state = url.searchParams.get("state");
      const items = deps.queue.all().filter((i) => !state || i.state === state);
      return send(res, 200, { items });
    }

    if (m === "POST" && p === "/api/approvals/sign") {
      const b = await readJson(req);
      const action = s(b.action, "action") as "CLEAR" | "CLEAR_WITH_STATEMENT" | "RELEASE";
      if (!["CLEAR", "CLEAR_WITH_STATEMENT", "RELEASE"].includes(action)) throw new HttpError(400, "action must be CLEAR, CLEAR_WITH_STATEMENT or RELEASE", "bad_action");
      const status = (action === "RELEASE" ? s(b.status, "status") : action) as "CLEAR" | "CLEAR_WITH_STATEMENT";
      if (action === "RELEASE") {
        const blockers = releaseBlockers(gtinOf(b.gtin), marketOf(b.market));
        if (blockers.length) {
          bus.publish("contract.refused", { gtin: b.gtin, market: b.market, action, code: "release_blocked", blockers });
          throw new HttpError(409, `refused: RELEASE is blocked until ${blockers.join("; ")}`, "release_blocked");
        }
      }
      try {
        const { contract, item } = signApproval(deps.ops, deps.queue, {
          gtin: gtinOf(b.gtin),
          market: marketOf(b.market),
          action,
          status,
          statement: b.statement === undefined || b.statement === null ? null : s(b.statement, "statement"),
          reason: s(b.reason, "reason"),
          officer: s(b.officer ?? OFFICER, "officer"),
          queueId: b.queue_id ? s(b.queue_id, "queue_id") : undefined,
        });
        bus.publish("contract.signed", { contract_id: contract.contractId, action, gtin: b.gtin, market: b.market, expires_at: contract.expiresAt, queue_id: item?.id ?? null });
        return send(res, 200, { contract, queue_id: item?.id ?? null });
      } catch (e) {
        contractError(e);
      }
    }

    if (m === "POST" && p === "/api/execute") {
      const b = await readJson(req);
      const gtin = gtinOf(b.gtin);
      const market = marketOf(b.market);
      const status = s(b.status, "status") as Decision;
      const action = b.action === "RELEASE" ? "RELEASE" : undefined;
      const statement = b.statement === undefined || b.statement === null ? null : s(b.statement, "statement");
      const reason = s(b.reason, "reason");
      try {
        const ex = await executeDecision(deps.ops, deps.gateway, deps.queue, { gtin, market, status, statement, action, reason, contract: b.contract });
        const rec = await recordRow(ex.row, executedContext(ex.row, reason, action === "RELEASE"));
        const out = { decision_id: ex.row.decision_id, contract_id: ex.contract.contractId, row: ex.row, visible_in_zetaris: ex.visibility.visible, closed_loop_sql: ex.visibility.result?.sql ?? null, signed_clear_dq: ex.signedClear ? dqOut(ex.signedClear.dq, ex.signedClear.row_invalid) : null, recorded: rec };
        bus.publish("decision.written", { gtin, market, status, auto: false, decision_id: ex.row.decision_id, contract_id: ex.contract.contractId, visible_in_zetaris: ex.visibility.visible });
        officerReason({ kind: action === "RELEASE" ? "release" : "approve", gtin, market, reason, contract_id: ex.contract.contractId, decision_id: ex.row.decision_id });
        return send(res, 200, out);
      } catch (e) {
        contractError(e);
      }
    }

    if (m === "POST" && p === "/api/decisions") {
      // Manual decisions by the officer. HOLD and BLOCK are low risk: the server issues the contract.
      // Anything else needs a signed contract through /api/execute; the attempt is refused and logged.
      const b = await readJson(req);
      const gtin = gtinOf(b.gtin);
      const market = marketOf(b.market);
      const status = s(b.status, "status");
      const reason = s(b.reason, "reason");
      if (status !== "HOLD" && status !== "BLOCK") {
        const isRelease = status === "RELEASE";
        const { action, params } = decisionContractParams({ gtin, market, status: (isRelease ? "CLEAR" : status) as Decision, statement: null, action: isRelease ? "RELEASE" : undefined });
        const v = deps.ops.verifier.verify(b.contract, { action, params });
        bus.publish("contract.refused", { gtin, market, status, code: v.ok ? "use_execute" : v.code });
        throw new HttpError(403, `refused: ${status} needs an officer-signed contract and runs only through POST /api/execute${v.ok ? "" : ` (${v.code}: ${v.reason})`}`, v.ok ? "use_execute" : v.code);
      }
      const { action, params } = decisionContractParams({ gtin, market, status, statement: null });
      const contract = deps.ops.verifier.issue({ action, parameters: params, user: OFFICER, surface: "clearshelf-ui", flags: ["manual"] });
      try {
        const ex = await executeDecision(deps.ops, deps.gateway, deps.queue, { gtin, market, status, statement: null, reason: `officer ${status}: ${reason}`, contract, actor: OFFICER });
        await recordRow(ex.row, { reason });
        bus.publish("decision.written", { gtin, market, status, auto: false, decision_id: ex.row.decision_id, visible_in_zetaris: ex.visibility.visible });
        if (ex.superseded.length) bus.publish("approval.superseded", { gtin, market, queue_ids: ex.superseded, decision_id: ex.row.decision_id });
        officerReason({ kind: "manual", gtin, market, reason, decision_id: ex.row.decision_id });
        return send(res, 200, { decision_id: ex.row.decision_id, row: ex.row, visible_in_zetaris: ex.visibility.visible, superseded: ex.superseded });
      } catch (e) {
        contractError(e);
      }
    }

    if (m === "POST" && (p === "/api/approvals/reject" || p === "/api/approvals/confirm")) {
      // reject: a proposal is rejected (the listing is held) or a name match dismissed (no change).
      // confirm: a name-only match is confirmed by the officer, so the listing is held (policy R2).
      const b = await readJson(req);
      const id = s(b.queue_id, "queue_id");
      const reason = s(b.reason, "reason");
      const officer = s(b.officer ?? OFFICER, "officer");
      if (officer !== OFFICER) throw new HttpError(403, `unknown approver ${officer}`, "not_officer");
      const item = deps.queue.get(id);
      if (!item || item.state !== "pending") throw new HttpError(409, "no pending queue item with that id", "not_pending");
      const confirm = p.endsWith("/confirm");
      if (confirm && item.kind !== "name_match") throw new HttpError(400, "confirm applies to name-only matches; proposals are signed", "bad_kind");
      const hold = confirm || item.kind === "proposal";
      if (!hold) {
        const it = deps.queue.resolve(id, "rejected", { by: officer, reason });
        officerReason({ kind: "dismiss_name_match", gtin: it.gtin, market: it.market, reason });
        bus.publish("approval.resolved", { queue_id: id, state: "rejected" });
        return send(res, 200, { item: it });
      }
      const { action, params } = decisionContractParams({ gtin: item.gtin, market: item.market, status: "HOLD", statement: null });
      const contract = deps.ops.verifier.issue({ action, parameters: params, user: officer, surface: "clearshelf-ui", flags: [confirm ? "name_match_confirmed" : "proposal_rejected"] });
      try {
        const ex = await executeDecision(deps.ops, deps.gateway, null, {
          gtin: item.gtin,
          market: item.market,
          status: "HOLD",
          statement: null,
          reason: `${confirm ? `officer confirmed name-only match ${item.notice_id ?? ""}` : `officer rejected the ${item.status} proposal`}: ${reason}`,
          contract,
          actor: officer,
        });
        await recordRow(ex.row, { reason: `${confirm ? `confirmed name-only match ${item.notice_id ?? ""}` : `rejected the ${item.status} proposal ${item.id}`}: ${reason}`, runId: item.run_id || null });
        const it = deps.queue.resolve(id, confirm ? "approved" : "rejected", { by: officer, reason, contract_id: contract.contractId, decision_id: ex.row.decision_id });
        // The officer's HOLD outranks any other proposal still pending for the SKU.
        const superseded = supersedeBy(deps.queue, ex.row);
        officerReason({ kind: confirm ? "confirm_name_match" : "reject", gtin: item.gtin, market: item.market, reason, decision_id: ex.row.decision_id });
        bus.publish("decision.written", { gtin: item.gtin, market: item.market, status: "HOLD", auto: false, decision_id: ex.row.decision_id, visible_in_zetaris: ex.visibility.visible });
        if (superseded.length) bus.publish("approval.superseded", { gtin: item.gtin, market: item.market, queue_ids: superseded, decision_id: ex.row.decision_id });
        return send(res, 200, { item: it, decision_id: ex.row.decision_id, visible_in_zetaris: ex.visibility.visible, superseded });
      } catch (e) {
        contractError(e);
      }
    }

    if (m === "GET" && p === "/api/ops/decisions") {
      return send(res, 200, { rows: deps.ops.decisions().length, current: [...deps.ops.current().values()] });
    }

    if (m === "GET" && (p === "/api/recheck" || p === "/api/join-map")) {
      try {
        const r = await deps.gateway.template(p === "/api/recheck" ? "recheck_cleared" : "join_map", {});
        const out = { rows: rowsAsObjects(r), sql: r.sql, sql_sha256: r.sql_sha256, objects: r.objects, executed_at: r.executed_at, elapsed_ms: r.elapsed_ms, cache_state: r.cache_state };
        // The recheck also asks Zetaris's write-back DQ rules about every decision it reads back.
        if (p === "/api/recheck") return send(res, 200, { ...out, dq: (await writebackDq(deps.gateway)).map((d) => dqOut(d)) });
        return send(res, 200, out);
      } catch (e) {
        contractError(e);
      }
    }

    if (m === "GET" && p === "/api/telemetry") return send(res, 200, telemetry());

    if (m === "GET" && p === "/api/eval/report") {
      // The measured evaluation report (docs/eval-report.md) for the /eval page, as written.
      if (!evalReport || !existsSync(evalReport)) throw new HttpError(404, "no evaluation report yet (docs/eval-report.md)", "not_found");
      return send(res, 200, { file: "docs/eval-report.md", updated_at: new Date(statSync(evalReport).mtimeMs).toISOString(), markdown: readFileSync(evalReport, "utf8") });
    }

    const lp = /^\/api\/loops\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(p);
    if (m === "GET" && lp) {
      if (!RUN_ID.test(lp[1]!)) throw new HttpError(400, "bad run id", "bad_id");
      if (!/^\d{13}$/u.test(lp[2]!)) throw new HttpError(400, "the GTIN must be 13 digits", "bad_gtin");
      const market = marketOf(lp[3]);
      const base = loopDir ? loopDir.replace(/[\\/]$/u, "") : null;
      const exact = base ? `${base}/${lp[1]}-${lp[2]}-${market}.loop.json` : null;
      if (exact && existsSync(exact)) return send(res, 200, readObject(exact) ?? {});
      const plain = base ? `${base}/${lp[1]}.loop.json` : null;
      const d = plain && existsSync(plain) ? readObject(plain) : null;
      if (d && d.gtin === lp[2] && d.market === market) return send(res, 200, d);
      throw new HttpError(404, "no loop report for that run, GTIN and market", "not_found");
    }

    if (m === "GET" && p === "/api/contracts/log") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 500);
      const path = deps.ops.verifier.logPath;
      const lines = path && existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
      return send(res, 200, { entries: lines.slice(-limit).map((l) => JSON.parse(l)) });
    }

    // ---- recall watch ----
    if (m === "GET" && p === "/api/watch/state") {
      return send(res, 200, { state: deps.watch.state(), banner: deps.watch.banner(), busy: deps.watch.busy });
    }
    if (m === "POST" && p === "/api/watch/replay") {
      const b = await readJson(req);
      const asOf = dateOf(b.as_of, "as_of");
      if (!asOf) throw new HttpError(400, "as_of is required", "missing_field");
      const until = dateOf(b.until, "until");
      const scope = (b.scope === "all" || b.scope === "none" ? b.scope : "scenario") as "scenario" | "all" | "none";
      const thenPoll = b.poll === true;
      const job = jobs.submit("watch.replay", { as_of: asOf, scope, poll: thenPoll, until: until ?? null }, async () => {
        const base = await deps.watch.startReplay(asOf, { scope });
        const out: Record<string, unknown> = { baseline: base.sweep_id, banner: base.banner, actions: base.actions };
        if (thenPoll) {
          const pr = await deps.watch.poll({ until });
          Object.assign(out, { poll: pr.sweep_id, notices: pr.notices.length, poll_actions: pr.actions, name_matches: pr.name_matches.length });
        }
        return out;
      });
      return send(res, 202, { job_id: job.id, banner: replayBanner(asOf) });
    }
    if (m === "POST" && p === "/api/watch/poll") {
      const b = await readJson(req);
      const job = submitPoll(dateOf(b.until, "until"));
      return send(res, 202, { job_id: job.id });
    }
    if (m === "POST" && p === "/api/watch/live") {
      const b = await readJson(req);
      return send(res, 200, { state: deps.watch.goLive(dateOf(b.since, "since")) });
    }
    if (m === "GET" && p === "/api/watch/sweeps") {
      const ids = new Set<string>([...deps.watch.sweeps.keys()]);
      if (sweepDir && existsSync(sweepDir)) for (const f of readdirSync(sweepDir)) if (f.endsWith(".json")) ids.add(f.slice(0, -5));
      return send(res, 200, { sweeps: [...ids].sort().reverse() });
    }
    const wm = /^\/api\/watch\/sweeps\/([^/]+)$/u.exec(p);
    if (m === "GET" && wm) {
      if (!RUN_ID.test(wm[1]!)) throw new HttpError(400, "bad sweep id", "bad_id");
      const mem = deps.watch.sweeps.get(wm[1]!);
      if (mem) return send(res, 200, mem);
      const f = sweepDir ? `${sweepDir.replace(/[\\/]$/u, "")}/${wm[1]}.json` : null;
      if (!f || !existsSync(f)) throw new HttpError(404, "no such sweep", "not_found");
      return send(res, 200, JSON.parse(readFileSync(f, "utf8")));
    }

    // ---- memory and World Model (wired runtime only) ----
    if (p.startsWith("/api/why/") || p.startsWith("/api/memory/") || p.startsWith("/api/world/")) {
      if (!rt) throw new HttpError(404, "memory and World Model are not wired in this server", "not_wired");
      const officerOf = (b: Record<string, unknown>) => {
        const o = s(b.officer ?? OFFICER, "officer");
        if (o !== OFFICER) throw new HttpError(403, `unknown approver ${o}`, "not_officer");
        return o;
      };
      const wy = /^\/api\/why\/(\d{13})\/(UK|US)$/u.exec(p);
      if (m === "GET" && wy) return send(res, 200, await whyTrace(rt, gtinOf(wy[1]), wy[2] as Market, { evidenceDir }));
      if (m === "GET" && p === "/api/memory/conflicts") {
        const state = url.searchParams.get("state");
        // Each side with what the memory says (read straight from the store, so listing logs no ledger reads) and the product it is about.
        const mems = new Map(rt.hmem.store.all().map((x) => [x.id, x]));
        const side = (id: string) => {
          const x = mems.get(id);
          return x ? { id, content: x.content, source: x.source, label: x.provenance?.label ?? null, refs: (x.provenance?.refs ?? []).slice(0, 6) } : { id, content: null, source: null, label: null, refs: [] };
        };
        const conflicts = rt.hmem.allergenConflicts
          .all()
          .filter((c) => !state || c.status === state)
          .map((c) => {
            const sku = c.gtin ? deps.catalogue.skus.find((k) => k.gtin === c.gtin) : null;
            return { ...c, product: sku ? { name: sku.name, brand: sku.brand, markets: sku.markets } : null, sides: { a: side(c.a), b: side(c.b) } };
          });
        return send(res, 200, { conflicts });
      }
      if (m === "POST" && p === "/api/memory/conflicts/resolve") {
        const b = await readJson(req);
        officerOf(b);
        const id = s(b.id, "id");
        const r = { winner: s(b.winner, "winner"), rule: s(b.rule, "rule"), reason: s(b.reason, "reason") };
        try {
          rt.hmem.allergenConflicts.validateResolution(id, r);
        } catch (e) {
          throw new HttpError(400, (e as Error).message, "bad_resolution");
        }
        const job = jobs.submit("memory.resolve_conflict", { id }, async () => {
          const c = await rt.hmem.resolveAllergenConflict(id, r);
          bus.publish("memory.conflict_resolved", { id, winner: r.winner, rule: r.rule });
          return { conflict: c as unknown as Record<string, unknown> };
        });
        return send(res, 202, { job_id: job.id });
      }
      if (m === "GET" && p === "/api/memory/dreams") {
        // How many separate officer rulings dreaming has to work from (it needs two pointing the same way).
        const acts = new Set(rt.hmem.store.all().filter((x) => x.tags.includes("actor:officer")).flatMap((x) => x.tags.filter((t) => t.startsWith("officer-act:"))));
        return send(res, 200, { proposals: rt.hmem.dreams(), officer_rulings: acts.size, runs_after: "each recall-watch sweep" });
      }
      if (m === "GET" && p === "/api/memory/sources") {
        // Source-access memories (seeded notes and documents), read straight from the store so the panel logs no ledger reads.
        const memories = rt.hmem.store
          .all()
          .filter((x) => x.tags.includes("kind:source_note") || (x.tags.includes("document") && x.tags.some((t) => t.startsWith("source:"))))
          .map((x) => ({ id: x.id, content: x.content, tags: x.tags, label: x.provenance?.label ?? null, learned_at: x.provenance?.learnedAt ? new Date(x.provenance.learnedAt).toISOString() : null, superseded_by: x.supersededBy ?? null }));
        return send(res, 200, { memories });
      }
      if (m === "POST" && (p === "/api/memory/dreams/approve" || p === "/api/memory/dreams/reject")) {
        const b = await readJson(req);
        const by = officerOf(b);
        const id = s(b.id, "id");
        const reason = s(b.reason, "reason");
        try {
          if (p.endsWith("/approve")) {
            const mem = rt.hmem.approveDream(id, { by, reason });
            bus.publish("memory.dream_approved", { id, memory: mem.id });
            return send(res, 200, { id, memory: mem.id });
          }
          rt.hmem.rejectDream(id, { by, reason });
          bus.publish("memory.dream_rejected", { id });
          return send(res, 200, { id });
        } catch (e) {
          throw new HttpError(409, (e as Error).message, "not_pending");
        }
      }
      if (m === "GET" && p === "/api/world/export") return send(res, 200, rt.world.exportGraph());
      const tl = /^\/api\/world\/timeline\/(\d{13})$/u.exec(p);
      if (m === "GET" && tl) {
        const g = gtinOf(tl[1]);
        return send(res, 200, { gtin: g, timeline: rt.world.timeline(g), snapshots: rt.world.snapshotsFor(g) });
      }
      if (m === "GET" && p === "/api/world/merges") return send(res, 200, { proposals: rt.world.mergeQueue() });
      if (m === "POST" && (p === "/api/world/merges/approve" || p === "/api/world/merges/reject")) {
        const b = await readJson(req);
        const by = officerOf(b);
        const id = s(b.id, "id");
        const reason = b.reason === undefined || b.reason === null ? null : s(b.reason, "reason");
        try {
          if (p.endsWith("/approve")) await rt.world.approveMerge(id, by);
          else await rt.world.rejectMerge(id, by);
        } catch (e) {
          throw new HttpError(409, (e as Error).message, "not_pending");
        }
        bus.publish("world.merge_resolved", { id, approved: p.endsWith("/approve"), reason });
        if (reason) officerReason({ kind: p.endsWith("/approve") ? "merge_approve" : "merge_reject", gtin: null, market: null, reason });
        return send(res, 200, { id, reason });
      }
    }

    if (p.startsWith("/api/")) throw new HttpError(404, `no route ${m} ${p}`, "not_found");

    // The evaluation page lives in the UI's hash routes.
    if ((m === "GET" || m === "HEAD") && (p === "/eval" || p === "/eval/")) {
      res.writeHead(302, { location: "/#/eval" });
      res.end();
      return;
    }

    // ---- static UI ----
    if ((m === "GET" || m === "HEAD") && uiDir) {
      const root = resolve(uiDir);
      const rel = decodeURIComponent(p === "/" ? "/index.html" : p);
      const file = resolve(root, `.${rel}`);
      if (!file.startsWith(root + sep) || rel.includes("\0")) throw new HttpError(403, "outside the UI directory", "forbidden");
      if (existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        if (m === "HEAD") return void res.end();
        createReadStream(file).pipe(res);
        return;
      }
    }
    throw new HttpError(404, "not found", "not_found");
  }

  const server = http.createServer((req, res) => {
    if (!hostOk(req)) return send(res, 421, { error: "unknown Host; ClearShelf answers on 127.0.0.1 only", code: "host" });
    route(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
      log(`error ${req.method} ${req.url}: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) send(res, 500, { error: (e as Error).message.slice(0, 300), code: "internal" });
      else res.end();
    });
  });

  return {
    server,
    bus,
    jobs,
    runs: runStore.runs,
    runStore,
    listen(p: number, host = "127.0.0.1"): Promise<number> {
      if (host !== "127.0.0.1" && host !== "localhost") throw new Error("ClearShelf listens on 127.0.0.1 only");
      return new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(p, host, () => {
          const a = server.address();
          port = typeof a === "object" && a ? a.port : p;
          ok(port);
        });
      });
    },
    close(): Promise<void> {
      bus.closeAll();
      return new Promise((ok) => server.close(() => ok()));
    },
    schedulePoll(): Job | null {
      // Only a live watch is polled on a timer: a replay moves only when the officer asks.
      if (deps.watch.state()?.mode !== "live" || deps.watch.busy) return null;
      if ([...jobs.jobs.values()].some((j) => j.kind === "watch.poll" && (j.state === "queued" || j.state === "running"))) return null;
      return submitPoll(null, true);
    },
  };
}

export async function main(): Promise<void> {
  loadConfig();
  const port = Number(process.env.UI_PORT ?? 8790);
  const bus = new EventBus();
  const log = (l: string) => process.stderr.write(`${l}\n`);
  // One process holds data/hmem and data/world: the server takes data/agent.lock.
  const rt = openRuntime({ command: "server", log });
  // One run store for intake and the watch: every clearance a sweep makes is saved for its card too.
  const runStore = new RunStore();
  const watch = agentWatch(rt, { emit: (type, data) => bus.publish(type, data), log, onRun: (r, o) => runStore.save(r, o) });
  const app = createServer({ gateway: rt.gateway, ollama: rt.ollama, ops: rt.ops, queue: rt.queue, watch, catalogue: rt.catalogue, bus, log, runtime: rt, runStore });
  const bound = await app.listen(port);
  log(`ClearShelf agent server on http://127.0.0.1:${bound} (gateway ${rt.gateway.baseUrl}, model ${rt.ollama.model}, actor ${AGENT_ACTOR}, Markovian clearances with H-MEM and the World Model)`);
  const every = process.env.CLEARSHELF_WATCH_EVERY_MIN ? Number(process.env.CLEARSHELF_WATCH_EVERY_MIN) : 0;
  if (every) {
    // Modest polling of openFDA and the FSA (AGENTS.md rule 6): never more often than every 5 minutes.
    if (!(every >= 5)) throw new Error("CLEARSHELF_WATCH_EVERY_MIN must be 5 or more (minutes)");
    setInterval(() => {
      const job = app.schedulePoll();
      if (job) log(`scheduled recall-watch poll ${job.id}`);
    }, every * 60_000).unref();
    log(`recall watch: a poll every ${every} min while the watch is live`);
  }
  const stop = () => {
    rt.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(resolve(process.argv[1])).href.toLowerCase()) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });
}
