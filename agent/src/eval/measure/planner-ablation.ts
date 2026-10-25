// Planner ablation: the eval's SKU investigations run with the Nemotron planner ("model")
// or with fallbackStep() only ("off": the model is never asked for a plan; ingredient and
// notice extraction still use it). Same investigate() path as `npm run eval`: nothing is
// applied or queued and no decision row is written. E2's SKU is investigated directly as of
// 10 Oct (the replay baseline) and 25 Oct (after the poll's notice), not through a sweep.
// One arm per run; restore data/ between arms so both start from the same stores.
//
//   cd agent && npx tsx src/eval/measure/planner-ablation.ts --planner off|model [--only E1,E3]
//
// Writes data/eval/planner-ablation-<arm>-<time>.json (gitignored): per investigation the
// decision, rules, contradiction kinds, evidence counts by kind, chunks, the tool sequence,
// planner counts and wall time. No product text, no spans, no notice text.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REPO_ROOT_URL } from "../../config.ts";
import { EvidenceStore } from "../../evidence/store.ts";
import type { PlannerMode } from "../../loop/generator.ts";
import { HMEM } from "../../memory/hmemFacade.ts";
import type { Market } from "../../policy/decide.ts";
import { investigate, openRuntime, type Runtime } from "../../runtime.ts";
import { CatalogueWorld } from "../../world/world.ts";
import { checkClear, syntheticGateway } from "../run.ts";

interface Case {
  id: string;
  gtin: string;
  market: Market;
  asOf?: string;
  synthetic?: boolean;
  expect: Record<string, unknown>;
}

export const CASES: Case[] = [
  { id: "E1", gtin: "0816929000119", market: "UK", expect: { status: "HOLD", rules: ["R1", "R4"], claim: { vegan: "NOT_SUPPORTED" }, contradiction_kinds: ["memory_conflict"] } },
  { id: "E2-baseline", gtin: "0850041392103", market: "UK", asOf: "2026-10-10", expect: { status: "HOLD", rules: ["R3"] } },
  { id: "E2-poll", gtin: "0850041392103", market: "UK", asOf: "2026-10-25", expect: { status: "HOLD", rules: ["R1"] } },
  { id: "E3", gtin: "4056489125846", market: "UK", expect: { status: "HOLD", rules: ["R1", "R3"], contradiction_kinds: ["rule_conflict"], statement_includes: ["Cereals containing gluten (wheat)", "Milk", "Soybeans"] } },
  { id: "E4", gtin: "4056489125846", market: "US", expect: { status: "BLOCK", rules: ["R1"], statement_includes: ["Wheat"], statement_excludes: ["Coconut"] } },
  { id: "E5", gtin: "5000169566558", market: "UK", expect: { status: "CLEAR_WITH_STATEMENT", rules: ["R5"], statement_includes: ["May contain", "Milk"] } },
  { id: "E6", gtin: "5059319005492", market: "UK", expect: { status: "HOLD", rules: ["R3"] } },
  { id: "E7", gtin: "4006894512205", market: "UK", expect: { status: "HOLD", rules: ["R3"], statement_includes: ["Cereals containing gluten", "Milk", "Nuts", "Eggs", "Soybeans"] } },
  { id: "E8", gtin: "0012345678905", market: "UK", synthetic: true, expect: { status: "HOLD", rules: ["R4"], contradiction_kinds: ["untrusted_text"] } },
];

