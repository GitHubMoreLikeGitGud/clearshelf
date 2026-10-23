// ClearShelf command line (SPEC 6: onboard | clear | watch | replay | eval | warmup, plus why).
//
//   npm run clear -- --gtin 0816929000119 --market UK [--json] [--as-of 2026-10-23] [--no-apply] [--straight]
//        one SKU as a Markovian investigation with H-MEM, the World Model and the guard;
//        HOLD/BLOCK is applied through the ops store, CLEAR... is queued for signed approval
//   npm run clear -- --manifest [--roles demo,eval_only] [--out <file>] [--ram-gate 3072] [--ram-reserve 4608] [--ram-wait-s 1200]
//        every manifest SKU in each of its markets, straight pipeline, nothing written (the eval batch)
//   npm run replay -- --as-of 2026-10-10 [--scope scenario|all|none] [--until YYYY-MM-DD] [--no-poll] [--json] [--straight]
//   npm run watch -- [--until YYYY-MM-DD] [--json] [--straight]          one poll (live, or the replay's next step)
//   npm run cli -- why --gtin 0816929000119 --market UK                   "why was this held?" ledger trace
//   npm run eval -- [--only E1,E10] [--no-model]                         SPEC 9.1 scenarios through the agent
//   npm run warmup -- [--no-model] [--wait-s 180]                        gateway cache, model load, memory seed check
//   npm run onboard -- [--dry-run] [--skip-exists] [--gtin <GTIN>]...     runs gateway.onboard (Python) with these flags
//
// The commands that open data/hmem and data/world (clear, watch, replay, why, eval, warmup)
// take data/agent.lock, so they refuse to run while the server or another command holds it.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, REPO_ROOT, REPO_ROOT_URL } from "./config.ts";
import { clearWithAgent, openRuntime, whyTrace, type ClearOutcome } from "./runtime.ts";
import { runEval } from "./eval/run.ts";
import { seedMemory } from "./memory/seed.ts";
import { DEFAULT_OPTIONS, OllamaClient } from "./llm/ollama.ts";
import { DqGate, GatewayClient, validateParam } from "./zetaris/client.ts";
import { EvidenceStore, newRunId, type EvidenceRecord } from "./evidence/store.ts";
import { clearSku, type ClearResult, type PipelineDeps } from "./pipeline.ts";
import type { Market } from "./policy/decide.ts";
import { AsOfGateway, replayBanner, ReplayEvidenceStore } from "./watch/asOf.ts";

interface Args {
  cmd: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { cmd, flags };
}

