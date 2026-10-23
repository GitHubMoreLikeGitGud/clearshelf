// The wiring between the lanes. One SKU clearance end to end:
//
//   1. The Markovian investigation (loop/) runs with four ports: the injection guard
//      (contract/guard.ts), H-MEM (memory step and warm extraction reuse), the World Model
//      (lookup) and the gateway. The deterministic policy decides.
//   2. HOLD and BLOCK are applied through the ops store under a low-risk contract and proven
//      visible in Zetaris; CLEAR and CLEAR_WITH_STATEMENT are queued for the officer's
//      signed approval (POST /api/execute is the only path that writes them).
//   3. H-MEM records the facts, the verified extraction and the decision (the decision log
//      that answers "why was this held?"); the World Model records the product, declared
//      and recall rows and the decision with a snapshot; the verified spans are written back
//      to the ops store, which Zetaris federates as clearance_usl.extracted_allergen.
//
// data/hmem and data/world are each a single-writer store, so a runtime that opens them
// takes data/agent.lock first: the server, the watch and the CLI never hold them at once.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, REPO_ROOT_URL } from "./config.ts";
import { ContractVerifier, loadContractSecret } from "./contract/scout.ts";
import { scanText, wrapUntrusted } from "./contract/guard.ts";
import { EvidenceStore, localIso, type EvidenceRecord } from "./evidence/store.ts";
import { textSha12, type IngredientExtractionResult } from "./extract/ingredients.ts";
import type { NoticeExtractionResult } from "./extract/notice.ts";
import type { ExtractionSpan } from "./llm/schemas.ts";
import { OllamaClient } from "./llm/ollama.ts";
import { investigateSku, type InvestigationResult } from "./loop/investigate.ts";
import type { GuardPort, MemoryPort, RegistrarPort, ToolDeps, WarmPort } from "./loop/tools.ts";
import { knownAsOf, makeWordingFn, memoryPort, openMemory, readEvidenceRecord, type DecisionState, type HMEM, type WhyTrace } from "./memory/hmemFacade.ts";
import { AGENT_ACTOR, applyAutomatic, overDecision } from "./ops/actions.ts";
import { ApprovalQueue } from "./ops/queue.ts";
import { OpsStore, type DecisionRow, type ExtractionRow } from "./ops/store.ts";
import type { clearSku, ClearResult } from "./pipeline.ts";
import type { Market } from "./policy/decide.ts";
import { keywordBaseline, verifySpans } from "./verify/lexicon.ts";
import { loadCatalogue, RecallWatch, type Catalogue, type WatchDeps, type WatchHooks } from "./watch/recallWatch.ts";
import { AsOfGateway, replayBanner, ReplayEvidenceStore } from "./watch/asOf.ts";
import { brandKey, CatalogueWorld, worldPort, type FsaBundle, type SourceMeta } from "./world/world.ts";
import { DqGate, GatewayClient, rowsAsObjects } from "./zetaris/client.ts";

export type AgentEvent = (type: string, data: Record<string, unknown>) => void;

// ---------- single-writer lock ----------

export const LOCK_FILE = fileURLToPath(new URL("data/agent.lock", REPO_ROOT_URL));

