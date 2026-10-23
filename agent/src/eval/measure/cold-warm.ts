// Cold versus warm on one SKU, same process, nothing written (`investigate`, not
// `clearWithAgent`). Cold: H-MEM's verified-extraction lookup hidden, so the extraction is a
// model call. Warm: the normal runtime, which reuses the verified extraction H-MEM holds for an
// unchanged label and re-runs the deterministic verifier on it. The numbers in
// docs/eval-report.md section 5 come from this script. Takes data/agent.lock.
//
//   cd agent && npx tsx src/eval/measure/cold-warm.ts [GTIN:UK|US]      (default 0044000882105:US)

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { REPO_ROOT_URL } from "../../config.ts";
import type { HMEM } from "../../memory/hmemFacade.ts";
import type { Market } from "../../policy/decide.ts";
import { investigate, openRuntime, type Runtime } from "../../runtime.ts";

/** E-cov over every claim kind on a card: card lines, firings, review items, claim tests, contradictions. */
export function eCovFull(sets: Record<string, { evidenceIds?: string[] }[]>) {
  const per = Object.fromEntries(Object.entries(sets).map(([k, xs]) => [k, { claims: xs.length, cited: xs.filter((x) => (x.evidenceIds ?? []).length > 0).length }]));
  const claims = Object.values(per).reduce((a, p) => a + p.claims, 0);
  const cited = Object.values(per).reduce((a, p) => a + p.cited, 0);
  return { per, claims, cited, rate: claims ? cited / claims : null };
}

async function main(): Promise<void> {
  const [gtin, market] = (process.argv[2] ?? "0044000882105:US").split(":") as [string, Market];
  const rt = openRuntime({ command: `cold-warm measurement ${gtin} ${market}` });
  const out: { generated_at: string; gtin: string; market: string; model: string; label: string; runs: Record<string, unknown>[] } = {
    generated_at: new Date().toISOString(),
    gtin,
    market,
    model: rt.ollama.model,
    label: "measured",
    runs: [],
  };
  try {
    for (const mode of ["cold", "warm"] as const) {
      if (os.freemem() < 3 * 1024 ** 3) throw new Error(`free RAM ${Math.round(os.freemem() / 1048576)} MiB < 3 GB, stopping`);
      const hmem: HMEM =
        mode === "cold"
          ? new Proxy(rt.hmem, {
              get(t, k) {
                if (k === "findExtraction") return () => null;
                const v = (t as unknown as Record<string | symbol, unknown>)[k];
                return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
              },
            })
          : rt.hmem;
      const t0 = performance.now();
      const { result } = await investigate({ ...rt, hmem } as Runtime, { gtin, market });
      const s = result.loop.summary;
      out.runs.push({
        mode,
        run_id: result.run_id,
        wall_ms: Math.round(performance.now() - t0),
        decision: result.decision.status,
        statement: result.statement?.text ?? null,
        chunks: s.chunks,
        planner_calls: s.planner_calls,
        planner_tokens: { in: s.planner_prompt_tokens, out: s.planner_eval_tokens },
        tool_model_tokens: { in: s.tool_model_tokens_in, out: s.tool_model_tokens_out },
        tool_calls: s.tool_calls,
        fallback_steps: s.fallback_steps,
        extraction_reused: result.extraction.reused,
        chart: result.loop.chart ?? null,
        e_cov_full: eCovFull({ card: result.card, firings: result.decision.firings, review: result.decision.review ?? [], claim_tests: result.claim_tests, contradictions: result.contradictions }),
        quality: result.quality,
      });
      process.stderr.write(`${mode}: ${JSON.stringify(out.runs.at(-1)).slice(0, 400)}\n`);
    }
  } finally {
    rt.close();
  }
  mkdirSync(new URL("data/eval/", REPO_ROOT_URL), { recursive: true });
  const file = fileURLToPath(new URL(`data/eval/cold-warm-${out.generated_at.replace(/[:.]/gu, "-")}.json`, REPO_ROOT_URL));
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 1));
  console.log(`wrote ${file}`);
}

if (process.argv[1] && /measure[\\/]cold-warm\.ts$/u.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });
}