function shorten(s: string, n: number): string {
  const one = s.replace(/\s+/gu, " ");
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function printResult(r: ClearResult, records: readonly EvidenceRecord[]): void {
  const out: string[] = [];
  const p = r.product;
  out.push(`ClearShelf clearance  ${r.gtin}  market ${r.market}  run ${r.run_id}  as of ${r.as_of}`);
  out.push(`Product: ${p.found ? `"${p.name}" (${p.brand ?? "no brand"}), lang ${p.lang}, ${p.has_text ? `ingredient text from ${p.text_field}` : "no ingredient text"}` : "not in clearance_usl.product"}`);
  out.push("");
  out.push(`DECISION: ${r.decision.status}${r.decision.pendingSignature ? "  (proposed; needs the officer's signed approval)" : "  (may be applied automatically)"}`);
  for (const f of r.decision.firings) out.push(`  ${f.rule} ${f.effect}: ${f.reason}  [${f.evidenceIds.join(", ")}]`);
  for (const f of r.decision.review.slice(0, 5)) out.push(`  ${f.rule} review: ${shorten(f.reason, 160)}  [${f.evidenceIds.join(", ")}]`);
  if (r.decision.review.length > 5) out.push(`  ${r.decision.review.length - 5} more review item(s) (--json lists them)`);
  for (const f of r.decision.notes) out.push(`  ${f.rule} note: ${f.reason}  [${f.evidenceIds.join(", ")}]`);
  if (r.statement) {
    out.push("");
    out.push(`Statement draft (${r.market}, from verified spans only): ${r.statement.text}`);
    for (const x of r.statement.excluded) out.push(`  left out: ${x.group}${x.species ? ` (${x.species})` : ""} "${x.evidence_text}": ${x.reason}`);
  }
  if (r.claim_tests.length) {
    out.push("");
    out.push("Claim tests:");
    for (const c of r.claim_tests) out.push(`  ${c.claim}: ${c.verdict}${c.contradicting.length ? ` (${c.contradicting.join(", ")})` : ""}  [${c.evidenceIds.join(", ")}]`);
  }
  out.push("");
  out.push("Cited claims:");
  for (const c of r.card) out.push(`  - ${shorten(c.text, 260)}  [${c.evidenceIds.join(", ")}]`);
  out.push("");
  out.push("Not checked:");
  for (const n of r.not_checked) out.push(`  - ${n.text}`);
  if (r.gaps.length) {
    out.push("");
    out.push("Pipeline gaps:");
    for (const g of r.gaps) out.push(`  - ${g}`);
  }
  out.push("");
  out.push("Evidence:");
  for (const e of records) {
    if (e.kind === "zetaris_sql" || e.kind === "dq") {
      out.push(
        `  ${e.id} ${e.kind}${e.dq_source ? `/${e.dq_source}` : ""} ${e.template_id}  ${e.zetaris_object}  rows ${e.row_count}  ${e.elapsed_ms} ms  cache ${e.cache_state}${e.reused ? " (reused)" : ""}`,
      );
      out.push(`      sql: ${shorten(e.sql ?? "", 200)}`);
      out.push(`      sql_sha256 ${e.sql_sha256}  queried ${e.queried_at}  source cached ${e.source_cached_at ?? (e.raw_objects?.some((o) => !o.startsWith("clearshelf_ops.")) ? "not reported for this statement" : "n/a (ops table, read live)")}`);
      out.push(`      source ${shorten(e.source_url ?? "", 120)}  licence: ${e.licence}`);
    } else if (e.model) {
      out.push(
        `  ${e.id} ${e.kind}  ${e.model.name} think=${e.model.think} tokens in/out ${e.model.tokens_in}/${e.model.tokens_out} (${e.model.label}, ${e.model.attempts} attempt(s))${e.reused ? " (reused)" : ""}  from [${(e.derived_from ?? []).join(", ")}]`,
      );
    } else {
      out.push(`  ${e.id} ${e.kind}  from [${(e.derived_from ?? []).join(", ")}]`);
    }
  }
  out.push("");
  out.push(
    `E-cov ${r.card.filter((c) => c.evidenceIds.length).length}/${r.quality.claims} claims cited; E-complete ${r.quality.records - Object.keys(r.quality.incomplete_records).length}/${r.quality.records} records complete. Evidence file: ${r.evidence_file ?? "(memory only)"}`,
  );
  out.push(`Step times (ms, measured): ${Object.entries(r.timings_ms).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(out.join("\n"));
}

function deps(evidence: EvidenceStore, shared?: Partial<PipelineDeps>): PipelineDeps {
  const cfg = loadConfig();
  const gateway = shared?.gateway ?? new GatewayClient({ baseUrl: cfg.gatewayUrl });
  return {
    gateway,
    dq: shared?.dq ?? new DqGate(gateway),
    ollama: shared?.ollama ?? new OllamaClient({ baseUrl: cfg.ollamaUrl, model: cfg.model }),
    evidence,
    log: shared?.log ?? ((l) => process.stderr.write(`${l}\n`)),
    extractionMemo: shared?.extractionMemo,
    noticeMemo: shared?.noticeMemo,
  };
}

function availableMiB(): number {
  return Math.round(os.freemem() / 1048576);
}

async function cmdClear(flags: Record<string, string | boolean>): Promise<number> {
  const asOf = typeof flags["as-of"] === "string" ? validateParam("date", flags["as-of"]) : undefined;
  if (flags.manifest) return cmdClearManifest(flags, asOf);
  const gtin = String(flags.gtin ?? "");
  const market = String(flags.market ?? "").toUpperCase();
  validateParam("gtin", gtin);
  validateParam("market", market);
  if (flags.straight) {
    const evidence = new EvidenceStore();
    const result = await clearSku(gtin, market as Market, deps(evidence), asOf);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printResult(result, evidence.all());
    return 0;
  }
  const rt = openRuntime({ command: `clear ${gtin} ${market}` });
  try {
    // As the server does: an as-of clearance is a replay (as-of gateway, replay evidence, rp- row with the banner).
    const banner = asOf ? replayBanner(asOf) : null;
    if (banner) process.stderr.write(`*** ${banner.toUpperCase()} (replayed, not live) ***\n`);
    const o = await clearWithAgent(rt, {
      gtin,
      market: market as Market,
      asOf,
      ...(asOf && banner
        ? { gateway: new AsOfGateway(rt.gateway, asOf, banner), evidence: new ReplayEvidenceStore({ as_of: asOf, banner }, undefined, rt.evidenceDir), replay: { asOf, banner } }
        : {}),
      apply: !flags["no-apply"],
      trigger: "intake (command line)",
      intake: true,
      maxChunks: typeof flags["max-chunks"] === "string" ? Number(flags["max-chunks"]) : undefined,
      onEvent: (type, data) => {
        if (type === "loop.tool") process.stderr.write(`  chunk ${String(data.chunk)} ${String(data.tool)} (${String(data.source)}) ${data.ok ? "ok" : "FAILED"} ${String(data.latency_ms)} ms: ${shorten(String(data.fact), 150)}\n`);
      },
    });
    if (flags.json) console.log(JSON.stringify({ ...o.result, applied: o.applied, queued: o.queued, recorded: o.recorded }, null, 2));
    else {
      printResult(o.result, o.evidence.all());
      printAgent(o);
    }
    return 0;
  } finally {
    rt.close();
  }
}

function printAgent(o: ClearOutcome): void {
  const s = o.result.loop.summary;
  const out: string[] = [""];
  out.push(
    `Markovian loop: ${o.result.loop.status}, ${s.chunks} chunk(s), ${s.tool_calls} tool call(s) (${s.tool_calls_by_model} chosen by the model, ${s.fallback_steps} fallback), planner ${s.planner_calls} call(s) (${s.planner_valid_first_try} valid first try), tokens in/out ${s.planner_prompt_tokens}/${s.planner_eval_tokens} (measured); tool model tokens ${s.tool_model_tokens_in}/${s.tool_model_tokens_out}; wall ${o.result.loop.wall_ms} ms`,
  );
  out.push(`  chart (first planner prompt per chunk, measured / full-history baseline, estimated): ${o.result.loop.chart.map((c) => `${c.markovian_prompt_tokens_measured}/${c.naive_prompt_tokens_estimated}`).join(" -> ")}`);
  out.push(`  extraction: ${o.result.extraction.ran ? (o.result.extraction.reused ? "REUSED from memory (no model call)" : "model call") : "not run"}`);
  if (o.applied) out.push(`Applied: ${o.applied.status} ${o.applied.decision_id} (contract ${o.applied.contract_id}); visible in Zetaris clearance_usl.decision: ${o.applied.visible_in_zetaris}`);
  if (o.queued) out.push(`Queued for the officer's signed approval: ${o.queued.status} (${o.queued.queue_id})`);
  const rec = o.recorded;
  if (!rec) out.push("Dry run (--no-apply): no decision row, queue item, decision memory, World Model decision or extraction rows written.");
  else {
    const m = rec.memory;
    out.push(`H-MEM: ${m.facts_added} new fact(s), ${m.facts_reconfirmed} reconfirmed, conflicts queued now [${m.conflicts_queued.join(", ") || "none"}], decision memory ${m.decision_memory_id}${m.extraction_memory_id ? `, extraction memory ${m.extraction_memory_id}` : ""}`);
    if (rec.world) out.push(`World Model: ${rec.world.events_appended} event(s) appended, snapshot ${rec.world.snapshot_id} at event ${rec.world.event_seq}`);
    if (rec.extractions) out.push(`Ops write-back: ${rec.extractions.rows} verified extraction row(s) (clearance_usl.extracted_allergen)`);
    for (const g of rec.gaps) out.push(`  gap: ${g}`);
  }
  out.push(`Loop report: ${o.result.loop.report_file ?? "(memory only)"}`);
  console.log(out.join("\n"));
}

async function cmdWhy(flags: Record<string, string | boolean>): Promise<number> {
  const gtin = validateParam("gtin", String(flags.gtin ?? ""));
  const market = validateParam("market", String(flags.market ?? "").toUpperCase()) as Market;
  const rt = openRuntime({ command: `why ${gtin} ${market}` });
  try {
    const t = await whyTrace(rt, gtin, market);
    if (flags.json) console.log(JSON.stringify(t, null, 2));
    else console.log([`Why ${gtin} ${market}:`, ...t.lines.map((l, i) => `${i + 1}. ${l}`)].join("\n"));
    return t.hmem.decision ? 0 : 3;
  } finally {
    rt.close();
  }
}

async function cmdWarmup(flags: Record<string, string | boolean>): Promise<number> {
  const cfg = loadConfig();
  const gateway = new GatewayClient({ baseUrl: cfg.gatewayUrl });
  const waitS = Number(typeof flags["wait-s"] === "string" ? flags["wait-s"] : 180);
  let ok = true;
  // 1. Gateway: Zetaris answers and the warm-up has cached every target (the gateway warms on start and after a driver restart).
  const t0 = performance.now();
  let h: Record<string, unknown> | null = null;
  for (;;) {
    try {
      h = await gateway.health();
    } catch (e) {
      h = { ok: false, error: (e as Error).message.slice(0, 200) };
    }
    const lw = (h.last_warmup ?? null) as Record<string, unknown> | null;
    const warm = !!h.ok && !!lw && !lw.failed && !(Array.isArray(lw.cached_now) && lw.skipped === "warm-up already running");
    if (warm || performance.now() - t0 > waitS * 1000) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const cache = (h?.cache ?? {}) as { cached_tables?: string[] };
  const lw = (h?.last_warmup ?? null) as Record<string, unknown> | null;
  console.log(`gateway ${gateway.baseUrl}: ok=${String(h?.ok)}; ${cache.cached_tables?.length ?? 0} table(s) cached; last warm-up ${JSON.stringify(lw)?.slice(0, 300)}`);
  if (!h?.ok || (lw && lw.failed && Object.keys(lw.failed as object).length)) ok = false;
  // 2. Model: loaded for 30 min, after a free-RAM check (the PC runs other model work).
  const ollama = new OllamaClient({ baseUrl: cfg.ollamaUrl, model: cfg.model });
  if (!flags["no-model"]) {
    const free = Math.round(os.freemem() / 1048576);
    const resident = (await ollama.loaded().catch(() => [])).some((m) => m.name === ollama.model);
    if (!resident && free < 3072 + 4608) {
      console.log(`model ${ollama.model}: not loaded, free RAM ${free} MiB is below ${3072 + 4608} MiB`);
      ok = false;
    } else {
      const r = await fetch(`${cfg.ollamaUrl}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: ollama.model, keep_alive: "30m", options: { num_ctx: DEFAULT_OPTIONS.num_ctx } }), signal: AbortSignal.timeout(120_000) });
      const loaded = (await ollama.loaded()).find((m) => m.name === ollama.model);
      console.log(`model ${ollama.model}: HTTP ${r.status}; loaded ${loaded ? `${Math.round(loaded.size / 1048576)} MiB (${Math.round(loaded.size_vram / 1048576)} MiB in VRAM), context ${loaded.context_length ?? "?"}` : "no"}; free RAM before ${free} MiB`);
      if (!loaded) ok = false;
    }
  }
  // 3. Memory and World Model: seeded and readable (seeding is idempotent).
  const rt = openRuntime({ command: "warmup", ollama, gateway });
  try {
    const seed = await seedMemory(rt.hmem, { repoRoot: REPO_ROOT, log: () => {} });
    const docs = seed.documents;
    console.log(`H-MEM data/hmem: ${rt.hmem.store.all().length} memories; seed documents ${docs.length} (${docs.filter((d) => d.skipped).length} already seeded, ${seed.missing.length} source file(s) not found: ${seed.missing.join(", ") || "none"}); ${rt.hmem.allergenConflicts.queue().length} queued allergen conflict(s); ${rt.hmem.dreams("proposed").length} dream proposal(s)`);
    const g = rt.world.exportGraph();
    console.log(`World Model data/world: ${g.nodes.length} entities, ${g.edges.length} edges, ${g.events} events, ${g.snapshots} snapshots, ${g.mergeQueue.filter((p) => p.status === "pending").length} merge proposal(s) pending`);
    console.log(`ops store: ${rt.ops.decisions().length} decision row(s); approval queue ${rt.queue.pending().length} pending`);
  } finally {
    rt.close();
  }
  console.log(ok ? "warm-up OK" : "warm-up INCOMPLETE (see above)");
  return ok ? 0 : 3;
}

/** gateway.onboard (Python, JDBC as the registrar) with the given flags, from the repo root. */
function cmdOnboard(argv: string[]): Promise<number> {
  const py = [`${REPO_ROOT}.venv/Scripts/python.exe`, `${REPO_ROOT}.venv/bin/python`].find((x) => existsSync(x));
  if (!py) {
    console.error("no Python venv at .venv (python -m venv .venv && .venv/Scripts/pip install -r gateway/requirements.txt)");
    return Promise.resolve(2);
  }
  return new Promise((ok) => {
    const child = spawn(py, ["-m", "gateway.onboard", ...argv], { cwd: REPO_ROOT, stdio: "inherit" });
    child.on("exit", (code) => ok(code ?? 1));
    child.on("error", (e) => {
      console.error(`onboard: ${e.message}`);
      ok(1);
    });
  });
}

interface ManifestSku {
  gtin: string;
  role: string;
  markets: string[];
}

async function cmdClearManifest(flags: Record<string, string | boolean>, asOf: string | undefined): Promise<number> {
  const roles = String(typeof flags.roles === "string" ? flags.roles : "demo,eval_only").split(",");
  const manifest = JSON.parse(readFileSync(new URL("data/manifest/skus.json", REPO_ROOT_URL), "utf8")) as { skus: ManifestSku[] };
  const jobs = manifest.skus.filter((s) => roles.includes(s.role)).flatMap((s) => s.markets.map((m) => ({ gtin: s.gtin, market: m as Market, role: s.role })));
  const shared: Partial<PipelineDeps> = { extractionMemo: new Map(), noticeMemo: new Map() };
  const first = deps(new EvidenceStore(newRunId(), null), shared);
  // Within one batch over SKUs onboarded before it started, a table-wide SHOW DQ result may serve every GTIN for 5 min.
  Object.assign(shared, { gateway: first.gateway, dq: new DqGate(first.gateway, 300_000), ollama: first.ollama });
  const results: (ClearResult & { role: string; wall_ms: number; available_mib_before: number })[] = [];
  const outPath =
    typeof flags.out === "string"
      ? flags.out
      : fileURLToPath(new URL(`data/eval/pipeline-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`, REPO_ROOT_URL));
  mkdirSync(new URL("data/eval/", REPO_ROOT_URL), { recursive: true });
  const t0 = performance.now();
  const ramWaits: { before_job: number; waited_ms: number; from_mib: number; to_mib: number }[] = [];
  let stopped: string | null = null;
  const save = () =>
    writeFileSync(
      outPath,
      JSON.stringify(
        { generated_at: new Date().toISOString(), roles, jobs: jobs.length, done: results.length, stopped, wall_ms: Math.round(performance.now() - t0), ram_waits: ramWaits, ram_guard_events: first.ollama.ramGuardEvents, results },
        null,
        2,
      ),
      "utf8",
    );
  // The PC runs other model workloads: before each SKU, wait (model unloaded) until
  // available RAM is back above the gate, and stop the batch rather than run starved.
  const gateMiB = Number(typeof flags["ram-gate"] === "string" ? flags["ram-gate"] : 3072);
  const maxWaitMs = Number(typeof flags["ram-wait-s"] === "string" ? flags["ram-wait-s"] : 1200) * 1000;
  // The 4B runner took about 4.4 GB of private memory once loaded (measured on this PC),
  // so a SKU starts with the model unloaded only if that much is free on top of the gate.
  const reserveMiB = Number(typeof flags["ram-reserve"] === "string" ? flags["ram-reserve"] : 4608);
  const modelLoaded = async () => {
    try {
      return (await first.ollama.loaded()).some((m) => m.name === first.ollama.model);
    } catch {
      return false;
    }
  };
  for (const [i, j] of jobs.entries()) {
    let avail = availableMiB();
    let need = (await modelLoaded()) ? gateMiB : gateMiB + reserveMiB;
    if (avail < need) {
      const w0 = performance.now();
      const from = avail;
      if (await modelLoaded()) {
        try {
          await first.ollama.unload();
        } catch (e) {
          process.stderr.write(`  unload failed: ${(e as Error).message}
`);
        }
      }
      need = gateMiB + reserveMiB;
      process.stderr.write(`  available RAM ${avail} MiB < ${need} MiB needed: ${first.ollama.model} unloaded, waiting up to ${maxWaitMs / 1000} s
`);
      while (availableMiB() < need && performance.now() - w0 < maxWaitMs) {
        await new Promise((r) => setTimeout(r, 20_000));
      }
      avail = availableMiB();
      ramWaits.push({ before_job: i + 1, waited_ms: Math.round(performance.now() - w0), from_mib: from, to_mib: avail });
      if (avail < need) {
        stopped = `available RAM stayed below ${need} MiB for ${maxWaitMs / 1000} s before job ${i + 1}`;
        process.stderr.write(`  stopping: ${stopped}
`);
        break;
      }
    }
    process.stderr.write(`[${i + 1}/${jobs.length}] ${j.gtin} ${j.market} (${j.role}); available RAM ${avail} MiB
`);
    const evidence = new EvidenceStore();
    const s = performance.now();
    const r = await clearSku(j.gtin, j.market, deps(evidence, shared), asOf);
    results.push({ ...r, role: j.role, wall_ms: Math.round(performance.now() - s), available_mib_before: avail });
    process.stderr.write(`  -> ${r.decision.status} (${[...new Set(r.decision.firings.map((f) => f.rule))].join(",")}) in ${Math.round(performance.now() - s)} ms
`);
    save();
  }
  save();
  for (const r of results) {
    console.log(`${r.gtin} ${r.market} ${r.role.padEnd(9)} ${r.decision.status.padEnd(20)} ${[...new Set(r.decision.firings.map((f) => f.rule))].join(",")}`);
  }
  console.log(`wrote ${outPath}${stopped ? ` (stopped early: ${stopped})` : ""}`);
  return stopped ? 3 : 0;
}

async function main(): Promise<number> {
  loadConfig();
  const argv = process.argv.slice(2);
  if (argv[0] === "onboard") return cmdOnboard(argv.slice(1));
  const { cmd, flags } = parseArgs(argv);
  switch (cmd) {
    case "clear":
      return cmdClear(flags);
    case "watch":
    case "replay":
      return (await import("./watch/cli.ts")).watchCommand(cmd === "watch" ? "poll" : cmd, flags);
    case "why":
      return cmdWhy(flags);
    case "eval":
      return runEval(flags);
    case "warmup":
      return cmdWarmup(flags);
    default:
      console.log(
        [
          "usage: cli.ts clear --gtin <GTIN-13> --market UK|US [--json] [--as-of YYYY-MM-DD] [--no-apply] [--straight]",
          "       cli.ts clear --manifest [--roles demo,eval_only] [--out <file>]",
          "       cli.ts replay --as-of YYYY-MM-DD [--scope scenario|all|none] [--until YYYY-MM-DD] [--no-poll] [--json] [--straight]",
          "       cli.ts watch [--until YYYY-MM-DD] [--json] [--straight]",
          "       cli.ts why --gtin <GTIN-13> --market UK|US [--json]",
          "       cli.ts eval [--only E1,E10] [--no-model]",
          "       cli.ts warmup [--no-model] [--wait-s 180]",
          "       cli.ts onboard [gateway.onboard flags: --dry-run --skip-exists --gtin ...]",
        ].join("\n"),
      );
      return cmd === "help" ? 0 : 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  },
);
