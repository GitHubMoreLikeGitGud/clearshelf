// Measured full-history baseline for the Markovian planner (docs/eval-report.md section 6).
// Runs real investigations the way `npm run eval` does (investigation only: no decision, queue
// item or World Model decision is written). At each chunk's first planner call it captures the
// prompt a full-history agent would send at that point: the planner system prompt, the goal,
// every earlier model reply and tool digest, and the current host block. This is the text the
// chars/4 estimate in loop/telemetry.ts is computed over. After the run, for every chunk, the
// Markovian first planner request is re-sent unchanged and then the full-history prompt is sent
// with the same request settings (think, schema, options), one call at a time, and Ollama's
// prompt_eval_count, prompt_eval_duration and the wall time are recorded for both. The output
// keeps counts and timings only, never prompt text.
//
//   cd agent && npx tsx src/eval/measure/full-history.ts <gtin> <market> [<gtin> <market>]...

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { REPO_ROOT_URL } from "../../config.ts";
import type { ChatRequest, ChatResult } from "../../llm/ollama.ts";
import { NaiveHistory } from "../../loop/telemetry.ts";
import type { Market } from "../../policy/decide.ts";
import { investigate, openRuntime } from "../../runtime.ts";
import { validateParam } from "../../zetaris/client.ts";

interface Captured {
  system: string;
  user: string;
  /** Index of the next model call, which is this chunk's first Markovian planner call. */
  nextCall: number;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length % 2) throw new Error("usage: full-history.ts <gtin> <market> [<gtin> <market>]...");
  const targets = [];
  for (let i = 0; i < args.length; i += 2) {
    targets.push({ gtin: validateParam("gtin", args[i]!), market: validateParam("market", args[i + 1]!.toUpperCase()) as Market });
  }

  let captured: Captured[] = [];
  let calls: { req: ChatRequest; res: ChatResult }[] = [];
  const estimate = NaiveHistory.prototype.estimate;
  NaiveHistory.prototype.estimate = function (this: NaiveHistory, systemPrompt: string, goal: string, current: string): number {
    const history = (this as unknown as { history: string }).history;
    captured.push({ system: systemPrompt, user: `${goal}\n\n[FULL HISTORY]${history}\n\n${current}`, nextCall: calls.length });
    return estimate.call(this, systemPrompt, goal, current);
  };

  const rt = openRuntime({ command: "eval full-history baseline" });
  const send = rt.ollama.chat.bind(rt.ollama);
  (rt.ollama as { chat: typeof rt.ollama.chat }).chat = async (req) => {
    const res = await send(req);
    calls.push({ req, res });
    return res;
  };
  const runs = [];
  try {
    for (const t of targets) {
      captured = [];
      calls = [];
      const { result } = await investigate(rt, { gtin: t.gtin, market: t.market });
      const chart = result.loop.chart;
      const chunks = [];
      for (const [i, c] of captured.entries()) {
        const mk = calls[c.nextCall];
        if (!mk || mk.req.messages[0]?.content !== c.system) throw new Error(`chunk ${i + 1}: the call after the capture is not the planner call`);
        const opts = { ...mk.req, signal: undefined };
        const again = await send(opts);
        const full = await send({ ...opts, messages: [{ role: "system", content: c.system }, { role: "user", content: c.user }] });
        const numCtx = opts.options?.num_ctx ?? 8192;
        chunks.push({
          chunk: i + 1,
          markovian_prompt_tokens_in_run: mk.res.metrics.promptTokens,
          markovian_prompt_tokens_resent: again.metrics.promptTokens,
          full_history_prompt_tokens: full.metrics.promptTokens,
          full_history_prompt_tokens_estimated_chars4: chart[i]?.naive_prompt_tokens_estimated ?? null,
          full_history_chars: c.system.length + c.user.length,
          full_history_reaches_num_ctx: full.metrics.promptTokens >= numCtx,
          markovian_prompt_eval_ms: Math.round(again.metrics.promptEvalMs),
          full_history_prompt_eval_ms: Math.round(full.metrics.promptEvalMs),
          markovian_wall_ms: Math.round(again.metrics.wallMs),
          full_history_wall_ms: Math.round(full.metrics.wallMs),
          markovian_eval_tokens: again.metrics.evalTokens,
          full_history_eval_tokens: full.metrics.evalTokens,
        });
        process.stderr.write(`${t.gtin} ${t.market} chunk ${i + 1}: markovian ${again.metrics.promptTokens} tok, full history ${full.metrics.promptTokens} tok (estimate ${chart[i]?.naive_prompt_tokens_estimated})\n`);
      }
      // Does prompt_eval_count count every prompt token, or only those not already in the runner's cache?
      const last = captured.at(-1)!;
      const repeatReq = { ...calls[last.nextCall]!.req, signal: undefined, messages: [{ role: "system" as const, content: last.system }, { role: "user" as const, content: last.user }] };
      const repeat = await send(repeatReq);
      const m = sum(chunks.map((c) => c.markovian_prompt_tokens_resent));
      const f = sum(chunks.map((c) => c.full_history_prompt_tokens));
      const e = sum(chunks.map((c) => c.full_history_prompt_tokens_estimated_chars4 ?? 0));
      runs.push({
        gtin: t.gtin,
        market: t.market,
        run_id: result.run_id,
        decision: result.decision.status,
        chunks_count: chunks.length,
        chunks,
        totals: {
          markovian_prompt_tokens: m,
          full_history_prompt_tokens: f,
          full_history_prompt_tokens_estimated_chars4: e,
          saving_measured: f > 0 ? Number((1 - m / f).toFixed(3)) : null,
          estimate_over_measured: f > 0 ? Number((e / f).toFixed(3)) : null,
          markovian_prompt_eval_ms: sum(chunks.map((c) => c.markovian_prompt_eval_ms)),
          full_history_prompt_eval_ms: sum(chunks.map((c) => c.full_history_prompt_eval_ms)),
          markovian_wall_ms: sum(chunks.map((c) => c.markovian_wall_ms)),
          full_history_wall_ms: sum(chunks.map((c) => c.full_history_wall_ms)),
        },
        prompt_count_check: { last_full_history_sent_again_tokens: repeat.metrics.promptTokens, first_send_tokens: chunks.at(-1)!.full_history_prompt_tokens, prompt_eval_ms_again: Math.round(repeat.metrics.promptEvalMs) },
      });
    }
  } finally {
    NaiveHistory.prototype.estimate = estimate;
    try {
      await rt.ollama.unload();
    } catch {
      // nothing loaded
    }
    rt.close();
  }
  const out = {
    generated_at: new Date().toISOString(),
    model: rt.ollama.model,
    label: "measured (Ollama prompt_eval_count, prompt_eval_duration, wall time); the chars/4 column is the estimate it replaces",
    note: "Markovian = each chunk's first planner request, re-sent unchanged after the run; full history = the same request with the full-history prompt. One call at a time on local Ollama.",
    free_ram_mib_at_end: Math.round(os.freemem() / 1048576),
    runs,
  };
  mkdirSync(new URL("data/eval/", REPO_ROOT_URL), { recursive: true });
  const file = fileURLToPath(new URL(`data/eval/full-history-${out.generated_at.replace(/[:.]/gu, "-")}.json`, REPO_ROOT_URL));
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 1));
  console.log(`wrote ${file}`);
}

if (process.argv[1] && /measure[\\/]full-history\.ts$/u.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });
}
