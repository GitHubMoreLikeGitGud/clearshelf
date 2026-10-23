// Runs SKU clearance through the Markovian investigation loop and prints the card, the
// chunk timeline and the per-chunk token telemetry.
//
//   npx tsx src/loop/run.ts --gtin 0816929000119 --market UK [--as-of YYYY-MM-DD] [--max-chunks 8]
//                           [--think on|off] [--json] [--out <file>] [--min-ram 3072] [--keep-model]
//
// Before the run it waits (up to 10 min) for the host to have --min-ram MiB available,
// and afterwards it unloads the model so the runner's prompt cache does not keep growing
// (unless --keep-model).

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, REPO_ROOT_URL } from "../config.ts";
import { OllamaClient } from "../llm/ollama.ts";
import { DqGate, GatewayClient, validateParam } from "../zetaris/client.ts";
import { EvidenceStore } from "../evidence/store.ts";
import type { Market } from "../policy/decide.ts";
import { investigateSku, type InvestigationResult } from "./investigate.ts";

function flags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

const availableMiB = () => Math.round(os.freemem() / 1048576);

function short(s: string, n: number): string {
  const t = s.replace(/\s+/gu, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function printInvestigation(r: InvestigationResult): string {
  const L = r.loop;
  const out: string[] = [];
  out.push(`ClearShelf investigation  ${r.gtin}  market ${r.market}  run ${r.run_id}  as of ${r.as_of}`);
  out.push(`Product: ${r.product.found ? `"${r.product.name}" (${r.product.brand ?? "no brand"}), lang ${r.product.lang}, ${r.product.has_text ? `ingredient text from ${r.product.text_field}` : "no ingredient text"}` : "not in clearance_usl.product"}`);
  out.push("");
  out.push(`DECISION: ${r.decision.status}${r.decision.pendingSignature ? "  (proposed; needs the officer's signed approval)" : "  (may be applied automatically)"}`);
  for (const f of r.decision.firings) out.push(`  ${f.rule} ${f.effect}: ${short(f.reason, 180)}  [${f.evidenceIds.join(", ")}]`);
  if (r.decision.review.length) out.push(`  + ${r.decision.review.length} review item(s)`);
  if (r.statement) out.push(`Statement draft (${r.market}): ${r.statement.text}`);
  for (const c of r.claim_tests) out.push(`Claim ${c.claim}: ${c.verdict}${c.contradicting.length ? ` (${c.contradicting.join(", ")})` : ""}`);
  out.push("");
  out.push(`Markovian chain: ${L.status}, ${L.chunks} chunk(s), checklist ${L.checklist_complete ? "complete" : "INCOMPLETE"}; config ${JSON.stringify(L.chunk_config)}`);
  for (const t of L.timeline) {
    out.push(`  chunk ${t.chunk} #${t.seq} ${t.source === "model" ? "model   " : "FALLBACK"} ${t.tool} ${JSON.stringify(t.input)}${t.ok ? "" : "  (failed)"}`);
    if (t.thought) out.push(`         thought: ${short(t.thought, 160)}`);
    if (t.fallback_reason) out.push(`         why: ${short(t.fallback_reason, 160)}`);
    out.push(`         -> ${short(t.fact, 200)}`);
  }
  out.push("");
  out.push("Checklist:");
  for (const i of L.checklist) out.push(`  ${i.id.padEnd(22)} ${i.status}${i.note ? ` (${short(i.note, 90)})` : ""}`);
  out.push("");
  out.push("Per chunk (planner tokens measured by Ollama; baseline and carryover estimated chars/4):");
  out.push("  chunk | calls | tools | fallback | prompt tok (1st call) | prompt tok (all) | eval tok | naive est. | carry in/out est. | tool ms | tool-model tok in/out");
  for (const c of L.chunk_telemetry) {
    out.push(
      `  ${String(c.chunk).padStart(5)} | ${String(c.planner_calls).padStart(5)} | ${String(c.tool_calls).padStart(5)} | ${String(c.fallback_steps).padStart(8)} | ${String(c.first_prompt_tokens).padStart(21)} | ${String(c.prompt_tokens).padStart(16)} | ${String(c.eval_tokens).padStart(8)} | ${String(c.naive_prompt_tokens_estimated).padStart(10)} | ${`${c.carryover_in_tokens}/${c.carryover_out_tokens}`.padStart(17)} | ${String(c.tool_latency_ms).padStart(7)} | ${c.tool_model_tokens_in}/${c.tool_model_tokens_out}`,
    );
  }
  const s = L.summary;
  out.push("");
  out.push(
    `Summary: planner calls ${s.planner_calls} (valid ${s.planner_valid}, first try ${s.planner_valid_first_try}, repaired ${s.planner_repaired}); tool calls ${s.tool_calls} (model ${s.tool_calls_by_model}, fallback ${s.fallback_steps}, failed ${s.tool_failures}); planner tokens in/out ${s.planner_prompt_tokens}/${s.planner_eval_tokens} (measured); tool-model tokens in/out ${s.tool_model_tokens_in}/${s.tool_model_tokens_out} (measured); first-call prompts ${s.markovian_prompt_tokens_estimated} vs naive ${s.naive_prompt_tokens_estimated} (estimated), saving ${s.saving_vs_naive_estimated}; max carryover ${s.max_carryover_tokens_estimated} (estimated); median planner tok/s ${s.median_planner_tokens_per_s?.toFixed(1) ?? "n/a"}; wall ${L.wall_ms} ms`,
  );
  out.push(`E-cov ${r.card.filter((c) => c.evidenceIds.length).length}/${r.quality.claims}; E-complete ${r.quality.records - Object.keys(r.quality.incomplete_records).length}/${r.quality.records}. Evidence: ${r.evidence_file ?? "(memory)"}  Loop report: ${L.report_file ?? "(not written)"}`);
  if (r.gaps.length) {
    out.push("Gaps:");
    for (const g of r.gaps) out.push(`  - ${short(g, 200)}`);
  }
  return out.join("\n");
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const f = flags(process.argv.slice(2));
  const gtin = validateParam("gtin", String(f.gtin ?? ""));
  const market = validateParam("market", String(f.market ?? "").toUpperCase()) as Market;
  const asOf = typeof f["as-of"] === "string" ? validateParam("date", f["as-of"]) : undefined;
  const minRam = Number(typeof f["min-ram"] === "string" ? f["min-ram"] : 3072);
  const think = f.think === "off" ? false : f.think === "on" ? true : undefined;

  const ollama = new OllamaClient({ baseUrl: cfg.ollamaUrl, model: cfg.model });
  const loaded = async () => {
    try {
      return (await ollama.loaded()).some((m) => m.name === ollama.model);
    } catch {
      return false;
    }
  };
  // The 4B runner needs about 4.4 GB of host RAM once loaded (measured on this PC).
  const need = (await loaded()) ? minRam : minRam + 4608;
  const w0 = performance.now();
  while (availableMiB() < need && performance.now() - w0 < 600_000) {
    process.stderr.write(`available RAM ${availableMiB()} MiB < ${need} MiB; waiting\n`);
    await new Promise((r) => setTimeout(r, 20_000));
  }
  if (availableMiB() < need) {
    process.stderr.write(`stopping: available RAM stayed below ${need} MiB for 10 min\n`);
    return 3;
  }
  process.stderr.write(`available RAM ${availableMiB()} MiB before the run\n`);

  const gateway = new GatewayClient({ baseUrl: cfg.gatewayUrl });
  const evidence = new EvidenceStore();
  const result = await investigateSku(
    {
      gtin,
      market,
      asOf,
      maxChunks: typeof f["max-chunks"] === "string" ? Number(f["max-chunks"]) : undefined,
      think,
      onEvent: (e) => {
        if (e.type === "tool") process.stderr.write(`  c${e.chunk} ${e.source === "model" ? "model" : "FALLBACK"} ${e.tool} (${e.latency_ms} ms)${e.ok ? "" : " failed"}\n`);
        if (e.type === "planner") process.stderr.write(`  c${e.chunk}.${e.call} planner ${e.valid ? "valid" : "INVALID"} (${e.attempts} repl${e.attempts === 1 ? "y" : "ies"}, ${e.prompt_tokens}/${e.eval_tokens} tok) -> ${e.tool ?? "no action"}\n`);
      },
    },
    { gateway, dq: new DqGate(gateway), ollama, evidence, log: (l) => process.stderr.write(`${l}\n`) },
  );
  process.stderr.write(`available RAM ${availableMiB()} MiB after the run; RAM-guard unloads ${ollama.ramGuardEvents.length}\n`);
  if (!f["keep-model"]) {
    try {
      await ollama.unload();
    } catch {
      // nothing loaded
    }
  }

  const outPath =
    typeof f.out === "string"
      ? f.out
      : fileURLToPath(new URL(`data/eval/loop-${gtin}-${market}-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`, REPO_ROOT_URL));
  mkdirSync(new URL("data/eval/", REPO_ROOT_URL), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(f.json ? JSON.stringify(result, null, 2) : printInvestigation(result));
  console.log(`wrote ${outPath}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
