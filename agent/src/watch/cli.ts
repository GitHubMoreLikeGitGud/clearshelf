// Recall-watch commands.
//
//   npx tsx src/watch/cli.ts replay --as-of 2026-10-10 [--scope scenario|all|none] [--until YYYY-MM-DD] [--no-poll] [--no-model] [--json]
//        stands the engine at the as-of date (baseline), then polls up to --until (default today)
//   npx tsx src/watch/cli.ts poll [--until YYYY-MM-DD] [--no-model] [--json]
//   npx tsx src/watch/cli.ts live [--since YYYY-MM-DD]
//   npx tsx src/watch/cli.ts state
//   (add --straight for the Day-1 straight pipeline without H-MEM and the World Model)
//
// agent/src/cli.ts can delegate its `watch` and `replay` commands to watchCommand().

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.ts";
import { loadContractSecret, ContractVerifier } from "../contract/scout.ts";
import { OllamaClient } from "../llm/ollama.ts";
import { ApprovalQueue } from "../ops/queue.ts";
import { OpsStore } from "../ops/store.ts";
import { GatewayClient } from "../zetaris/client.ts";
import { RecallWatch, type SweepResult } from "./recallWatch.ts";
import { agentWatch, openRuntime, type Runtime } from "../runtime.ts";

export function printSweep(r: SweepResult): string {
  const out: string[] = [];
  if (r.banner) out.push(`*** ${r.banner.toUpperCase()} (replayed events, not live) ***`);
  out.push(`Sweep ${r.sweep_id} (${r.kind}, ${r.mode}): notices after ${r.window.after} up to ${r.window.up_to}; ${r.wall_ms} ms`);
  if (r.kind === "poll") {
    out.push(`New notices: ${r.notices.length}`);
    for (const n of r.notices) {
      out.push(
        `  ${n.source.toUpperCase()} ${n.notice_id} ${n.date}${n.classification ? ` ${n.classification}` : ""}${n.status ? ` ${n.status}` : ""}  ${n.title.slice(0, 70)}` +
          `${n.exact_gtins.length ? `  EXACT ${n.exact_gtins.join(",")}` : ""}${n.name_candidates.length ? `  name candidates ${n.name_candidates.join(",")}` : ""}${n.guard.hit ? "  GUARD HIT" : ""}  parsed by ${n.parsed_by.join("+") || "-"}`,
      );
    }
    for (const m of r.exact_matches) out.push(`  exact match ${m.notice_id} -> ${m.gtin} by ${m.by.join("+")}${m.link_written ? " (link written)" : ""}`);
    for (const m of r.name_matches) out.push(`  name-only ${m.source.toUpperCase()} ${m.notice_id} -> ${m.gtin} ${m.market} token "${m.brand_token}" similarity ${m.similarity}${m.confirmed_in_zetaris ? " (confirmed in Zetaris)" : ""} -> review ${m.queue_id}`);
  }
  out.push(`Actions: ${r.actions.length}`);
  for (const a of r.actions) {
    out.push(
      `  ${a.gtin} ${a.market} -> ${a.status} [${a.rules.join(",")}] ${a.applied ? `APPLIED ${a.decision_id} contract ${a.contract_id}; visible in Zetaris: ${a.visible_in_zetaris}` : `queued ${a.queue_id} (needs signed approval)`}`,
    );
    out.push(`      ${a.reason.slice(0, 300)}`);
  }
  out.push(`Closed-loop recheck (Zetaris): ${r.recheck.rows.length} row(s) [${r.recheck.evidence_id ?? "-"}]`);
  for (const x of r.recheck.rows) out.push(`  ${JSON.stringify(x)}`);
  out.push(`Checklist: ${Object.entries(r.checklist).map(([k, v]) => `${k}=${v ? "y" : "n"}`).join(" ")}`);
  out.push(`Model: ${r.model.calls} call(s), tokens in/out ${r.model.tokens_in}/${r.model.tokens_out} (${r.model.label})`);
  for (const g of r.gaps) out.push(`  gap: ${g}`);
  out.push(`Evidence: ${r.evidence_ids.length} record(s) in ${r.evidence_file ?? "(memory)"}`);
  return out.join("\n");
}

