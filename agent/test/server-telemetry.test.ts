import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContractVerifier } from "../src/contract/scout.ts";
import { ApprovalQueue } from "../src/ops/queue.ts";
import { OpsStore } from "../src/ops/store.ts";
import type { Runtime } from "../src/runtime.ts";
import { createServer, EventBus, type ClearShelfServer } from "../src/server.ts";
import { RecallWatch, WatchStateStore, type Catalogue } from "../src/watch/recallWatch.ts";
import { VECTOR_SECRET } from "./fixtures/contract-vector.ts";
import { fakeGateway, stubModel, type FakeWorld } from "./helpers/fakeZetaris.ts";

// Synthetic loop reports, eval results and memories only.
const G = "0012345678905";
const CATALOGUE: Catalogue = { source: "test", replayPicks: [], skus: [{ gtin: G, markets: ["UK"], name: "Test Bar", brand: "Example", brand_token: "example", scenarios: [] }] };
const RUN_A = "r20261001T100000aaaa";
const RUN_B = "r20261001T110000bbbb";
const SWEEP = "w20261001T120000cccc";

let app: ClearShelfServer | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

function chart(n: number) {
  return Array.from({ length: n }, (_, i) => ({ chunk: i + 1, markovian_prompt_tokens_measured: 1200 + i * 10, markovian_prompt_tokens_estimated: 1100, naive_prompt_tokens_estimated: 1000 + i * 600, carryover_tokens_estimated: i * 50 }));
}

function loopFile(dir: string, name: string, runId: string, tps: number | null, mtimeSec: number, gtin = G, market = "UK") {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ run_id: runId, gtin, market, loop: { chunks: 3, chart: chart(3), summary: { median_planner_tokens_per_s: tps } } }), "utf8");
  utimesSync(path, mtimeSec, mtimeSec);
}