export interface AgentLock {
  path: string;
  release(): void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes data/agent.lock for this process; refuses while another live process holds it. The
 * lock file is created atomically (exclusive create), so two processes starting together
 * cannot both take it; a stale lock (its process is gone) is removed and taken once. The
 * lock is released on exit and on Ctrl+C / SIGTERM.
 */
export function acquireLock(command: string, file = LOCK_FILE): AgentLock {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify({ pid: process.pid, command, started_at: new Date().toISOString() })}\n`;
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(file, body, { encoding: "utf8", flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let held: { pid?: number; command?: string; started_at?: string } = {};
      try {
        held = JSON.parse(readFileSync(file, "utf8")) as typeof held;
      } catch {
        // unreadable: treat as stale
      }
      if ((held.pid && held.pid !== process.pid && alive(held.pid)) || attempt > 0) {
        throw new Error(
          `data/hmem and data/world are open in process ${held.pid ?? "?"} (${held.command ?? "unknown command"}, since ${held.started_at ?? "?"}); stop it first (single-writer stores)`,
        );
      }
      try {
        unlinkSync(file); // stale (or this process's own): take it over once
      } catch {
        // removed meanwhile
      }
    }
  }
  let released = false;
  const onSignal = (signal: NodeJS.Signals) => {
    release();
    // Leave the exit to any other handler (the server's); exit only when none is left.
    if (process.listenerCount(signal) === 0) process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    try {
      const cur = JSON.parse(readFileSync(file, "utf8")) as { pid?: number };
      if (cur.pid === process.pid) unlinkSync(file);
    } catch {
      // already gone
    }
  };
  process.once("exit", release);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return { path: file, release };
}

// ---------- ports ----------

/** The Scout-subset guard as the loop's port: scan on read, wrap a flagged text before any model sees it. */
export const guardPort: GuardPort = {
  scan(text, source) {
    const r = scanText(text, source);
    return { flagged: r.hit, reasons: r.findings.map((f) => `${f.kind}:${f.rule}`) };
  },
  wrap: (text, source) => wrapUntrusted(text, source),
};

/**
 * Warm runs: H-MEM's verified-extraction memory for an unchanged label (same sha256 of
 * the text) points at the earlier run's extraction evidence; the spans are read back from
 * that record and the deterministic verifier is re-run on them, so no model call is made
 * and the card cites the earlier evidence. The read is logged in the H-MEM ledger.
 */
export function warmPort(hmem: HMEM): WarmPort {
  return {
    findExtraction(gtin, text, model) {
      const sha12 = textSha12(text);
      const m = hmem.findExtraction(gtin, sha12, model);
      if (!m) return null;
      const refs = m.provenance.refs ?? [];
      const evId = refs[0];
      const file = refs.find((r) => r.endsWith(".jsonl")) ?? null;
      if (!evId || !file) return null;
      const rec = readEvidenceRecord(file, evId);
      const d = (rec?.details ?? {}) as { text_sha256_12?: string; spans?: ExtractionSpan[]; ungrounded?: ExtractionSpan[]; unparsed_fragments?: string[]; wall_ms?: number };
      if (!rec?.model || d.text_sha256_12 !== sha12 || !Array.isArray(d.spans)) return null;
      const { rows } = verifySpans(text, d.spans);
      const lang = /label language ([^;]+);/u.exec(rec.claim)?.[1] ?? null;
      const result: IngredientExtractionResult = {
        ok: true,
        errors: [],
        label_language: lang && lang !== "null" ? lang : null,
        unparsed_fragments: d.unparsed_fragments ?? [],
        spans: d.spans,
        duplicates: Number(/\((\d+) duplicate/u.exec(rec.claim)?.[1] ?? 0),
        ungrounded: d.ungrounded ?? [],
        agreement: rows,
        keyword_contains: [...new Set(keywordBaseline(text).map((h) => h.group))],
        text_sha256_12: sha12,
        text_chars: text.length,
        model: rec.model,
        wall_ms: d.wall_ms ?? 0,
      };
      hmem.store.touch(m.id);
      hmem.ledger.log(m.id, "read", hmem.actor, { details: { reuse: "verified extraction", earlier_evidence: rec.id } });
      return { result, evidenceId: rec.id, memoryId: m.id, evidenceFile: file };
    },
  };
}

/**
 * Intake registration through the gateway's registrar: the host issues a medium-risk
 * register_off contract (agent surface, bound to the GTIN and market) and POSTs it to
 * /registrar/register_off, which verifies it before any statement is sent.
 */
export function registrarPort(rt: Pick<Runtime, "ops" | "gateway">, fetchImpl: typeof fetch = fetch): RegistrarPort {
  return {
    async registerOff(gtin, market) {
      const params = { gtin, market };
      const contract = rt.ops.verifier.issue({ action: "register_off", parameters: params, user: AGENT_ACTOR, surface: "clearshelf-agent", flags: ["intake"], toolPlan: [{ tool: "registrar.register_off", input: params }] });
      const res = await fetchImpl(`${rt.gateway.baseUrl}/registrar/register_off`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gtin, market, contract }),
        signal: AbortSignal.timeout(900_000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const s = (body.summary ?? {}) as { statements?: number; activated_skus?: number; activated_tables?: string[]; skipped?: string[] };
      const summary = res.ok
        ? `${s.statements ?? "?"} statement(s) sent, ${s.skipped?.length ?? 0} skipped as already done; ${s.activated_tables?.join(", ") ?? "no table"} re-activated over ${s.activated_skus ?? "?"} SKU(s)`
        : String(body.error ?? `HTTP ${res.status}`).slice(0, 300);
      return { ok: res.ok, status: res.status, contractId: contract.contractId, summary, body };
    },
  };
}

const FACT_TEMPLATES = new Set(["product", "declared", "recalls_by_gtin"]);

/**
 * The loop's memory port on H-MEM. At the memory step it first files what the chain has
 * read as facts (so a contains-versus-free-from conflict between two sources is queued, and
 * holds the SKU, in the same run), then runs the facade's checkMemory: queued conflicts
 * become R4 contradictions and approved invariants escalations, each cited.
 */
export function agentMemoryPort(hmem: HMEM, evidence: EvidenceStore, asOf?: string | null): MemoryPort {
  const base = memoryPort(hmem, evidence, asOf);
  return {
    async recall(query, scope) {
      const own: string[] = [];
      if (scope.sources) {
        const s = scope.sources;
        const r = hmem.ingestFacts(
          { gtin: scope.gtin, evidence_ids: s.evidenceIds, product: { brand: scope.brand, labels: s.labels }, extraction: { ok: s.extractionOk, verified: s.verified } },
          evidence,
        );
        const used = s.evidenceIds.filter((id) => {
          const rec = evidence.get(id);
          return !!rec && ((rec.template_id && FACT_TEMPLATES.has(rec.template_id)) || (rec.kind === "verifier" && !!rec.details && "agreement" in rec.details));
        });
        const ev = evidence.add({
          kind: "memory",
          claim: `H-MEM filed this run's source rows as facts: ${r.added} new, ${r.reconfirmed} already known${
            r.conflicts.length ? `; ${r.conflicts.length} new allergen-polarity conflict(s) queued for the officer (${r.conflicts.map((c) => `${c.allergen}: ${c.polarityA} vs ${c.polarityB}`).join("; ")})` : ""
          }`,
          derived_from: used,
          details: { added: r.added, reconfirmed: r.reconfirmed, conflicts: r.conflicts.map((c) => ({ id: c.id, allergen: c.allergen, a: c.a, b: c.b })) },
        });
        own.push(ev.id);
      }
      const rec = await base.recall(query, scope);
      return { ...rec, evidenceIds: [...own, ...(rec.evidenceIds ?? [])] };
    },
    async context(scope) {
      const ctx = hmem.memoryContext({ gtin: scope.gtin, asOf });
      const notes = ["zetaris.recalls_by_gtin", "zetaris.recalls_by_name"].map((t) => hmem.notesForTool(t, 2).context).filter(Boolean);
      return [ctx, ...notes].filter((x) => x.trim()).join("\n").slice(0, 2400);
    },
  };
}

// ---------- the runtime ----------

export interface Runtime {
  gateway: GatewayClient;
  ollama: OllamaClient;
  ops: OpsStore;
  queue: ApprovalQueue;
  hmem: HMEM;
  world: CatalogueWorld;
  catalogue: Catalogue;
  /** null keeps evidence in memory (tests). */
  evidenceDir: string | null | undefined;
  /** null skips the loop's history and report files (tests). */
  loopDir: string | null | undefined;
  log: (line: string) => void;
  lock: AgentLock | null;
  close(): void;
}

export interface RuntimeOptions {
  gateway?: GatewayClient;
  ollama?: OllamaClient;
  ops?: OpsStore;
  queue?: ApprovalQueue;
  hmem?: HMEM;
  world?: CatalogueWorld;
  catalogue?: Catalogue;
  evidenceDir?: string | null;
  loopDir?: string | null;
  log?: (line: string) => void;
  /** Take data/agent.lock (default true; tests pass their own stores and false). */
  lock?: boolean;
  command?: string;
}

export function openRuntime(o: RuntimeOptions = {}): Runtime {
  const cfg = loadConfig();
  const lock = o.lock === false ? null : acquireLock(o.command ?? process.argv.slice(2).join(" "));
  try {
    const gateway = o.gateway ?? new GatewayClient({ baseUrl: cfg.gatewayUrl });
    const ollama = o.ollama ?? new OllamaClient({ baseUrl: cfg.ollamaUrl, model: cfg.model });
    const ops = o.ops ?? new OpsStore({ verifier: new ContractVerifier(loadContractSecret(), "agent-ops") });
    return {
      gateway,
      ollama,
      ops,
      queue: o.queue ?? new ApprovalQueue(),
      hmem: o.hmem ?? openMemory({ ollama }),
      world: o.world ?? new CatalogueWorld(),
      catalogue: o.catalogue ?? loadCatalogue(),
      evidenceDir: o.evidenceDir,
      loopDir: o.loopDir,
      log: o.log ?? ((l) => process.stderr.write(`${l}\n`)),
      lock,
      close: () => lock?.release(),
    };
  } catch (e) {
    lock?.release();
    throw e;
  }
}

// ---------- one clearance ----------

export interface InvestigateRequest {
  gtin: string;
  market: Market;
  asOf?: string;
  /** An as-of gateway for replays; default the runtime's gateway. */
  gateway?: GatewayClient;
  dq?: DqGate;
  evidence?: EvidenceStore;
  noticeMemo?: Map<string, { result: NoticeExtractionResult; evidenceId: string }>;
  extractionMemo?: Map<string, { result: IngredientExtractionResult; evidenceId: string }>;
  onEvent?: AgentEvent;
  log?: (line: string) => void;
  maxChunks?: number;
  think?: boolean;
  /**
   * Intake (a new GTIN from the officer or the command line): a missing product row may be
   * registered through the registrar first. Never in a sweep or a replay.
   */
  intake?: boolean;
  /** The registrar port for intake (default: the gateway's registrar over HTTP). */
  registrar?: RegistrarPort;
}

/** Step 1: the Markovian investigation with every port wired; returns the card and its evidence store. */
export async function investigate(rt: Runtime, req: InvestigateRequest): Promise<{ result: InvestigationResult; evidence: EvidenceStore }> {
  const evidence = req.evidence ?? new EvidenceStore(undefined, rt.evidenceDir === undefined ? undefined : rt.evidenceDir);
  const gateway = req.gateway ?? rt.gateway;
  const log = req.log ?? rt.log;
  const deps: ToolDeps = {
    gateway,
    dq: req.dq ?? new DqGate(gateway),
    ollama: rt.ollama,
    evidence,
    log,
    noticeMemo: req.noticeMemo,
    extractionMemo: req.extractionMemo,
    guard: guardPort,
    // A replay (as-of before today) hides memories about notices reported after the as-of date.
    memory: agentMemoryPort(rt.hmem, evidence, req.asOf && req.asOf < localIso().slice(0, 10) ? req.asOf : null),
    world: worldPort(rt.world),
    warm: warmPort(rt.hmem),
    // Registration is a live act: intake only, never for an as-of replay.
    ...(req.intake && !(req.asOf && req.asOf < localIso().slice(0, 10)) ? { registrar: req.registrar ?? registrarPort(rt) } : {}),
  };
  const base = { gtin: req.gtin, market: req.market, run_id: evidence.runId };
  req.onEvent?.("clear.started", { ...base, as_of: req.asOf ?? null, engine: "markovian" });
  const result = await investigateSku(
    {
      gtin: req.gtin,
      market: req.market,
      asOf: req.asOf,
      maxChunks: req.maxChunks,
      think: req.think,
      onEvent: (e) => req.onEvent?.(`loop.${e.type}`, { ...base, ...e }),
      ...(rt.loopDir !== undefined ? { historyDir: rt.loopDir, telemetryDir: rt.loopDir } : {}),
    },
    deps,
  );
  return { result, evidence };
}

export interface Applied {
  status: "HOLD" | "BLOCK";
  decision_id: string;
  contract_id: string;
  visible_in_zetaris: boolean;
  closed_loop_evidence_id: string | null;
}

/** Step 2: HOLD/BLOCK applied automatically (low-risk contract, closed-loop check); anything else queued. */
export async function applyDecision(
  rt: Runtime,
  result: ClearResult,
  evidence: EvidenceStore,
  o: { trigger?: string; replay?: { asOf: string; banner: string } | null; source?: "clear" | "sweep"; onEvent?: AgentEvent } = {},
): Promise<{ applied: Applied | null; queued: { queue_id: string; status: string } | null }> {
  const d = result.decision;
  const why = d.firings
    .filter((f) => f.effect === "HOLD" || f.effect === "BLOCK")
    .map((f) => `${f.rule} ${f.reason}`)
    .join("; ");
  if (d.status === "HOLD" || d.status === "BLOCK") {
    const reason = `${o.trigger ? `${o.trigger}. ` : ""}auto ${d.status} (policy ${d.policyVersion}): ${why || "no firing"}`.slice(0, 900);
    const a = await applyAutomatic(rt.ops, rt.gateway, { gtin: result.gtin, market: result.market, status: d.status, reason, runId: result.run_id, replay: o.replay ?? null }, rt.queue);
    if (a.superseded.length) {
      const sev = evidence.add({
        kind: "policy",
        claim: `${d.status} ${a.row.decision_id} superseded ${a.superseded.length} pending proposal(s) for this SKU (${a.superseded.join(", ")}); they can no longer be signed`,
        derived_from: [...result.evidence_ids].reverse().filter((id) => evidence.get(id)?.kind === "policy").slice(0, 1),
        details: { superseded: a.superseded, decision_id: a.row.decision_id },
      });
      result.card.push({ text: sev.claim, evidenceIds: [sev.id] });
      o.onEvent?.("approval.superseded", { gtin: result.gtin, market: result.market, queue_ids: a.superseded, decision_id: a.row.decision_id });
    }
    const vis = a.visibility.result
      ? evidence.fromTemplate(a.visibility.result, `Decision ${a.row.decision_id} (${d.status}) is ${a.visibility.visible ? "visible" : "NOT visible"} in clearance_usl.decision (closed loop)`, {
          filter: (x) => x.decision_id === a.row.decision_id,
        })
      : null;
    if (vis) result.card.push({ text: vis.claim, evidenceIds: [vis.id] });
    const applied: Applied = { status: d.status, decision_id: a.row.decision_id, contract_id: a.contract.contractId, visible_in_zetaris: a.visibility.visible, closed_loop_evidence_id: vis?.id ?? null };
    o.onEvent?.("decision.written", { gtin: result.gtin, market: result.market, run_id: result.run_id, auto: true, ...applied });
    return { applied, queued: null };
  }
  const item = rt.queue.add({
    kind: "proposal",
    gtin: result.gtin,
    market: result.market,
    status: d.status,
    statement: result.statement?.text ?? null,
    summary: `${d.status} proposed${o.trigger ? ` after ${o.trigger}` : ""}; pending the officer's signed approval`,
    reasons: d.firings.map((f) => `${f.rule} ${f.reason}`),
    evidence_ids: result.evidence_ids.slice(0, 20),
    run_id: result.run_id,
    source: o.source ?? "clear",
    replay: o.replay ? { as_of: o.replay.asOf, banner: o.replay.banner } : null,
    over_decision: overDecision(rt.ops, result.gtin, result.market),
  });
  o.onEvent?.("approval.queued", { gtin: result.gtin, market: result.market, run_id: result.run_id, status: d.status, queue_id: item.id });
  return { applied: null, queued: { queue_id: item.id, status: d.status } };
}