/** The Day-2 watch: Markovian clearances with H-MEM and the World Model (runtime.ts). Takes data/agent.lock. */
export function makeAgentWatch(opts: { useModel?: boolean; log?: (l: string) => void; emit?: (type: string, data: Record<string, unknown>) => void } = {}): { watch: RecallWatch; runtime: Runtime } {
  const runtime = openRuntime({ command: `watch ${process.argv.slice(2).join(" ")}`.trim(), log: opts.log });
  return { watch: agentWatch(runtime, { useModel: opts.useModel, emit: opts.emit, log: opts.log }), runtime };
}

/** The straight-pipeline watch (Day 1 clearance, no memory or World Model); --straight. */
export function makeWatch(opts: { useModel?: boolean; log?: (l: string) => void } = {}): RecallWatch {
  const cfg = loadConfig();
  const gateway = new GatewayClient({ baseUrl: cfg.gatewayUrl });
  const verifier = new ContractVerifier(loadContractSecret(), "agent-ops");
  return new RecallWatch({
    gateway,
    ollama: new OllamaClient({ baseUrl: cfg.ollamaUrl, model: cfg.model }),
    ops: new OpsStore({ verifier }),
    queue: new ApprovalQueue(),
    log: opts.log ?? ((l) => process.stderr.write(`${l}\n`)),
    useModel: opts.useModel ?? true,
  });
}

export async function watchCommand(cmd: string, flags: Record<string, string | boolean>): Promise<number> {
  const verbose = !!flags.verbose;
  const emit = (type: string, data: Record<string, unknown>) => {
    if (type === "loop.tool") process.stderr.write(`    [${String(data.gtin)} ${String(data.market)}] chunk ${String(data.chunk)} ${String(data.tool)} (${String(data.source)}) ${data.ok ? "ok" : "FAILED"}: ${String(data.fact).slice(0, 140)}\n`);
    else if (verbose || /^(decision\.|approval\.|memory\.|world\.|watch\.(action|exact_match|name_match|recheck))/u.test(type)) process.stderr.write(`  event ${type} ${JSON.stringify(data).slice(0, 220)}\n`);
  };
  const agent = flags.straight || cmd === "state" || cmd === "live" ? null : makeAgentWatch({ useModel: !flags["no-model"], emit });
  const w = agent?.watch ?? makeWatch({ useModel: !flags["no-model"] });
  try {
    return await runWatch(cmd, flags, w);
  } finally {
    agent?.runtime.close();
  }
}

async function runWatch(cmd: string, flags: Record<string, string | boolean>, w: RecallWatch): Promise<number> {
  const show = (r: SweepResult) => console.log(flags.json ? JSON.stringify(r, null, 2) : printSweep(r));
  switch (cmd) {
    case "replay": {
      const asOf = String(flags["as-of"] ?? "");
      const scope = (typeof flags.scope === "string" ? flags.scope : "scenario") as "scenario" | "all" | "none";
      show(await w.startReplay(asOf, { scope }));
      if (!flags["no-poll"]) show(await w.poll({ until: typeof flags.until === "string" ? flags.until : undefined }));
      return 0;
    }
    case "poll":
    case "watch":
      show(await w.poll({ until: typeof flags.until === "string" ? flags.until : undefined }));
      return 0;
    case "live":
      console.log(JSON.stringify(w.goLive(typeof flags.since === "string" ? flags.since : undefined), null, 1));
      return 0;
    case "state":
      console.log(JSON.stringify(w.state(), null, 1));
      return 0;
    default:
      console.error("usage: watch/cli.ts replay --as-of YYYY-MM-DD [--scope scenario|all|none] [--until YYYY-MM-DD] [--no-poll] | poll [--until] | live [--since] | state");
      return 2;
  }
}

function parseFlags(rest: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[a.slice(2)] = next;
      i++;
    } else flags[a.slice(2)] = true;
  }
  return flags;
}

if (process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(resolve(process.argv[1])).href.toLowerCase()) {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  watchCommand(cmd, parseFlags(rest)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