async function start(opts: { runtime?: Runtime; loops?: boolean; evals?: boolean; report?: string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cs-tele-"));
  const loopDir = join(root, "markovian");
  const evalDir = join(root, "eval");
  mkdirSync(loopDir);
  mkdirSync(evalDir);
  if (opts.loops !== false) {
    const t = 1_790_000_000;
    loopFile(loopDir, `${RUN_A}-${G}-UK.loop.json`, RUN_A, 100, t);
    loopFile(loopDir, `${RUN_B}-${G}-UK.loop.json`, RUN_B, 140, t + 10);
    loopFile(loopDir, `${SWEEP}.loop.json`, SWEEP, 120, t + 20);
    writeFileSync(join(loopDir, "history.json"), "{}", "utf8");
  }
  if (opts.evals !== false) {
    writeFileSync(join(evalDir, "extraction-2026-10-01.json"), JSON.stringify({ label: "measured", vram: { whole_gpu_mib_peak: 5000, ollama_ps: [{ name: "stub", size_vram_mib: 2000 }], label: "measured (synthetic)" } }), "utf8");
    writeFileSync(join(evalDir, "cold-warm-2026-10-01.json"), JSON.stringify({ gtin: G, market: "UK", label: "measured", runs: [{ mode: "cold", chunks: 4 }, { mode: "warm", chunks: 3 }] }), "utf8");
    writeFileSync(join(evalDir, "scenarios-2026-10-01.json"), JSON.stringify({ results: [] }), "utf8");
  }
  const w: FakeWorld = { opsDir: join(root, "ops"), products: [], fda: [], fsa: [], calls: [] };
  const gateway = fakeGateway(w);
  const verifier = new ContractVerifier(VECTOR_SECRET, "agent-ops", join(root, "contracts"));
  const ops = new OpsStore({ dir: w.opsDir, verifier });
  const queue = new ApprovalQueue(join(root, "approvals"));
  const bus = new EventBus();
  const ollama = stubModel();
  const watch = new RecallWatch({ gateway, ollama, ops, queue, catalogue: CATALOGUE, stateStore: new WatchStateStore(join(root, "watch")), sweepDir: null, evidenceDir: null, emit: (t, d) => bus.publish(t, d), today: () => "2026-10-23" });
  app = createServer({ gateway, ollama, ops, queue, watch, catalogue: CATALOGUE, bus, uiDir: null, runsDir: join(root, "runs"), evidenceDir: join(root, "evidence"), sweepDir: null, loopDir, evalDir, evalReport: opts.report ?? null, runtime: opts.runtime });
  const port = await app.listen(0);
  return `http://127.0.0.1:${port}`;
}

async function get(base: string, path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("GET /api/telemetry", () => {
  it("reports the model, the measured planner speed, the latest loop, VRAM and cold vs warm, each from its file", async () => {
    const base = await start();
    const t = await get(base, "/api/telemetry");
    expect(t.status).toBe(200);
    expect(t.body.model).toBe("stub");
    expect(t.body.model_host).toBe("http://127.0.0.1:11434");
    expect(t.body.cloud_model_calls).toBe(0);
    expect(typeof t.body.refused_non_local_model_hosts).toBe("number");
    expect(t.body.planner_tokens_per_s).toEqual({ value: 120, label: "measured", runs: 3 });
    expect(t.body.latest_loop).toMatchObject({ file: `${SWEEP}.loop.json`, run_id: SWEEP, gtin: G, market: "UK", chunks: 3 });
    expect(t.body.latest_loop.chart).toHaveLength(3);
    expect(t.body.vram).toMatchObject({ whole_gpu_mib_peak: 5000, label: "measured (synthetic)" });
    expect(t.body.cold_warm.runs.map((r: { mode: string }) => r.mode)).toEqual(["cold", "warm"]);
    expect(t.body.eval_file).toEqual({ vram: "extraction-2026-10-01.json", cold_warm: "cold-warm-2026-10-01.json" });
  });

  it("returns null, never 0, for figures that were not measured", async () => {
    const base = await start({ loops: false, evals: false });
    const t = await get(base, "/api/telemetry");
    expect(t.body.planner_tokens_per_s).toBeNull();
    expect(t.body.latest_loop).toBeNull();
    expect(t.body.vram).toBeNull();
    expect(t.body.cold_warm).toBeNull();
  });
});

describe("GET /api/loops/:run/:gtin/:market", () => {
  it("serves the per-SKU loop report, falls back to <run>.loop.json when its GTIN and market match, and 404s otherwise", async () => {
    const base = await start();
    const a = await get(base, `/api/loops/${RUN_A}/${G}/UK`);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ run_id: RUN_A, gtin: G, market: "UK" });
    expect(a.body.loop.chart).toHaveLength(3);
    const s = await get(base, `/api/loops/${SWEEP}/${G}/UK`);
    expect(s.status).toBe(200);
    expect(s.body.run_id).toBe(SWEEP);
    expect((await get(base, `/api/loops/${SWEEP}/${G}/US`)).status).toBe(404);
    expect((await get(base, `/api/loops/r20261001T130000dddd/${G}/UK`)).status).toBe(404);
  });

  it("refuses a bad run id, GTIN or market with 400", async () => {
    const base = await start();
    const bad = await get(base, `/api/loops/..%2F..%2Fsecret/${G}/UK`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("bad_id");
    expect((await get(base, `/api/loops/${RUN_A}/12345/UK`)).body.code).toBe("bad_gtin");
    expect((await get(base, `/api/loops/${RUN_A}/${G}/FR`)).body.code).toBe("bad_market");
  });
});

describe("GET /api/memory/sources", () => {
  it("is not served without the wired runtime", async () => {
    const base = await start();
    const r = await get(base, "/api/memory/sources");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("not_wired");
  });

  it("lists source notes and source documents with their provenance labels, and nothing else", async () => {
    const mem = (id: string, tags: string[], content = `synthetic ${id}`) => ({ id, content, tags, provenance: { origin: "document", learnedAt: Date.UTC(2026, 9, 1), label: `label ${id}` } });
    const records = [mem("mem-1", ["kind:source_note", "source:off"]), mem("mem-2", ["document", "source:zetaris"]), mem("mem-3", ["kind:decision", "gtin:0012345678905"]), mem("mem-4", ["document"])];
    const runtime = { hmem: { store: { all: () => records } } } as unknown as Runtime;
    const base = await start({ runtime });
    const r = await get(base, "/api/memory/sources");
    expect(r.status).toBe(200);
    expect(r.body.memories.map((m: { id: string }) => m.id)).toEqual(["mem-1", "mem-2"]);
    expect(r.body.memories[0]).toEqual({ id: "mem-1", content: "synthetic mem-1", tags: ["kind:source_note", "source:off"], label: "label mem-1", learned_at: "2026-10-01T00:00:00.000Z", superseded_by: null });
  });
});

describe("the evaluation page", () => {
  it("serves docs/eval-report.md as data for the UI, and /eval goes to the Evaluation screen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-report-"));
    const report = join(dir, "eval-report.md");
    writeFileSync(report, "# Synthetic report\n\n| Metric | Result (measured) |\n|---|---|\n| E-cov | 100% |\n", "utf8");
    const base = await start({ report });
    const r = await get(base, "/api/eval/report");
    expect(r.status).toBe(200);
    expect(r.body.file).toBe("docs/eval-report.md");
    expect(r.body.markdown).toContain("| E-cov | 100% |");
    const page = await fetch(`${base}/eval`, { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/#/eval");
  });

  it("404s when there is no report", async () => {
    const base = await start();
    expect((await get(base, "/api/eval/report")).status).toBe(404);
  });
});