let marketCodes: Set<string> | null = null;
function knownMarketCodes(): Set<string> {
  if (!marketCodes) {
    const doc = JSON.parse(readFileSync(new URL("data/reference/market_allergens.json", REPO_ROOT_URL), "utf8")) as { data: { market_code: string }[] };
    marketCodes = new Set(doc.data.map((r) => r.market_code));
  }
  return marketCodes;
}

/** The statutory code a verified group is filed under; null when the market lists no such allergen. */
export function marketCodeFor(market: Market, group: string): string | null {
  const g = market === "UK" && group === "wheat" ? "gluten_cereal" : group;
  const code = `${market}:${g}`;
  return knownMarketCodes().has(code) ? code : null;
}

export interface Recorded {
  memory: { facts_added: number; facts_reconfirmed: number; conflicts_queued: string[]; decision_memory_id: string; extraction_memory_id: string | null; evidence_id: string };
  world: { decision_id: string; snapshot_id: string; event_seq: number; events_appended: number; evidence_id: string } | null;
  extractions: { rows: number; evidence_id: string } | null;
  gaps: string[];
}

/**
 * Step 3: H-MEM, the World Model and the extraction write-back. Each write gets an evidence
 * record on the card. A failure in one store is a gap, never a lost decision.
 */
export async function recordOutcome(
  rt: Runtime,
  result: ClearResult,
  evidence: EvidenceStore,
  o: { decisionId: string; status?: string; contractId?: string; onEvent?: AgentEvent; state?: DecisionState; replayAsOf?: string | null },
): Promise<Recorded> {
  const gaps: string[] = [];
  const policyEv = [...result.evidence_ids].reverse().find((id) => evidence.get(id)?.kind === "policy") ?? null;
  const add = (rec: EvidenceRecord) => {
    result.card.push({ text: rec.claim, evidenceIds: [rec.id] });
    result.evidence_ids.push(rec.id);
    result.quality.claims = result.card.length;
    result.quality.records += 1;
    result.quality.e_complete = (result.quality.records - Object.keys(result.quality.incomplete_records).length) / result.quality.records;
  };

  const h = rt.hmem.ingestClearResult(result, evidence, { state: o.state, replayAsOf: o.replayAsOf ?? null });
  const mev = evidence.add({
    kind: "memory",
    claim: `H-MEM recorded the run: ${h.added} new fact(s), ${h.reconfirmed} reconfirmed, ${h.conflicts.length} new allergen conflict(s); decision logged as ${h.decision.memoryId} (${h.decision.state ?? "applied"}${h.decision.replayAsOf ? `, replay as of ${h.decision.replayAsOf}` : ""})${h.extraction ? `; verified extraction remembered as ${h.extraction.id} (keyed by the label text's sha256)` : ""}`,
    derived_from: policyEv ? [policyEv] : [],
    details: { decision_memory: h.decision.memoryId, extraction_memory: h.extraction?.id ?? null, conflicts: h.conflicts.map((c) => c.id) },
  });
  add(mev);
  o.onEvent?.("memory.recorded", { gtin: result.gtin, market: result.market, run_id: result.run_id, decision_memory: h.decision.memoryId, facts_added: h.added, conflicts: h.conflicts.map((c) => c.id) });

  let world: Recorded["world"] = null;
  try {
    const before = rt.world.eventCount();
    const w = await rt.world.ingestClearResult(result, evidence, { decisionId: o.decisionId, status: o.status, contractId: o.contractId });
    const appended = rt.world.eventCount() - before;
    const wev = evidence.add({
      kind: "world_model",
      claim: `World Model: ${appended} event(s) appended; decision ${o.decisionId} (${o.status ?? result.decision.status}) recorded with snapshot ${w.snapshot.id} at event ${w.snapshot.eventSeq}`,
      derived_from: policyEv ? [policyEv] : [],
      details: { product_entity: w.productId, snapshot: w.snapshot.id, event_seq: w.snapshot.eventSeq, state_sha256: w.snapshot.stateSha256 },
    });
    add(wev);
    world = { decision_id: o.decisionId, snapshot_id: w.snapshot.id, event_seq: w.snapshot.eventSeq, events_appended: appended, evidence_id: wev.id };
    o.onEvent?.("world.recorded", { gtin: result.gtin, market: result.market, run_id: result.run_id, ...world });
  } catch (e) {
    gaps.push(`World Model record failed: ${(e as Error).message.slice(0, 200)}`);
  }

  let extractions: Recorded["extractions"] = null;
  if (result.extraction.ok) {
    try {
      const mine: ExtractionRow[] = [];
      const seen = new Set<string>();
      for (const v of result.extraction.verified) {
        const code = marketCodeFor(result.market, v.group);
        if (!code) continue;
        const key = `${result.gtin}|${code}|${v.relation}|${v.evidence_text.slice(0, 60)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        mine.push({ extracted_key: key.slice(0, 160), gtin: result.gtin, market_code: code, relation: v.relation, evidence_text: v.evidence_text.slice(0, 400), verifier: "agree", run_id: result.run_id.slice(0, 40) });
      }
      const others = rt.ops.rows("extractions").filter((r) => r.gtin === result.gtin && !String(r.market_code).startsWith(`${result.market}:`)) as ExtractionRow[];
      const w = await rt.ops.replaceExtractions(result.gtin, [...others, ...mine]);
      const xev = evidence.add({
        kind: "policy",
        claim: `Wrote ${mine.length} verified extraction row(s) for ${result.market} to the ops store (clearance_usl.extracted_allergen in Zetaris): ${[...new Set(mine.map((r) => `${r.market_code} ${r.relation}`))].join(", ") || "none"}`,
        derived_from: result.evidence_ids.filter((id) => evidence.get(id)?.kind === "verifier").slice(0, 2),
        details: { rows: mine.length, other_market_rows_kept: others.length, file_sha256: w.file_sha256 },
      });
      add(xev);
      extractions = { rows: mine.length, evidence_id: xev.id };
    } catch (e) {
      gaps.push(`extraction write-back failed: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  result.gaps.push(...gaps);
  return {
    memory: {
      facts_added: h.added,
      facts_reconfirmed: h.reconfirmed,
      conflicts_queued: h.conflicts.map((c) => c.id),
      decision_memory_id: h.decision.memoryId,
      extraction_memory_id: h.extraction?.id ?? null,
      evidence_id: mev.id,
    },
    world,
    extractions,
    gaps,
  };
}

export interface ClearRequest extends InvestigateRequest {
  /** Write the decision through the ops store (HOLD/BLOCK) or queue it (CLEAR...). Default true. */
  apply?: boolean;
  trigger?: string;
  replay?: { asOf: string; banner: string } | null;
}

export interface ClearOutcome {
  result: InvestigationResult;
  evidence: EvidenceStore;
  applied: Applied | null;
  queued: { queue_id: string; status: string } | null;
  /** null when apply is false: a dry run writes no decision memory, World Model decision or extraction rows. */
  recorded: Recorded | null;
}

/** The World Model's status text: applied, proposed or not applied, with the replay label. */
export function worldStatus(status: string, state: DecisionState, replayAsOf: string | null): string {
  const s = state === "applied" ? status : state === "proposed" ? `${status} (proposed, pending signature)` : `${status} (not applied)`;
  return replayAsOf ? `${s} [replay as of ${replayAsOf}]` : s;
}

/**
 * An as-of date before today makes the clearance a replay, whoever calls it: the as-of
 * gateway, replay-labelled evidence and an rp- decision row with the banner. Callers that
 * already set `replay` (the server, the CLI) are left as they are.
 */
export function asReplay(rt: Runtime, req: ClearRequest): ClearRequest {
  if (!req.asOf || req.replay || req.asOf >= localIso().slice(0, 10)) return req;
  const banner = replayBanner(req.asOf);
  return {
    ...req,
    replay: { asOf: req.asOf, banner },
    gateway: req.gateway ?? new AsOfGateway(rt.gateway, req.asOf, banner),
    evidence: req.evidence ?? new ReplayEvidenceStore({ as_of: req.asOf, banner }, undefined, rt.evidenceDir === undefined ? undefined : rt.evidenceDir),
  };
}

/** Investigate, apply (or queue), record: the clearance the CLI, the server and the watch share. */
export async function clearWithAgent(rt: Runtime, request: ClearRequest): Promise<ClearOutcome> {
  const req = asReplay(rt, request);
  const { result, evidence } = await investigate(rt, req);
  let applied: Applied | null = null;
  let queued: ClearOutcome["queued"] = null;
  let recorded: Recorded | null = null;
  if (req.apply !== false) {
    ({ applied, queued } = await applyDecision(rt, result, evidence, { trigger: req.trigger, replay: req.replay, onEvent: req.onEvent }));
    const decisionId = applied?.decision_id ?? (queued ? `proposal:${queued.queue_id}` : `run:${result.run_id}:${result.market}`);
    const state: DecisionState = applied ? "applied" : queued ? "proposed" : "not_applied";
    const replayAsOf = req.replay?.asOf ?? null;
    const status = worldStatus(applied ? applied.status : (queued?.status ?? result.decision.status), state, replayAsOf);
    recorded = await recordOutcome(rt, result, evidence, { decisionId, status, contractId: applied?.contract_id, onEvent: req.onEvent, state, replayAsOf });
  } else {
    result.gaps.push("dry run (apply false): no decision row, queue item, decision memory, World Model decision or extraction rows were written");
  }
  req.onEvent?.("clear.done", {
    gtin: result.gtin,
    market: result.market,
    run_id: result.run_id,
    status: result.decision.status,
    rules: [...new Set(result.decision.firings.map((f) => f.rule))],
    applied: !!applied,
    decision_id: applied?.decision_id ?? null,
    queue_id: queued?.queue_id ?? null,
    chunks: result.loop.chunks,
  });
  return { result, evidence, applied, queued, recorded };
}

/** An executed officer decision (CLEAR, RELEASE, manual HOLD/BLOCK) into the World Model and the H-MEM decision log. */
export async function recordExecuted(rt: Runtime, row: DecisionRow): Promise<{ snapshot_id: string; decision_memory_id: string }> {
  const snap = await rt.world.recordDecision({
    decisionId: row.decision_id,
    gtin: row.gtin,
    market: row.market as Market,
    status: row.status,
    rules: [],
    decidedAt: row.decided_at,
    actor: row.actor,
    contractId: row.contract_id,
    statement: row.statement || null,
  });
  const d = rt.hmem.recordDecision({ gtin: row.gtin, market: row.market as Market, status: row.status, firings: [], decidedAt: row.decided_at, actor: row.actor, runId: null, evidenceId: null, state: "applied" });
  return { snapshot_id: snap.id, decision_memory_id: d.memoryId };
}

/** "Why was this held?": the H-MEM trace (decision log merged with ledger history) plus the current ops row and the World Model timeline. */
export async function whyTrace(rt: Runtime, gtin: string, market: Market): Promise<{ lines: string[]; hmem: WhyTrace; current: DecisionRow | null; zetaris: Record<string, unknown>[] | null }> {
  const t = rt.hmem.why(gtin, market);
  const current = rt.ops.current().get(`${gtin}|${market}`) ?? null;
  let zetaris: Record<string, unknown>[] | null = null;
  try {
    zetaris = rowsAsObjects(await rt.gateway.template("prior_decisions", { gtin })).filter((r) => r.market === market);
  } catch {
    zetaris = null;
  }
  const lines = [...t.lines];
  // Decision-log entries from before the state was recorded: a run that only queued a proposal was never applied.
  const d = t.decision;
  if (d && d.state === undefined && d.runId) {
    const q = rt.queue.all().find((i) => i.kind === "proposal" && i.run_id === d.runId && i.gtin === gtin && i.market === market);
    const head = `${d.status} for ${gtin} in ${market}`;
    if (q && lines[0]?.startsWith(head)) lines[0] = lines[0].replace(head, `${d.status} (PROPOSED as ${q.id}, ${q.state}; not applied; state read from the approval queue) for ${gtin} in ${market}`);
  }
  const pending = rt.queue.proposalFor(gtin, market);
  if (pending) {
    lines.push(
      `Approval queue: ${pending.status} proposal ${pending.id} since ${pending.created_at}, pending the officer's signed approval${pending.replay ? ` [${pending.replay.banner}]` : ""}; not applied, so clearance_usl.decision has no row for it.`,
    );
  }
  if (current) {
    const replayRow = current.decision_id.startsWith("rp-") ? ` [REPLAY row, as of ${current.decided_date}]` : "";
    lines.push(`Ops store (federated as clearance_usl.decision): ${current.status}${replayRow} ${current.decision_id} by ${current.actor} at ${current.decided_at}, contract ${current.contract_id}.`);
  }
  if (zetaris) lines.push(`Zetaris prior_decisions: ${zetaris.length} row(s) for ${market}${zetaris[0] ? `, latest ${String(zetaris[0].status)} on ${String(zetaris[0].decided_date)}` : ""}.`);
  const snaps = rt.world.snapshotsFor(gtin).filter((s) => s.market === market);
  if (snaps.length) {
    const s = snaps[snaps.length - 1]!;
    lines.push(`World Model: ${snaps.length} snapshot(s); latest ${s.id} at ${s.at} (${s.reason}), ${s.edges.length} edge(s), ${s.notices.length} notice(s).`);
  }
  return { lines, hmem: t, current, zetaris };
}

// ---------- the recall watch on the same runtime ----------

/** The watch's `clear` step as a Markovian investigation with every port wired. */
export function watchClear(rt: Runtime, onEvent?: AgentEvent): typeof clearSku {
  return async (gtin, market, deps, asOf) => {
    const { result } = await investigate(rt, { gtin, market, asOf, gateway: deps.gateway, dq: deps.dq, evidence: deps.evidence, noticeMemo: deps.noticeMemo, log: deps.log, onEvent });
    return result;
  };
}

function metaOf(rec: EvidenceRecord | undefined): SourceMeta {
  return {
    object: (rec?.zetaris_object ?? "").replace(/^lightning\.metastore\.clearshelf\./u, ""),
    sqlSha256: rec?.sql_sha256 ?? "",
    url: rec?.source_url,
    evidenceId: rec?.id,
  };
}

/** H-MEM per notice, the World Model for new FSA alerts, decision recording after each action, dreaming after the sweep. */
export function watchHooks(rt: Runtime, onEvent?: AgentEvent): WatchHooks {
  return {
    noticeMemory(n, ev) {
      const brandKeys = [...new Set(n.brands.map((b) => brandKey(b)).filter((b): b is string => !!b))];
      // In a replay, only what was known by the sweep's as-of date.
      const asOf = ev instanceof ReplayEvidenceStore ? (ev.replay?.as_of ?? null) : null;
      const decisions = n.gtins.flatMap((g) => rt.hmem.decisionLog(g)).filter((d) => !asOf || (d.replayAsOf ?? d.decidedAt.slice(0, 10)) <= asOf);
      const known = (id: string) => knownAsOf(rt.hmem.store.get(id), asOf);
      const conflicts = [...new Map(n.gtins.flatMap((g) => rt.hmem.allergenConflicts.queuedFor(g, brandKeys)).filter((c) => known(c.a) && known(c.b)).map((c) => [c.id, c])).values()];
      const invariants = [...new Map(n.gtins.flatMap((g) => rt.hmem.escalationsFor({ gtin: g, brand: n.brands.join(",") }).invariants).map((p) => [p.id, p])).values()];
      const rec = ev.add({
        kind: "memory",
        claim: `H-MEM for ${n.source.toUpperCase()} ${n.notice_id}: ${decisions.length} earlier decision(s) on the ${n.gtins.length} catalogue GTIN(s) it concerns, ${conflicts.length} queued allergen conflict(s), ${invariants.length} approved invariant(s) apply`,
        derived_from: [],
        details: {
          gtins: n.gtins,
          brands: brandKeys,
          decisions: decisions.slice(-6).map((d) => ({ memory: d.memoryId, gtin: d.gtin, market: d.market, status: d.status, rules: d.rules, at: d.decidedAt })),
          conflicts: conflicts.map((c) => c.id),
          invariants: invariants.map((p) => p.id),
        },
      });
      return { evidenceId: rec.id, summary: rec.claim };
    },
    async fsaSeen(alerts, ev) {
      const bundles: FsaBundle[] = alerts.map((a) => ({
        alert: {
          notation: String(a.row.notation),
          created: a.row.created === null || a.row.created === undefined ? null : String(a.row.created),
          title: a.row.title === null || a.row.title === undefined ? null : String(a.row.title),
          business: a.row.business === null || a.row.business === undefined ? null : String(a.row.business),
          alert_url: a.row.alert_url === null || a.row.alert_url === undefined ? null : String(a.row.alert_url),
        },
        allergens: a.allergens,
        src: { alert: metaOf(a.recentEvidenceId ? ev.get(a.recentEvidenceId) : undefined), ...(a.allergensEvidenceId ? { allergens: metaOf(ev.get(a.allergensEvidenceId)) } : {}) },
      }));
      const delta = await rt.world.ingest({ products: [], fsa: bundles });
      const rec = ev.add({
        kind: "world_model",
        claim: `World Model: ${bundles.length} new FSA alert(s) ingested, ${delta.appended} event(s) appended, ${delta.nameMatches.length} name-match link(s) to catalogue products, ${delta.mergeQueuePending} merge proposal(s) pending`,
        derived_from: [...new Set(alerts.flatMap((a) => [a.recentEvidenceId, a.allergensEvidenceId]).filter((x): x is string => !!x))],
        details: { appended: delta.appended, writes: delta.writes, name_matches: delta.nameMatches.slice(0, 20) },
      });
      onEvent?.("world.fsa_ingested", { alerts: bundles.length, appended: delta.appended, evidence_id: rec.id });
      return { evidenceId: rec.id, summary: rec.claim };
    },
    async actionTaken(a, r, ev) {
      const state: DecisionState = a.applied ? "applied" : a.queue_id ? "proposed" : "not_applied";
      const replayAsOf = ev instanceof ReplayEvidenceStore ? (ev.replay?.as_of ?? null) : null;
      const rec = await recordOutcome(rt, r, ev, {
        decisionId: a.decision_id ?? (a.queue_id ? `proposal:${a.queue_id}` : `run:${r.run_id}:${a.market}`),
        status: worldStatus(a.status, state, replayAsOf),
        contractId: a.contract_id ?? undefined,
        onEvent,
        state,
        replayAsOf,
      });
      a.evidence_ids.push(rec.memory.evidence_id, ...(rec.world ? [rec.world.evidence_id] : []));
    },
    async sweepDone(res) {
      const d = await rt.hmem.dream(makeWordingFn(rt.ollama, rt.hmem.modelCalls));
      onEvent?.("memory.dreamed", { sweep_id: res.sweep_id, queued: d.queued.map((q) => q.id), reference_proposals: d.referenceProposals, skipped: d.skipped.length });
    },
  };
}

/** The recall watch on this runtime: Markovian clearances, H-MEM and the World Model wired. */
export function agentWatch(rt: Runtime, o: { emit?: AgentEvent; useModel?: boolean; log?: (l: string) => void; deps?: Pick<WatchDeps, "stateStore" | "sweepDir" | "evidenceDir" | "today"> } = {}): RecallWatch {
  return new RecallWatch({
    ...o.deps,
    gateway: rt.gateway,
    ollama: rt.ollama,
    ops: rt.ops,
    queue: rt.queue,
    catalogue: rt.catalogue,
    emit: o.emit,
    log: o.log ?? rt.log,
    useModel: o.useModel ?? true,
    clear: watchClear(rt, o.emit),
    hooks: watchHooks(rt, o.emit),
  });
}
