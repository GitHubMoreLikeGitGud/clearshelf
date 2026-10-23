// The recall watch: finds notices that are new since the last sweep, through Zetaris only,
// and acts on the catalogue SKUs they concern. One sweep, per new notice: parse it
// (deterministic GS1 scan, plus Nemotron notice extraction unless the guard flagged the
// text), check exact GTIN matches (recall_product_link, the scan, the model), check
// name-only candidates (catalogue brand tokens, confirmed by recalls_by_name in Zetaris),
// and propose actions: every catalogue SKU matched by exact GTIN is re-cleared by the
// deterministic pipeline, a HOLD or BLOCK is applied automatically (low-risk contract,
// written to the ops store, then proven visible in a Zetaris query), anything else waits
// for the officer. Name-only matches only ever join the review queue. The sweep ends
// with the closed-loop recheck (cleared decisions joined to newer recalls, inside Zetaris).
//
// As-of replay (SPEC 8.2): startReplay(asOf) stands the engine at a past date and runs a
// baseline; poll() then moves the date forward, so notices dated after it "arrive". Every
// sweep result, event, evidence record and decision row written in replay carries the
// replay banner ("Replay as of 10 Oct 2026"); a replay is never presented as live.
//
// This file is the deterministic sweep; the Markovian recall-sweep chain can call the same
// steps as tools.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { REPO_ROOT_URL } from "../config.ts";
import { localIso, type EvidenceRecord, type EvidenceStore } from "../evidence/store.ts";
import { extractNotice, noticeScanOnly, noticeText, type NoticeExtractionResult, type NoticeRow } from "../extract/notice.ts";
import type { OllamaClient } from "../llm/ollama.ts";
import { SWEEP_CHECKLIST } from "../llm/schemas.ts";
import { bestNameSimilarity, clearSku, type ClearResult, type PipelineDeps } from "../pipeline.ts";
import type { Decision, Market } from "../policy/decide.ts";
import { extractUpcs } from "../verify/gtin.ts";
import { brandToken, DqGate, GatewayClient, rowsAsObjects, type TemplateResult } from "../zetaris/client.ts";
import { scanFields, type GuardReport } from "../contract/guard.ts";
import { applyAutomatic, overDecision } from "../ops/actions.ts";
import type { ApprovalQueue } from "../ops/queue.ts";
import type { LinkRow, OpsStore } from "../ops/store.ts";
import { AsOfGateway, replayBanner, replayLabel, ReplayEvidenceStore, type AsOfResult } from "./asOf.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function today(): string {
  return localIso().slice(0, 10);
}

// ---------- catalogue ----------

export interface CatalogueSku {
  gtin: string;
  markets: Market[];
  name: string;
  brand: string;
  brand_token: string | null;
  scenarios: string[];
}

export interface Catalogue {
  skus: CatalogueSku[];
  /** manifest.scenario_picks.AS_OF_REPLAY */
  replayPicks: string[];
  source: string;
}

/**
 * The live catalogue: the intake manifest's demo SKUs (the same set the gateway onboards
 * and warms; eval-only SKUs never enter it). Names and brands come from the manifest's
 * curation snapshot and are used only to find name-only candidates, which Zetaris then confirms.
 */
export function loadCatalogue(path = fileURLToPath(new URL("data/manifest/skus.json", REPO_ROOT_URL))): Catalogue {
  const doc = JSON.parse(readFileSync(path, "utf8")) as {
    skus: { gtin: string; role: string; markets: string[]; display_name?: string; brand?: string; scenarios?: string[] }[];
    scenario_picks?: Record<string, string[]>;
  };
  const skus = doc.skus
    .filter((s) => s.role === "demo")
    .map((s) => ({
      gtin: s.gtin,
      markets: s.markets.filter((m): m is Market => m === "UK" || m === "US"),
      name: s.display_name ?? "",
      brand: s.brand ?? "",
      brand_token: brandToken(s.brand ?? ""),
      scenarios: s.scenarios ?? [],
    }));
  return { skus, replayPicks: doc.scenario_picks?.AS_OF_REPLAY ?? [], source: "data/manifest/skus.json (intake manifest, demo role)" };
}

function norm(text: string | null | undefined): string {
  return ` ${(text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()} `;
}

/** Catalogue SKUs whose brand token appears as whole words in the text. */
export function brandCandidates(catalogue: CatalogueSku[], ...texts: (string | null | undefined)[]): CatalogueSku[] {
  const hay = norm(texts.join(" "));
  return catalogue.filter((s) => s.brand_token && hay.includes(` ${s.brand_token} `));
}

// ---------- state ----------

export interface WatchState {
  mode: "live" | "replay";
  replay: { origin: string; banner: string } | null;
  /** The date the decision engine stands at. */
  as_of: string;
  /** Notices dated on or before the watermark are known. */
  fda_watermark: string;
  fsa_watermark: string;
  seen: { fda: string[]; fsa: string[] };
  started_at: string;
  updated_at: string;
  polls: number;
  last_sweep_id: string | null;
}