const OPTIONAL_TOOLS = new Set(["zetaris.market_list", "world.lookup"]);

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function runCase(rt: Runtime, c: Case, planner: PlannerMode) {
  const t0 = performance.now();
  const seen: string[] = [];
  let target = rt;
  let evidence: EvidenceStore | undefined;
  const origChat = rt.ollama.chat.bind(rt.ollama);
  if (c.synthetic) {
    target = { ...rt, gateway: syntheticGateway(c.gtin), hmem: new HMEM({ actor: "clearshelf-agent" }), world: new CatalogueWorld({ directory: null }), evidenceDir: null, loopDir: null };
    evidence = new EvidenceStore(`e8synthetic-${planner}`, null);
    (rt.ollama as { chat: typeof rt.ollama.chat }).chat = async (req) => {
      for (const m of req.messages) if (m.content.includes("Ignore previous instructions")) seen.push(m.content.includes("<untrusted") ? "wrapped" : "UNWRAPPED");
      return origChat(req);
    };
  }
  try {
    const { result, evidence: ev } = await investigate(target, { gtin: c.gtin, market: c.market, asOf: c.asOf, planner, ...(evidence ? { evidence } : {}) });
    const wall = Math.round(performance.now() - t0);
    const failures: string[] = [];
    const got = checkClear(c.expect, result, failures);
    const byKind: Record<string, number> = {};
    for (const r of ev.all()) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    const s = result.loop.summary;
    const tools = result.loop.tool_calls.map((t) => t.tool);
    return {
      id: c.id,
      gtin: c.gtin,
      market: c.market,
      as_of: result.as_of,
      planner,
      run_id: result.run_id,
      pass: failures.length === 0,
      failures,
      status: result.decision.status,
      rules: [...(got.rules as string[])].sort(),
      contradiction_kinds: [...(got.contradiction_kinds as string[])].sort(),
      claims: got.claims,
      statement: got.statement,
      evidence_records: ev.all().length,
      evidence_by_kind: byKind,
      sql_reads: byKind.zetaris_sql ?? 0,
      chunks: result.loop.chunks,
      checklist_complete: result.loop.checklist_complete,
      tool_calls: tools.length,
      tool_sequence: tools,
      optional_tools: tools.filter((t) => OPTIONAL_TOOLS.has(t)),
      tool_calls_by_model: s.tool_calls_by_model,
      fallback_steps: s.fallback_steps,
      planner_calls: s.planner_calls,
      planner_valid_first_try: s.planner_valid_first_try,
      planner_valid: s.planner_valid,
      planner_prompt_tokens: s.planner_prompt_tokens,
      planner_eval_tokens: s.planner_eval_tokens,
      median_planner_tokens_per_s: s.median_planner_tokens_per_s,
      extraction: { ran: result.extraction.ran, reused: result.extraction.reused, tokens_out: result.extraction.model?.tokens_out ?? 0 },
      notices: result.notices.length,
      e_cov: got.e_cov,
      e_complete: got.e_complete,
      ...(c.synthetic ? { model_saw_injection_text: seen } : {}),
      wall_ms: wall,
    };
  } finally {
    (rt.ollama as { chat: typeof rt.ollama.chat }).chat = origChat;
  }
}

async function main(): Promise<void> {
  const planner = flag("planner") as PlannerMode | undefined;
  if (planner !== "off" && planner !== "model") throw new Error("--planner off|model is required");
  const only = flag("only")?.split(",").map((x) => x.trim().toUpperCase());
  const cases = CASES.filter((c) => !only || only.includes(c.id.toUpperCase()));
  const rt = openRuntime({ command: `planner-ablation ${planner}` });
  const rows: Awaited<ReturnType<typeof runCase>>[] = [];
  const t0 = performance.now();
  const started = new Date().toISOString();
  try {
    for (const c of cases) {
      process.stderr.write(`[${c.id}] ${c.gtin} ${c.market}${c.asOf ? ` as of ${c.asOf}` : ""} planner=${planner}\n`);
      const r = await runCase(rt, c, planner);
      rows.push(r);
      process.stderr.write(
        `  -> ${r.status} [${r.rules.join(",")}] ${r.pass ? "PASS" : `FAIL ${r.failures.join("; ")}`}; evidence ${r.evidence_records} (sql ${r.sql_reads}); chunks ${r.chunks}; tools ${r.tool_calls} (model ${r.tool_calls_by_model}, fallback ${r.fallback_steps}); ${(r.wall_ms / 1000).toFixed(1)} s\n`,
      );
    }
  } finally {
    rt.close();
  }
  mkdirSync(new URL("data/eval/", REPO_ROOT_URL), { recursive: true });
  const file = fileURLToPath(new URL(`data/eval/planner-ablation-${planner}-${started.replace(/[:.]/gu, "-")}.json`, REPO_ROOT_URL));
  writeFileSync(file, `${JSON.stringify({ label: "measured", planner, started_at: started, wall_ms: Math.round(performance.now() - t0), rows }, null, 2)}\n`, "utf8");
  console.log(`wrote ${file}`);
}

if (process.argv[1] && /measure[\\/]planner-ablation\.ts$/u.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });
}
