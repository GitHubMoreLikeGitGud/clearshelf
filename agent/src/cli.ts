// ClearShelf command line.
//
//   npm run clear -- --gtin 0816929000119 --market UK [--json] [--as-of 2026-10-23]
//   npm run clear -- --manifest [--roles demo,eval_only] [--out <file>] [--ram-gate 3072] [--ram-reserve 4608] [--ram-wait-s 1200]
//                                every manifest SKU in each of its markets
//
// Other commands (onboard, watch, replay, eval, warmup) are not wired yet.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, REPO_ROOT_URL } from "./config.ts";
import { OllamaClient } from "./llm/ollama.ts";
import { DqGate, GatewayClient, validateParam } from "./zetaris/client.ts";
import { EvidenceStore, newRunId, type EvidenceRecord } from "./evidence/store.ts";
import { clearSku, type ClearResult, type PipelineDeps } from "./pipeline.ts";
import type { Market } from "./policy/decide.ts";

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
  const evidence = new EvidenceStore();
  const result = await clearSku(gtin, market as Market, deps(evidence), asOf);
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else printResult(result, evidence.all());
  return 0;
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
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "clear":
      return cmdClear(flags);
    case "onboard":
    case "watch":
    case "replay":
    case "eval":
    case "warmup":
      console.error(`"${cmd}" is not wired yet.`);
      return 2;
    default:
      console.log("usage: cli.ts clear --gtin <GTIN-13> --market UK|US [--json] [--as-of YYYY-MM-DD]\n       cli.ts clear --manifest [--roles demo,eval_only] [--out <file>]");
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