export class WatchStateStore {
  readonly path: string;
  constructor(dir: string = fileURLToPath(new URL("data/watch/", REPO_ROOT_URL))) {
    mkdirSync(dir, { recursive: true });
    this.path = `${dir.replace(/[\\/]$/u, "")}/state.json`;
  }
  load(): WatchState | null {
    if (!existsSync(this.path)) return null;
    return JSON.parse(readFileSync(this.path, "utf8")) as WatchState;
  }
  save(s: WatchState): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s, null, 1)}\n`, "utf8");
    renameSync(tmp, this.path);
  }
}

// ---------- results ----------

export interface NoticeSweep {
  source: "fda" | "fsa";
  notice_id: string;
  date: string;
  title: string;
  firm: string | null;
  classification: string | null;
  status: string | null;
  guard: { hit: boolean; summary: string };
  parsed_by: ("gs1_scan" | "nemotron" | "fsa_alert_allergen")[];
  allergens: string[];
  exact_gtins: string[];
  name_candidates: string[];
  checklist: Record<string, boolean>;
  evidence_ids: string[];
  note?: string;
}

export interface ExactMatch {
  notice_id: string;
  gtin: string;
  by: ("recall_product_link" | "gs1_scan" | "nemotron")[];
  link_written: boolean;
  evidence_ids: string[];
}

export interface NameMatch {
  notice_id: string;
  source: "fda" | "fsa";
  gtin: string;
  market: Market;
  brand_token: string;
  similarity: number;
  confirmed_in_zetaris: boolean;
  queue_id: string | null;
  evidence_ids: string[];
}

export interface SweepAction {
  gtin: string;
  market: Market;
  trigger: string;
  status: Decision;
  rules: string[];
  applied: boolean;
  decision_id: string | null;
  contract_id: string | null;
  visible_in_zetaris: boolean | null;
  queue_id: string | null;
  run_id: string;
  reason: string;
  evidence_ids: string[];
}

export interface SweepResult {
  sweep_id: string;
  kind: "baseline" | "poll";
  mode: "live" | "replay";
  replay: { origin: string; banner: string } | null;
  banner: string | null;
  window: { after: string; up_to: string };
  started_at: string;
  finished_at: string;
  wall_ms: number;
  notices: NoticeSweep[];
  exact_matches: ExactMatch[];
  name_matches: NameMatch[];
  actions: SweepAction[];
  recheck: { rows: Record<string, unknown>[]; evidence_id: string | null };
  checklist: Record<string, boolean>;
  gaps: string[];
  model: { calls: number; tokens_in: number; tokens_out: number; label: "measured" };
  evidence_file: string | null;
  evidence_ids: string[];
}

export type WatchEvent = (type: string, data: Record<string, unknown>) => void;

/**
 * Integration hooks (H-MEM and the World Model, wired in runtime.ts). Each is optional; a
 * hook that is not wired leaves its checklist item false with a gap, and a hook that fails
 * becomes a gap, never a lost sweep.
 */
export interface WatchHooks {
  /** H-MEM for one notice: earlier decisions, queued allergen conflicts and approved invariants on what it concerns. */
  noticeMemory?(n: { source: "fda" | "fsa"; notice_id: string; gtins: string[]; brands: string[] }, ev: EvidenceStore): { evidenceId: string; summary: string };
  /** The World Model gets the sweep's new FSA alerts (name-match edges to catalogue products). */
  fsaSeen?(alerts: { row: Record<string, unknown>; allergens: string[] | null; recentEvidenceId: string | null; allergensEvidenceId: string | null }[], ev: EvidenceStore): Promise<{ evidenceId: string; summary: string } | null>;
  /** After an action is applied or queued: H-MEM and World Model record the decision. */
  actionTaken?(a: SweepAction, r: ClearResult, ev: EvidenceStore): Promise<void>;
  /** After the sweep (dreaming over officer rulings). */
  sweepDone?(res: SweepResult): Promise<void>;
}

export interface WatchDeps {
  gateway: GatewayClient;
  ollama: OllamaClient;
  ops: OpsStore;
  queue: ApprovalQueue;
  catalogue?: Catalogue;
  stateStore?: WatchStateStore;
  /** Where sweep records go; null keeps them in memory (tests). */
  sweepDir?: string | null;
  /** Where evidence goes; null keeps it in memory (tests). */
  evidenceDir?: string | null;
  emit?: WatchEvent;
  log?: (line: string) => void;
  today?: () => string;
  /** Injected in tests; defaults to the clearance pipeline. */
  clear?: typeof clearSku;
  /** Parse notices with Nemotron as well as the GS1 scan (default true). */
  useModel?: boolean;
  /** HTTP client for the registrar call (live polls only); defaults to fetch. */
  fetchImpl?: typeof fetch;
  hooks?: WatchHooks;
}

function newSweepId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `w${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${randomBytes(2).toString("hex")}`;
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function compactReason(r: ClearResult): string {
  const parts = r.decision.firings.filter((f) => f.effect === "HOLD" || f.effect === "BLOCK").map((f) => `${f.rule} ${f.reason}`);
  return `auto ${r.decision.status} (policy ${r.decision.policyVersion}): ${parts.join("; ") || "no firing"}`.slice(0, 900);
}

export class RecallWatch {
  private readonly d: Required<Omit<WatchDeps, "catalogue" | "sweepDir" | "evidenceDir" | "hooks">> & { catalogue: Catalogue; sweepDir: string | null; evidenceDir: string | null | undefined; hooks: WatchHooks };
  private running: Promise<SweepResult> | null = null;
  private readonly noticeMemo = new Map<string, { result: NoticeExtractionResult; evidenceId: string }>();
  readonly sweeps = new Map<string, SweepResult>();

  constructor(deps: WatchDeps) {
    this.d = {
      gateway: deps.gateway,
      ollama: deps.ollama,
      ops: deps.ops,
      queue: deps.queue,
      catalogue: deps.catalogue ?? loadCatalogue(),
      stateStore: deps.stateStore ?? new WatchStateStore(),
      sweepDir: deps.sweepDir === undefined ? fileURLToPath(new URL("data/watch/sweeps/", REPO_ROOT_URL)) : deps.sweepDir,
      evidenceDir: deps.evidenceDir,
      emit: deps.emit ?? (() => {}),
      log: deps.log ?? (() => {}),
      today: deps.today ?? today,
      clear: deps.clear ?? clearSku,
      useModel: deps.useModel ?? true,
      fetchImpl: deps.fetchImpl ?? fetch,
      hooks: deps.hooks ?? {},
    };
  }

  get busy(): boolean {
    return this.running !== null;
  }

  state(): WatchState | null {
    return this.d.stateStore.load();
  }

  /** The replay label for the current as-of date ("Replay as of …", or "Replay from …, polled to …"). */
  banner(): string | null {
    const st = this.state();
    return st?.replay ? replayLabel(st.replay.origin, st.as_of) : null;
  }

  private exclusive(fn: () => Promise<SweepResult>): Promise<SweepResult> {
    if (this.running) throw new Error("a sweep is already running");
    const p = fn().finally(() => {
      this.running = null;
    });
    this.running = p;
    return p;
  }

  /** Live mode from now on: notices dated after `since` (default today) are new. */
  goLive(since?: string): WatchState {
    const t = this.d.today();
    const s = since ?? t;
    if (!DATE.test(s) || s > t) throw new Error(`since must be a date on or before ${t}`);
    const now = new Date().toISOString();
    const st: WatchState = { mode: "live", replay: null, as_of: t, fda_watermark: s, fsa_watermark: s, seen: { fda: [], fsa: [] }, started_at: now, updated_at: now, polls: 0, last_sweep_id: null };
    this.d.stateStore.save(st);
    this.d.emit("watch.state", { state: st });
    return st;
  }

  /**
   * Stands the engine at `asOf` (replay mode) and runs the baseline: the scope SKUs are
   * cleared as of that date, and HOLD/BLOCK results are applied with replay-labelled rows.
   * Scope: the manifest's AS_OF_REPLAY pick (default), every catalogue SKU, or given GTINs.
   */
  startReplay(asOf: string, opts: { scope?: "scenario" | "all" | "none"; gtins?: string[] } = {}): Promise<SweepResult> {
    return this.exclusive(async () => {
      const t = this.d.today();
      if (!DATE.test(asOf) || asOf > t) throw new Error(`as-of must be a date on or before ${t}`);
      const banner = replayBanner(asOf);
      const now = new Date().toISOString();
      const st: WatchState = {
        mode: "replay",
        replay: { origin: asOf, banner },
        as_of: asOf,
        fda_watermark: asOf,
        fsa_watermark: asOf,
        seen: { fda: [], fsa: [] },
        started_at: now,
        updated_at: now,
        polls: 0,
        last_sweep_id: null,
      };
      this.d.stateStore.save(st);
      this.d.emit("watch.state", { state: st, banner });
      const scope = opts.gtins?.length ? opts.gtins : opts.scope === "all" ? this.d.catalogue.skus.map((s) => s.gtin) : opts.scope === "none" ? [] : this.d.catalogue.replayPicks;
      const res = await this.sweep("baseline", st, asOf, asOf, scope);
      st.last_sweep_id = res.sweep_id;
      st.updated_at = new Date().toISOString();
      this.d.stateStore.save(st);
      return res;
    });
  }

  /** One sweep from the current as-of to `until` (replay: default today; live: always today). */
  poll(opts: { until?: string } = {}): Promise<SweepResult> {
    return this.exclusive(async () => {
      const st = this.state() ?? this.goLive();
      const t = this.d.today();
      const upTo = st.mode === "replay" ? (opts.until ?? t) : t;
      if (!DATE.test(upTo) || upTo > t) throw new Error(`until must be a date on or before ${t}`);
      if (upTo < st.as_of) throw new Error(`until ${upTo} is before the current as-of ${st.as_of}`);
      const refresh = st.mode === "live" ? await this.refreshFeeds() : null;
      const res = await this.sweep("poll", st, st.as_of, upTo, []);
      if (refresh) res.gaps.unshift(refresh);
      const seenFda = new Set(st.seen.fda);
      const seenFsa = new Set(st.seen.fsa);
      for (const n of res.notices) (n.source === "fda" ? seenFda : seenFsa).add(n.notice_id);
      Object.assign(st, {
        as_of: upTo,
        fda_watermark: upTo,
        fsa_watermark: upTo,
        seen: { fda: [...seenFda], fsa: [...seenFsa] },
        polls: st.polls + 1,
        last_sweep_id: res.sweep_id,
        updated_at: new Date().toISOString(),
      });
      this.d.stateStore.save(st);
      this.d.emit("watch.state", { state: st, banner: st.replay ? replayLabel(st.replay.origin, st.as_of) : null });
      return res;
    });
  }

  /**
   * Live polls ask the gateway's registrar to re-read the openFDA and FSA feeds (UNCACHE,
   * then CACHE TABLE) under a medium-risk contract, so a poll sees notices published since
   * the last cache. Returns a note for the sweep when the feeds were not refreshed.
   */
  private async refreshFeeds(): Promise<string | null> {
    const contract = this.d.ops.verifier.issue({ action: "refresh_feeds", parameters: {}, user: "clearshelf-agent", surface: "clearshelf-agent", toolPlan: [{ tool: "registrar.refresh_feeds", input: {} }] });
    try {
      const r = await this.d.fetchImpl(`${this.d.gateway.baseUrl}/registrar/refresh_feeds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contract }),
        signal: AbortSignal.timeout(180_000),
      });
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      this.d.emit("watch.feeds_refresh", { status: r.status, contract_id: contract.contractId, result: body });
      if (r.ok) return null;
      return `feeds not refreshed (registrar HTTP ${r.status}${body.error ? `: ${String(body.error).slice(0, 160)}` : ""}); this poll reads the FDA and FSA feeds as last cached by the gateway`;
    } catch (e) {
      return `feeds not refreshed (${(e as Error).message.slice(0, 160)}); this poll reads the FDA and FSA feeds as last cached by the gateway`;
    }
  }

  // ---------- one sweep ----------

  private async sweep(kind: "baseline" | "poll", st: WatchState, after: string, upTo: string, scope: string[]): Promise<SweepResult> {
    const t0 = performance.now();
    const sweepId = newSweepId();
    // One label for the whole sweep: its rows, evidence, memories and World Model status.
    const banner = st.replay ? replayLabel(st.replay.origin, upTo) : null;
    const replay = st.replay ? { as_of: upTo, banner: banner! } : null;
    const gw = new AsOfGateway(this.d.gateway, st.mode === "replay" ? upTo : null, banner);
    const ev = new ReplayEvidenceStore(replay, sweepId, this.d.evidenceDir);
    const res: SweepResult = {
      sweep_id: sweepId,
      kind,
      mode: st.mode,
      replay: st.replay,
      banner,
      window: { after, up_to: upTo },
      started_at: new Date().toISOString(),
      finished_at: "",
      wall_ms: 0,
      notices: [],
      exact_matches: [],
      name_matches: [],
      actions: [],
      recheck: { rows: [], evidence_id: null },
      checklist: Object.fromEntries(SWEEP_CHECKLIST.map((k) => [k, false])),
      gaps: [],
      model: { calls: 0, tokens_in: 0, tokens_out: 0, label: "measured" },
      evidence_file: ev.path,
      evidence_ids: [],
    };
    const emit = (type: string, data: Record<string, unknown>) => this.d.emit(type, { sweep_id: sweepId, banner, ...data });
    emit("watch.sweep_started", { kind, window: res.window, mode: st.mode });
    this.d.log(`sweep ${sweepId} ${kind} ${st.mode}${banner ? ` [${banner}]` : ""}: after ${after} up to ${upTo}`);

    const toAct = new Map<string, { gtin: string; trigger: string; noticeGuard: GuardReport | null }>();
    if (kind === "baseline") {
      for (const g of scope) toAct.set(g, { gtin: g, trigger: `baseline as of ${upTo}`, noticeGuard: null });
    } else {
      await this.findNotices(res, st, gw, ev, after, upTo, emit, toAct);
    }
    if (this.d.hooks.noticeMemory) {
      res.checklist.memory_checked = res.notices.every((n) => n.checklist.memory_checked);
    } else {
      res.checklist.memory_checked = false;
      res.gaps.push("memory_checked: H-MEM is not wired into this sweep; prior decisions are read from the ops store through Zetaris");
    }

    // Actions: re-clear every SKU matched by exact GTIN (or in the baseline scope).
    const noticeMemo = this.noticeMemo;
    for (const target of toAct.values()) {
      const sku = this.d.catalogue.skus.find((s) => s.gtin === target.gtin);
      if (!sku) {
        res.gaps.push(`${target.gtin}: not in the catalogue; nothing to act on`);
        continue;
      }
      for (const market of sku.markets) await this.act(res, gw, ev, sku, market, upTo, target.trigger, target.noticeGuard, noticeMemo, replay, emit);
    }
    res.checklist.actions_proposed = true;

    // Closed-loop recheck inside Zetaris: cleared decisions joined to newer recalls.
    try {
      const rc = await gw.template("recheck_cleared", {});
      const rows = rowsAsObjects(rc);
      const rec = ev.fromTemplate(rc, `Closed-loop recheck: ${rows.length} cleared decision(s) have an exact-GTIN recall reported after the decision${replay ? ` (as of ${upTo})` : ""}`);
      res.recheck = { rows, evidence_id: rec.id };
      res.checklist.recheck_cleared_vs_new_recalls = true;
      emit("watch.recheck", { rows, evidence_id: rec.id });
      for (const r of rows) {
        const gtin = String(r.gtin);
        const market = String(r.market) as Market;
        if (res.actions.some((a) => a.gtin === gtin && a.market === market)) continue;
        const sku = this.d.catalogue.skus.find((s) => s.gtin === gtin);
        if (sku && sku.markets.includes(market)) {
          await this.act(res, gw, ev, sku, market, upTo, `closed-loop recheck: ${String(r.recall_number)} reported ${String(r.report_date)} after the ${String(r.status)} of ${String(r.decided_date)}`, null, noticeMemo, replay, emit);
        }
      }
    } catch (e) {
      res.gaps.push(`recheck_cleared failed: ${(e as Error).message.slice(0, 200)}`);
    }

    if (this.d.hooks.sweepDone) {
      try {
        await this.d.hooks.sweepDone(res);
      } catch (e) {
        res.gaps.push(`after-sweep step failed: ${(e as Error).message.slice(0, 200)}`);
      }
    }

    res.finished_at = new Date().toISOString();
    res.wall_ms = Math.round(performance.now() - t0);
    res.evidence_ids = ev.all().map((r) => r.id);
    this.sweeps.set(sweepId, res);
    if (this.d.sweepDir) {
      mkdirSync(this.d.sweepDir, { recursive: true });
      writeFileSync(`${this.d.sweepDir.replace(/[\\/]$/u, "")}/${sweepId}.json`, `${JSON.stringify(res, null, 1)}\n`, "utf8");
    }
    emit("watch.sweep_done", {
      kind,
      window: res.window,
      notices: res.notices.length,
      exact_matches: res.exact_matches.length,
      name_matches: res.name_matches.length,
      actions: res.actions.map((a) => ({ gtin: a.gtin, market: a.market, status: a.status, applied: a.applied })),
      wall_ms: res.wall_ms,
    });
    return res;
  }

  /** New FDA and FSA notices in (after, upTo], parsed and matched; fills toAct with exact matches. */
  private async findNotices(
    res: SweepResult,
    st: WatchState,
    gw: AsOfGateway,
    ev: ReplayEvidenceStore,
    after: string,
    upTo: string,
    emit: WatchEvent,
    toAct: Map<string, { gtin: string; trigger: string; noticeGuard: GuardReport | null }>,
  ): Promise<void> {
    const cat = this.d.catalogue.skus;
    const seenFda = new Set(st.seen.fda);
    const seenFsa = new Set(st.seen.fsa);
    const links = this.d.ops.rows("recall_links");

    // FDA: reported after the watermark and on or before as-of.
    let fdaNew: Record<string, unknown>[] = [];
    try {
      const r = (await gw.template("fda_recent", { since: st.fda_watermark })) as AsOfResult;
      fdaNew = rowsAsObjects(r).filter((x) => String(x.report_date) > st.fda_watermark && !seenFda.has(String(x.recall_number)));
      const e = ev.fromTemplate(r, `${fdaNew.length} openFDA report(s) dated after ${after} and on or before ${upTo} are new to the watch`);
      res.evidence_ids.push(e.id);
      if (r.truncated) res.gaps.push(`fda_recent returned ${r.rows.length} of ${r.row_count} rows (gateway cap); older new notices in the window were not seen`);
    } catch (e) {
      res.gaps.push(`fda_recent failed: ${(e as Error).message.slice(0, 200)}`);
    }

    const nameQueue: { notice: NoticeSweep; sku: CatalogueSku }[] = [];
    for (const head of fdaNew) {
      const n = String(head.recall_number);
      const ns: NoticeSweep = {
        source: "fda",
        notice_id: n,
        date: String(head.report_date),
        title: "",
        firm: str(head.firm),
        classification: str(head.classification),
        status: str(head.status),
        guard: { hit: false, summary: "" },
        parsed_by: [],
        allergens: [],
        exact_gtins: [],
        name_candidates: [],
        checklist: { notice_parsed: false, gtin_matches_checked: false, name_candidates_checked: false, memory_checked: false, actions_proposed: false },
        evidence_ids: [],
      };
      res.notices.push(ns);
      let row: NoticeRow | null = null;
      try {
        const r = await gw.template("fda_notice", { recall_number: n });
        const o = rowsAsObjects(r)[0];
        const e = ev.fromTemplate(r, o ? `FDA ${n} (${str(o.classification)}, ${str(o.status)}, reported ${str(o.report_date)}): ${String(o.reason ?? "").slice(0, 200)}` : `FDA ${n}: no row as of ${upTo}`);
        ns.evidence_ids.push(e.id);
        if (o) {
          row = {
            recall_number: n,
            report_date: String(o.report_date),
            classification: str(o.classification),
            status: str(o.status),
            firm: str(o.firm),
            distribution: str(o.distribution),
            product_description: str(o.product_description),
            reason: str(o.reason),
            code_info: str(o.code_info),
          };
          ns.title = (row.product_description ?? "").slice(0, 200);
        }
      } catch (e) {
        res.gaps.push(`fda_notice ${n} failed: ${(e as Error).message.slice(0, 200)}`);
      }
      if (!row) continue;
      // Guard before any model sees the text.
      const guard = scanFields({ product_description: row.product_description, reason: row.reason, code_info: row.code_info, firm: row.firm }, `fda:${n}`);
      ns.guard = { hit: guard.hit, summary: guard.summary };
      const gev = ev.add({ kind: "verifier", claim: `Guard on FDA ${n}: ${guard.summary}`, derived_from: [...ns.evidence_ids], details: { flags: guard.flags, findings: guard.results.flatMap((x) => x.findings.map((f) => ({ source: x.source, ...f }))) } });
      ns.evidence_ids.push(gev.id);
      // Deterministic GS1 scan.
      const scanned = extractUpcs(noticeText(row)).accepted;
      ns.parsed_by.push("gs1_scan");
      // Nemotron notice extraction, unless the guard flagged the text: then the notice is read
      // by the GS1 scan and the lexicon only, and that verdict is memoised so the clearance
      // chain inside this sweep reuses it (its own guard flags the same text, so its model
      // never receives it either).
      let nres: NoticeExtractionResult | null = this.noticeMemo.get(n)?.result ?? null;
      if (!nres && guard.hit) {
        nres = noticeScanOnly(row, `untrusted text in the notice (${guard.summary})`);
        this.noticeMemo.set(n, { result: nres, evidenceId: gev.id });
      }
      if (!nres && this.d.useModel && !guard.hit) {
        try {
          nres = await extractNotice(row, this.d.ollama);
          res.model.calls += nres.model.attempts;
          res.model.tokens_in += nres.model.tokens_in;
          res.model.tokens_out += nres.model.tokens_out;
          const mev = ev.add({
            kind: "model_extraction",
            claim: nres.ok
              ? `Nemotron read FDA ${n}: ${nres.upcs.filter((u) => u.kept).length} UPC(s) kept of ${nres.upcs.length}; undeclared [${nres.undeclared_groups.join(", ") || "none"}]`
              : `Nemotron gave no valid extraction for FDA ${n}`,
            model: nres.model,
            derived_from: [...ns.evidence_ids],
            details: { upcs: nres.upcs, scanned_upcs: scanned.map((u) => ({ raw: u.raw_code, gtin13: u.gtin13, transform: u.transform })), undeclared_groups: nres.undeclared_groups },
          });
          ns.evidence_ids.push(mev.id);
          this.noticeMemo.set(n, { result: nres, evidenceId: mev.id });
        } catch (e) {
          res.gaps.push(`extract.notice ${n} failed: ${(e as Error).message.slice(0, 200)}; the GS1 scan stands alone`);
        }
      } else if (guard.hit) {
        res.gaps.push(`FDA ${n}: untrusted text, so the notice was parsed by the GS1 scan only`);
      }
      if (nres?.ok) ns.parsed_by.push("nemotron");
      ns.allergens = nres?.undeclared_groups ?? [];
      ns.checklist.notice_parsed = true;

      // Exact GTIN matches against the catalogue.
      const byGtin = new Map<string, Set<ExactMatch["by"][number]>>();
      const add = (g: string, how: ExactMatch["by"][number]) => {
        if (!cat.some((s) => s.gtin === g)) return;
        if (!byGtin.has(g)) byGtin.set(g, new Set());
        byGtin.get(g)!.add(how);
      };
      for (const l of links) if (l.recall_number === n) add(l.gtin!, "recall_product_link");
      for (const u of scanned) add(u.gtin13, "gs1_scan");
      for (const u of nres?.upcs ?? []) if (u.kept && u.gtin13) add(u.gtin13, "nemotron");
      const newLinks: LinkRow[] = [];
      for (const [g, how] of byGtin) {
        if (how.has("recall_product_link")) continue;
        const sc = scanned.find((u) => u.gtin13 === g);
        const md = nres?.upcs.find((u) => u.kept && u.gtin13 === g);
        newLinks.push({
          link_key: `${n}|${g}`,
          recall_number: n,
          gtin: g,
          raw_code: (sc?.raw_code ?? md?.raw ?? "").slice(0, 40),
          transform: (sc?.transform ?? md?.transform ?? "").slice(0, 30),
          extracted_by: how.has("gs1_scan") && how.has("nemotron") ? "scan+nemotron" : how.has("gs1_scan") ? "watch-scan" : "nemotron",
        });
      }
      let written = new Set<string>();
      if (newLinks.length) {
        try {
          const w = await this.d.ops.addLinks(newLinks);
          written = new Set(w.added.map((x) => x.gtin));
          const lev = ev.add({ kind: "policy", claim: `Wrote ${w.added.length} recall_product_link row(s) for FDA ${n} to the ops store: ${w.added.map((x) => `${x.gtin} (${x.extracted_by})`).join(", ")}`, derived_from: [...ns.evidence_ids], details: { added: w.added, skipped: w.skipped, file_sha256: w.file_sha256 } });
          ns.evidence_ids.push(lev.id);
        } catch (e) {
          res.gaps.push(`writing links for ${n} failed: ${(e as Error).message.slice(0, 200)}`);
        }
      }
      for (const [g, how] of byGtin) {
        const m: ExactMatch = { notice_id: n, gtin: g, by: [...how], link_written: written.has(g), evidence_ids: [...ns.evidence_ids] };
        res.exact_matches.push(m);
        ns.exact_gtins.push(g);
        if (!toAct.has(g)) toAct.set(g, { gtin: g, trigger: `new FDA notice ${n} (${row.classification ?? "unclassified"}, ${row.status ?? "no status"}, reported ${row.report_date}) names this GTIN`, noticeGuard: guard.hit ? guard : null });
        emit("watch.exact_match", { notice_id: n, gtin: g, by: [...how] });
      }
      ns.checklist.gtin_matches_checked = true;
      for (const s of brandCandidates(cat, row.firm, row.product_description)) {
        if (byGtin.has(s.gtin)) continue;
        ns.name_candidates.push(s.gtin);
        nameQueue.push({ notice: ns, sku: s });
      }
      ns.checklist.name_candidates_checked = true;
      this.noticeMemory(res, ns, ev, [row.firm]);
      emit("watch.notice", { source: "fda", notice_id: n, date: ns.date, classification: ns.classification, status: ns.status, exact_gtins: ns.exact_gtins, name_candidates: ns.name_candidates, guard_hit: guard.hit });
    }

    // FSA: created after the watermark and on or before as-of. FSA alerts carry no GTIN.
    let fsaNew: Record<string, unknown>[] = [];
    let fsaRecentEv: string | null = null;
    const fsaSeen: Parameters<NonNullable<WatchHooks["fsaSeen"]>>[0] = [];
    try {
      const r = (await gw.template("fsa_recent", { since: st.fsa_watermark })) as AsOfResult;
      fsaNew = rowsAsObjects(r).filter((x) => String(x.created) > st.fsa_watermark && !seenFsa.has(String(x.notation)));
      const e = ev.fromTemplate(r, `${fsaNew.length} UK FSA allergy alert(s) created after ${after} and on or before ${upTo} are new to the watch`);
      res.evidence_ids.push(e.id);
      fsaRecentEv = e.id;
    } catch (e) {
      res.gaps.push(`fsa_recent failed: ${(e as Error).message.slice(0, 200)}`);
    }
    for (const a of fsaNew) {
      const id = String(a.notation);
      const ns: NoticeSweep = {
        source: "fsa",
        notice_id: id,
        date: String(a.created),
        title: String(a.title ?? "").slice(0, 200),
        firm: str(a.business),
        classification: null,
        status: null,
        guard: { hit: false, summary: "" },
        parsed_by: [],
        allergens: [],
        exact_gtins: [],
        name_candidates: [],
        checklist: { notice_parsed: false, gtin_matches_checked: true, name_candidates_checked: false, memory_checked: false, actions_proposed: false },
        evidence_ids: [],
        note: "FSA alerts carry no GTIN: name matching only",
      };
      res.notices.push(ns);
      const guard = scanFields({ title: str(a.title), business: str(a.business) }, `fsa:${id}`);
      ns.guard = { hit: guard.hit, summary: guard.summary };
      ns.evidence_ids.push(ev.add({ kind: "verifier", claim: `Guard on FSA ${id}: ${guard.summary}`, derived_from: [], details: { flags: guard.flags } }).id);
      let allergensEv: string | null = null;
      let allergens: string[] | null = null;
      if (/^FSA-AA-\d+-\d{4}$/u.test(id)) {
        try {
          const r = await gw.template("fsa_allergens", { notation: id });
          const labels = rowsAsObjects(r).map((x) => String(x.allergen_label));
          ns.allergens = labels;
          allergens = labels;
          allergensEv = ev.fromTemplate(r, `FSA ${id} lists allergen(s): ${labels.join(", ") || "none"}`).id;
          ns.evidence_ids.push(allergensEv);
          ns.parsed_by.push("fsa_alert_allergen");
          ns.checklist.notice_parsed = true;
        } catch (e) {
          res.gaps.push(`fsa_allergens ${id} failed: ${(e as Error).message.slice(0, 200)}`);
        }
      } else {
        res.gaps.push(`FSA ${id}: an update notice; the fsa_allergens template accepts FSA-AA-<n>-<yyyy> only, so its allergens were not read`);
        ns.checklist.notice_parsed = true;
      }
      fsaSeen.push({ row: a, allergens, recentEvidenceId: fsaRecentEv, allergensEvidenceId: allergensEv });
      for (const s of brandCandidates(cat, str(a.title), str(a.business))) {
        ns.name_candidates.push(s.gtin);
        nameQueue.push({ notice: ns, sku: s });
      }
      ns.checklist.name_candidates_checked = true;
      this.noticeMemory(res, ns, ev, [str(a.business), str(a.title)]);
      emit("watch.notice", { source: "fsa", notice_id: id, date: ns.date, allergens: ns.allergens, name_candidates: ns.name_candidates, guard_hit: guard.hit });
    }

    // Name-only candidates: confirmed through Zetaris by brand token, then queued for review (no status change).
    const byToken = new Map<string, TemplateResult | null>();
    for (const { notice, sku } of nameQueue) {
      const token = sku.brand_token!;
      if (!byToken.has(token)) {
        try {
          byToken.set(token, await gw.template("recalls_by_name", { brand: token }));
        } catch (e) {
          byToken.set(token, null);
          res.gaps.push(`recalls_by_name "${token}" failed: ${(e as Error).message.slice(0, 200)}`);
        }
      }
      const r = byToken.get(token) ?? null;
      const rows = r ? rowsAsObjects(r) : [];
      const hit = rows.find((x) => String(x.notice_id) === notice.notice_id);
      const evRec: EvidenceRecord | null = r
        ? ev.fromTemplate(r, `Brand token "${token}" names ${notice.source.toUpperCase()} ${notice.notice_id}${hit ? "" : " (not returned by this query)"}`, {
            filter: (x) => String(x.notice_id) === notice.notice_id,
          })
        : null;
      const title = hit ? String(hit.title ?? "") : notice.title;
      const similarity = Number(bestNameSimilarity(sku.name, title).toFixed(3));
      for (const market of sku.markets) {
        const item = this.d.queue.add({
          kind: "name_match",
          gtin: sku.gtin,
          market,
          status: "HOLD",
          statement: null,
          summary: `${notice.source.toUpperCase()} ${notice.notice_id} (${notice.date}) names brand "${token}"; product-name similarity ${similarity} (no status change; confirm to hold)`,
          reasons: [`name-only match; FSA alerts carry no GTIN${similarity >= 0.85 ? "; similarity >= 0.85, so policy R2 would hold pending your confirmation" : ""}`],
          evidence_ids: [...notice.evidence_ids, ...(evRec ? [evRec.id] : [])],
          run_id: res.sweep_id,
          source: "sweep",
          notice_id: notice.notice_id,
          similarity,
          replay: res.replay ? { as_of: res.window.up_to, banner: res.banner ?? res.replay.banner } : null,
        });
        const m: NameMatch = {
          notice_id: notice.notice_id,
          source: notice.source,
          gtin: sku.gtin,
          market,
          brand_token: token,
          similarity,
          confirmed_in_zetaris: !!hit,
          queue_id: item.id,
          evidence_ids: item.evidence_ids,
        };
        res.name_matches.push(m);
        emit("watch.name_match", { ...m });
      }
    }
    if (fsaSeen.length && this.d.hooks.fsaSeen) {
      try {
        const w = await this.d.hooks.fsaSeen(fsaSeen, ev);
        if (w) {
          res.evidence_ids.push(w.evidenceId);
          emit("watch.world", { summary: w.summary, evidence_id: w.evidenceId });
        }
      } catch (e) {
        res.gaps.push(`World Model ingest of the new FSA alerts failed: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    res.checklist.notice_parsed = res.notices.every((x) => x.checklist.notice_parsed);
    res.checklist.gtin_matches_checked = true;
    res.checklist.name_candidates_checked = true;
  }

  /** H-MEM for one notice (hook); resolves the notice's memory_checked item. */
  private noticeMemory(res: SweepResult, ns: NoticeSweep, ev: ReplayEvidenceStore, names: (string | null)[]): void {
    const hook = this.d.hooks.noticeMemory;
    if (!hook) return;
    const gtins = [...new Set([...ns.exact_gtins, ...ns.name_candidates])];
    const brands = [...new Set(gtins.map((g) => this.d.catalogue.skus.find((s) => s.gtin === g)?.brand ?? "").filter(Boolean))];
    try {
      const m = hook({ source: ns.source, notice_id: ns.notice_id, gtins, brands: brands.length ? brands : names.filter((x): x is string => !!x).slice(0, 1) }, ev);
      ns.evidence_ids.push(m.evidenceId);
      ns.checklist.memory_checked = true;
    } catch (e) {
      res.gaps.push(`memory check for ${ns.notice_id} failed: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  /** Re-clears one SKU and market as of `asOf`; HOLD/BLOCK is applied, anything else queued. */
  private async act(
    res: SweepResult,
    gw: AsOfGateway,
    ev: ReplayEvidenceStore,
    sku: CatalogueSku,
    market: Market,
    asOf: string,
    trigger: string,
    noticeGuard: GuardReport | null,
    noticeMemo: Map<string, { result: NoticeExtractionResult; evidenceId: string }>,
    replay: { as_of: string; banner: string } | null,
    emit: WatchEvent,
  ): Promise<void> {
    const deps: PipelineDeps = { gateway: gw, dq: new DqGate(gw), ollama: this.d.ollama, evidence: ev, log: this.d.log, noticeMemo };
    emit("watch.clear_started", { gtin: sku.gtin, market, trigger });
    let r: ClearResult;
    try {
      r = await this.d.clear(sku.gtin, market, deps, asOf);
    } catch (e) {
      res.gaps.push(`clear ${sku.gtin} ${market} failed: ${(e as Error).message.slice(0, 200)}`);
      return;
    }
    for (const n of r.notices) if (!n.reused && n.model) {
      res.model.calls += n.model.attempts;
      res.model.tokens_in += n.model.tokens_in;
      res.model.tokens_out += n.model.tokens_out;
    }
    if (r.extraction.model && !r.extraction.reused) {
      res.model.calls += r.extraction.model.attempts;
      res.model.tokens_in += r.extraction.model.tokens_in;
      res.model.tokens_out += r.extraction.model.tokens_out;
    }
    // A Markovian clearance also plans with the model: its planner calls are measured too.
    const loop = (r as ClearResult & { loop?: { summary: { planner_calls: number; planner_prompt_tokens: number; planner_eval_tokens: number } } }).loop;
    if (loop) {
      res.model.calls += loop.summary.planner_calls;
      res.model.tokens_in += loop.summary.planner_prompt_tokens;
      res.model.tokens_out += loop.summary.planner_eval_tokens;
    }
    let status: Decision = r.decision.status;
    let reason = `${trigger}. ${compactReason(r)}`;
    if (noticeGuard && (status === "CLEAR" || status === "CLEAR_WITH_STATEMENT")) {
      status = "HOLD";
      reason = `${trigger}. HOLD: untrusted text in the notice (${noticeGuard.summary}); policy proposed ${r.decision.status}`;
    }
    const rules = [...new Set(r.decision.firings.map((f) => f.rule))];
    const action: SweepAction = {
      gtin: sku.gtin,
      market,
      trigger,
      status,
      rules,
      applied: false,
      decision_id: null,
      contract_id: null,
      visible_in_zetaris: null,
      queue_id: null,
      run_id: r.run_id,
      reason,
      evidence_ids: r.evidence_ids.filter((id) => r.card.some((c) => c.evidenceIds.includes(id))).slice(0, 12),
    };
    if (status === "HOLD" || status === "BLOCK") {
      try {
        const applied = await applyAutomatic(this.d.ops, this.d.gateway, {
          gtin: sku.gtin,
          market,
          status,
          reason: reason.slice(0, 950),
          runId: res.sweep_id,
          flags: noticeGuard ? ["untrusted_text"] : [],
          replay: replay ? { asOf, banner: replay.banner } : null,
        }, this.d.queue);
        Object.assign(action, { applied: true, decision_id: applied.row.decision_id, contract_id: applied.contract.contractId, visible_in_zetaris: applied.visibility.visible });
        if (applied.superseded.length) {
          action.evidence_ids.push(ev.add({ kind: "policy", claim: `${status} ${applied.row.decision_id} superseded ${applied.superseded.length} pending proposal(s) for ${sku.gtin} ${market} (${applied.superseded.join(", ")})`, derived_from: [], details: { superseded: applied.superseded } }).id);
          emit("watch.approval_superseded", { gtin: sku.gtin, market, queue_ids: applied.superseded, decision_id: applied.row.decision_id });
        }
        const vis = applied.visibility.result
          ? ev.fromTemplate(applied.visibility.result, `Decision ${applied.row.decision_id} (${status}) is ${applied.visibility.visible ? "visible" : "NOT visible"} in clearance_usl.decision (closed loop)`, {
              filter: (x) => x.decision_id === applied.row.decision_id,
            })
          : null;
        if (vis) action.evidence_ids.push(vis.id);
        if (!applied.visibility.visible) res.gaps.push(`decision ${applied.row.decision_id} was written but not seen in Zetaris after ${applied.visibility.attempts} reads${applied.visibility.error ? `: ${applied.visibility.error}` : ""}`);
        emit("watch.action", { ...action, auto: true });
      } catch (e) {
        res.gaps.push(`auto ${status} for ${sku.gtin} ${market} not written: ${(e as Error).message.slice(0, 200)}`);
      }
    } else {
      const item = this.d.queue.add({
        kind: "proposal",
        gtin: sku.gtin,
        market,
        status,
        statement: r.statement?.text ?? null,
        summary: `${status} proposed after ${trigger}; pending the officer's signed approval`,
        reasons: r.decision.firings.map((f) => `${f.rule} ${f.reason}`),
        evidence_ids: action.evidence_ids,
        run_id: r.run_id,
        source: "sweep",
        replay: replay ? { as_of: asOf, banner: replay.banner } : null,
        over_decision: overDecision(this.d.ops, sku.gtin, market),
      });
      action.queue_id = item.id;
      emit("watch.approval_queued", { gtin: sku.gtin, market, status, queue_id: item.id });
    }
    res.actions.push(action);
    if (this.d.hooks.actionTaken) {
      try {
        await this.d.hooks.actionTaken(action, r, ev);
      } catch (e) {
        res.gaps.push(`recording ${sku.gtin} ${market} in memory failed: ${(e as Error).message.slice(0, 200)}`);
      }
    }
  }
}
