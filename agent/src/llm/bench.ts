// Day-0 gates G8 (Nemotron 4B: structured extraction and planning, think on/off)
// and G8b (Nemotron 30B: tokens/s and free host RAM), plus a host-RAM soak.
//
//   npx tsx src/llm/bench.ts g8   [--model nemotron-3-nano:4b] [--think off|on|both] [--jobs ingredient,notice,planner]
//   npx tsx src/llm/bench.ts g8b  [--model nemotron-3-nano:30b] [--force]
//   npx tsx src/llm/bench.ts soak [--model nemotron-3-nano:4b] [--calls 20] [--long 10]
//
// Inputs are read from data/bench/ (gitignored, fetched at dev time by benchFetch.ts).
// Results are written to data/bench/<gate>-<timestamp>.json, including the raw 1 s
// samples. Every number is measured: tokens and durations from Ollama, VRAM from
// nvidia-smi, CPU load and available RAM from the OS, and (on Windows) the private
// and working-set memory of the Ollama serve and runner processes.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import { OllamaClient, type ChatResult, type JsonOutcome } from "./ollama.ts";
import { ADOPTED_JOB_SETTINGS } from "./settings.ts";
import {
  extractionSchema,
  noticeSchema,
  plannerSchema,
  briefSchema,
  plannerSemanticErrors,
  type IngredientExtraction,
  type NoticeExtraction,
  type PlannerOutput,
  type AdjudicationBrief,
} from "./schemas.ts";
import { extractionMessages, noticeMessages, plannerMessages, briefMessages, type BriefInput } from "./prompts.ts";
import { allowedTools, toolSpecs } from "./toolCatalog.ts";
import { INGREDIENT_CASES, NOTICE_CASES, PLANNER_CASES } from "./bench.cases.ts";
import { scoreIngredient, scoreNotice, scorePlanner, prf, sumSets } from "./benchScore.ts";

const ROOT = new URL("../../../", import.meta.url);
const BENCH_DIR = new URL("data/bench/", ROOT);

// ---------- system monitor ----------

interface ProcMem {
  /** Sum over model runner processes (0 when no model is loaded). */
  runnerPrivMiB: number;
  runnerWsMiB: number;
  runners: number;
  servePrivMiB: number | null;
}

interface Sample extends Partial<ProcMem> {
  t: number;
  phase: string;
  vramMiB: number | null;
  gpuUtil: number | null;
  cpuPct: number;
  availMiB: number;
}

/**
 * Ollama process memory on Windows, read once a second by one long-lived PowerShell.
 * The model runner is the `llama-server` child of `ollama serve` on this build (an
 * `ollama runner` process on others); the remaining `ollama` process is the server.
 */
export const PROC_SAMPLER_SCRIPT = [
  "$kind = @{}",
  "while ($true) {",
  "  $out = foreach ($p in @(Get-Process -Name ollama, llama-server -ErrorAction SilentlyContinue)) {",
  "    if (-not $kind.ContainsKey($p.Id)) {",
  "      if ($p.ProcessName -eq 'llama-server') { $kind[$p.Id] = 'runner' } else {",
  "        $cl = (Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.Id)\" -ErrorAction SilentlyContinue).CommandLine",
  "        if ($null -eq $cl) { continue }",
  "        $kind[$p.Id] = if ($cl -like '* runner *') { 'runner' } else { 'serve' }",
  "      }",
  "    }",
  "    '{0},{1},{2},{3}' -f $kind[$p.Id], $p.Id, $p.PrivateMemorySize64, $p.WorkingSet64",
  "  }",
  "  [Console]::Out.WriteLine('procs ' + ($out -join ';'))",
  "  [Console]::Out.Flush()",
  "  Start-Sleep -Milliseconds 1000",
  "}",
].join("\n");

class OllamaProcSampler {
  latest: ProcMem | null = null;
  private ps: ChildProcess | null = null;

  start(): void {
    if (process.platform !== "win32") return;
    const encoded = Buffer.from(PROC_SAMPLER_SCRIPT, "utf16le").toString("base64");
    this.ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    this.ps.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("procs")) continue;
        const mem: ProcMem = { runnerPrivMiB: 0, runnerWsMiB: 0, runners: 0, servePrivMiB: null };
        for (const entry of line.slice(5).trim().split(";").filter(Boolean)) {
          const [kind, , priv, ws] = entry.split(",");
          const privMiB = Number(priv) / 1048576;
          if (kind === "runner") {
            mem.runners++;
            mem.runnerPrivMiB += privMiB;
            mem.runnerWsMiB += Number(ws) / 1048576;
          } else {
            mem.servePrivMiB = privMiB;
          }
        }
        this.latest = mem;
      }
    });
  }

  stop(): void {
    this.ps?.kill();
  }
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

class Monitor {
  samples: Sample[] = [];
  phase = "idle";
  private gpu: { vram: number; util: number } | null = null;
  private smi: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private last = cpuTimes();
  readonly procs = new OllamaProcSampler();
  onSample: ((s: Sample) => void) | null = null;

  start(): void {
    this.procs.start();
    this.smi = spawn("nvidia-smi", ["--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader,nounits", "-lms", "1000"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let buf = "";
    this.smi.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const [v, u] = line.split(",").map((x) => Number(x.trim()));
        if (Number.isFinite(v)) this.gpu = { vram: v, util: Number.isFinite(u) ? u : 0 };
      }
    });
    this.timer = setInterval(() => {
      const now = cpuTimes();
      const dTotal = now.total - this.last.total;
      const cpuPct = dTotal > 0 ? 100 * (1 - (now.idle - this.last.idle) / dTotal) : 0;
      this.last = now;
      const s: Sample = {
        t: Date.now(),
        phase: this.phase,
        vramMiB: this.gpu?.vram ?? null,
        gpuUtil: this.gpu?.util ?? null,
        cpuPct,
        availMiB: os.freemem() / 1048576,
        ...(this.procs.latest ?? {}),
      };
      this.samples.push(s);
      this.onSample?.(s);
    }, 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.smi?.kill();
    this.procs.stop();
  }

  stats(phasePrefix: string): {
    samples: number;
    vramPeakMiB: number | null;
    vramMedianMiB: number | null;
    gpuUtilMean: number | null;
    cpuMeanPct: number | null;
    cpuMaxPct: number | null;
    availMinMiB: number | null;
    runnerPrivMaxMiB: number | null;
  } {
    const s = this.samples.filter((x) => x.phase.startsWith(phasePrefix));
    const v = s.map((x) => x.vramMiB).filter((x): x is number => x !== null);
    const g = s.map((x) => x.gpuUtil).filter((x): x is number => x !== null);
    const r = s.map((x) => x.runnerPrivMiB).filter((x): x is number => x !== undefined);
    return {
      samples: s.length,
      vramPeakMiB: v.length ? Math.max(...v) : null,
      vramMedianMiB: v.length ? median(v) : null,
      gpuUtilMean: g.length ? mean(g) : null,
      cpuMeanPct: s.length ? mean(s.map((x) => x.cpuPct)) : null,
      cpuMaxPct: s.length ? Math.max(...s.map((x) => x.cpuPct)) : null,
      availMinMiB: s.length ? Math.min(...s.map((x) => x.availMiB)) : null,
      runnerPrivMaxMiB: r.length ? round(Math.max(...r), 0) : null,
    };
  }

  /** Raw samples, rounded for the result file. */
  rawSamples(): Sample[] {
    return this.samples.map((s) => ({
      ...s,
      cpuPct: round(s.cpuPct, 1) as number,
      availMiB: round(s.availMiB, 0) as number,
      runnerPrivMiB: s.runnerPrivMiB === undefined ? undefined : (round(s.runnerPrivMiB, 0) as number),
      runnerWsMiB: s.runnerWsMiB === undefined ? undefined : (round(s.runnerWsMiB, 0) as number),
      servePrivMiB: s.servePrivMiB == null ? s.servePrivMiB : (round(s.servePrivMiB, 0) as number),
    }));
  }
}

/** Top CPU consumers over a 3 s window, as % of all logical cores. */
function topProcesses(): Promise<string[]> {
  const ps =
    "$n=[Environment]::ProcessorCount; (Get-Counter '\\Process(*)\\% Processor Time' -SampleInterval 3 -MaxSamples 1).CounterSamples | " +
    "Where-Object { $_.InstanceName -notin @('_total','idle') } | Sort-Object CookedValue -Descending | Select-Object -First 8 | " +
    "ForEach-Object { '{0} {1:N1}%' -f $_.InstanceName, ($_.CookedValue / $n) }";
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-Command", ps], { timeout: 30_000 }, (err, stdout) => {
      resolve(err ? [`unavailable: ${err.message}`] : stdout.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean));
    });
  });
}

function gpuFreeMiB(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=memory.free", "--format=csv,noheader,nounits"], (err, out) =>
      resolve(err ? null : Number(out.trim().split(/\r?\n/u)[0])),
    );
  });
}

function gpuInfo(): Promise<string> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"], (err, out) =>
      resolve(err ? "unavailable" : out.trim()),
    );
  });
}

// ---------- helpers ----------

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (x: number | null, d = 1): number | null => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface OffProduct {
  ingredients_text?: string;
}
interface FdaRecord {
  recall_number: string;
  product_description: string;
  reason_for_recall: string;
  code_info: string;
  recalling_firm: string;
}

function loadInputs(): { off: Record<string, OffProduct>; fda: Map<string, FdaRecord> } {
  const off = JSON.parse(readFileSync(new URL("off.json", BENCH_DIR), "utf8")) as Record<string, OffProduct>;
  const fdaList = JSON.parse(readFileSync(new URL("fda_200.json", BENCH_DIR), "utf8")) as FdaRecord[];
  return { off, fda: new Map(fdaList.map((r) => [r.recall_number, r])) };
}

function noticeSourceText(r: FdaRecord): string {
  return [r.recalling_firm, r.product_description, r.reason_for_recall, r.code_info].join("\n");
}

interface CallRecord {
  job: "ingredient" | "notice" | "planner" | "brief";
  caseId: string;
  model: string;
  think: boolean;
  validFirst: boolean;
  validFinal: boolean;
  attempts: number;
  errors: string[];
  doneReasons: (string | null)[];
  wallMs: number;
  evalTokens: number;
  promptTokens: number;
  evalMs: number;
  tokensPerSecond: number | null;
  thinkingChars: number;
  score?: unknown;
  output?: unknown;
}

function record<T>(job: CallRecord["job"], caseId: string, model: string, think: boolean, outcome: JsonOutcome<T>): CallRecord {
  const first = outcome.attempts[0];
  const rs: ChatResult[] = outcome.attempts.map((a) => a.result);
  const evalTokens = rs.reduce((a, r) => a + r.metrics.evalTokens, 0);
  const evalMs = rs.reduce((a, r) => a + r.metrics.evalMs, 0);
  return {
    job,
    caseId,
    model,
    think,
    validFirst: first.parseError === null && first.schemaErrors.length === 0,
    validFinal: outcome.ok,
    attempts: outcome.attempts.length,
    errors: outcome.ok ? [] : outcome.errors.slice(0, 5),
    doneReasons: rs.map((r) => r.doneReason),
    wallMs: rs.reduce((a, r) => a + r.metrics.wallMs, 0),
    evalTokens,
    promptTokens: rs.reduce((a, r) => a + r.metrics.promptTokens, 0),
    evalMs,
    tokensPerSecond: evalMs > 0 ? evalTokens / (evalMs / 1000) : null,
    thinkingChars: rs.reduce((a, r) => a + (r.thinking?.length ?? 0), 0),
    output: outcome.ok ? outcome.value : outcome.attempts.at(-1)?.result.content.slice(0, 2000),
  };
}

function summarise(calls: CallRecord[]) {
  if (calls.length === 0) return { n: 0 };
  const wall = calls.map((c) => c.wallMs);
  const tps = calls.map((c) => c.tokensPerSecond).filter((x): x is number => x !== null);
  return {
    n: calls.length,
    validFirst: calls.filter((c) => c.validFirst).length,
    validFinal: calls.filter((c) => c.validFinal).length,
    wallMsMedian: round(median(wall), 0),
    wallMsP95: round(pct(wall, 95), 0),
    wallMsMax: round(Math.max(...wall), 0),
    tokensPerSecondMedian: round(tps.length ? median(tps) : null),
    tokensPerSecondAggregate: round(
      calls.reduce((a, c) => a + c.evalTokens, 0) / (calls.reduce((a, c) => a + c.evalMs, 0) / 1000),
    ),
    evalTokensMedian: round(median(calls.map((c) => c.evalTokens)), 0),
    promptTokensMedian: round(median(calls.map((c) => c.promptTokens)), 0),
  };
}

// ---------- G8 ----------

async function runG8(model: string): Promise<void> {
  const client = new OllamaClient({ model });
  const { off, fda } = loadInputs();
  const env = {
    startedAt: new Date().toISOString(),
    model,
    ollama: await (await fetch(`${client.baseUrl}/api/version`)).json(),
    gpu: await gpuInfo(),
    logicalCores: os.cpus().length,
    totalRamMiB: Math.round(os.totalmem() / 1048576),
    options: { temperature: 0, seed: 7, num_ctx: 8192, keep_alive: "30m", num_predict: { thinkOff: 1536, thinkOn: 4096 } },
  };
  console.log("env", env);

  for (const m of await client.loaded()) await client.unload(m.name);
  const mon = new Monitor();
  mon.start();
  const topSnapshots: Record<string, string[]> = {};
  mon.phase = "idle";
  topSnapshots.idle = await topProcesses();
  await sleep(4000);

  const numPredict = (think: boolean) => (think ? 4096 : 1536);
  const calls: CallRecord[] = [];

  const ingredientCall = async (i: number, think: boolean) => {
    const c = INGREDIENT_CASES[i];
    const text = off[c.gtin]?.ingredients_text;
    if (!text) throw new Error(`no ingredient text for ${c.gtin} in data/bench/off.json`);
    const outcome = await client.chatJson<IngredientExtraction>({
      messages: extractionMessages(text),
      schema: extractionSchema,
      think,
      options: { num_predict: numPredict(think) },
    });
    const rec = record("ingredient", c.id, model, think, outcome);
    if (outcome.ok) rec.score = scoreIngredient(outcome.value, c, text);
    return rec;
  };
  const noticeCall = async (i: number, think: boolean) => {
    const c = NOTICE_CASES[i];
    const r = fda.get(c.recall_number);
    if (!r) throw new Error(`no FDA record ${c.recall_number} in data/bench/fda_200.json`);
    const outcome = await client.chatJson<NoticeExtraction>({
      messages: noticeMessages({ id: r.recall_number, ...r }),
      schema: noticeSchema,
      think,
      options: { num_predict: numPredict(think) },
    });
    const rec = record("notice", c.id, model, think, outcome);
    if (outcome.ok) rec.score = scoreNotice(outcome.value, c, noticeSourceText(r));
    return rec;
  };
  const plannerCall = async (i: number, think: boolean) => {
    const c = PLANNER_CASES[i];
    const tools = allowedTools(c.chain, c.checklist, c.noticeSource);
    const outcome = await client.chatJson<PlannerOutput>({
      messages: plannerMessages({
        chain: c.chain,
        subject: c.subject,
        market: c.market,
        checklist: c.checklist,
        tools: toolSpecs(c.chain, tools),
        evidence: c.evidence,
        memory: c.memory,
      }),
      schema: plannerSchema(c.chain, tools, c.evidence.map((e) => e.id)),
      semanticCheck: plannerSemanticErrors,
      think,
      options: { num_predict: numPredict(think) },
    });
    const rec = record("planner", c.id, model, think, outcome);
    if (outcome.ok) rec.score = scorePlanner(outcome.value, c);
    return rec;
  };

  // Warm-up (excluded): loads the model and compiles both grammars.
  mon.phase = "warmup";
  await ingredientCall(0, false);
  await plannerCall(0, true);

  const thinkArg = argValue("--think") ?? "both";
  const thinks = thinkArg === "off" ? [false] : thinkArg === "on" ? [true] : [false, true];
  const jobs = new Set((argValue("--jobs") ?? "ingredient,notice,planner").split(","));
  for (const think of thinks) {
    const tag = `think-${think ? "on" : "off"}`;
    mon.phase = `run:${tag}:extraction`;
    const snap = topProcesses().then((t) => (topSnapshots[`${tag}:extraction`] = t));
    for (let i = 0; i < INGREDIENT_CASES.length && jobs.has("ingredient"); i++) {
      const r = await ingredientCall(i, think);
      calls.push(r);
      console.log(tag, r.caseId, r.validFirst ? "valid" : "INVALID", Math.round(r.wallMs), "ms", round(r.tokensPerSecond), "tok/s");
    }
    for (let i = 0; i < NOTICE_CASES.length && jobs.has("notice"); i++) {
      const r = await noticeCall(i, think);
      calls.push(r);
      console.log(tag, r.caseId, r.validFirst ? "valid" : "INVALID", Math.round(r.wallMs), "ms", round(r.tokensPerSecond), "tok/s");
    }
    await snap;
    mon.phase = `run:${tag}:planner`;
    for (let i = 0; i < PLANNER_CASES.length && jobs.has("planner"); i++) {
      const r = await plannerCall(i, think);
      calls.push(r);
      console.log(tag, r.caseId, r.validFirst ? "valid" : "INVALID", Math.round(r.wallMs), "ms", round(r.tokensPerSecond), "tok/s", (r.score as { tool?: string } | undefined)?.tool);
    }
  }
  mon.phase = "after";
  await sleep(1500);
  mon.stop();

  const loadedAfter = await client.loaded();
  const result = {
    gate: "G8",
    env,
    selection: { think: thinkArg, jobs: [...jobs] },
    loadedAfter,
    topProcesses: topSnapshots,
    monitor: {
      idle: mon.stats("idle"),
      run: mon.stats("run:"),
      thinkOff: mon.stats("run:think-off"),
      thinkOn: mon.stats("run:think-on"),
    },
    summary: buildG8Summary(calls),
    ramGuardEvents: client.ramGuardEvents,
    calls,
    samples: mon.rawSamples(),
    finishedAt: new Date().toISOString(),
  };
  writeResult("g8", result);
  console.log(JSON.stringify({ monitor: result.monitor, summary: result.summary }, null, 2));
}

function buildG8Summary(calls: CallRecord[]) {
  const out: Record<string, unknown> = {};
  for (const think of [false, true]) {
    const tag = think ? "thinkOn" : "thinkOff";
    if (!calls.some((c) => c.think === think)) continue;
    const of = (job: CallRecord["job"]) => calls.filter((c) => c.job === job && c.think === think);
    const ing = of("ingredient");
    const not = of("notice");
    const pl = of("planner");
    const ingScores = ing.map((c) => c.score as ReturnType<typeof scoreIngredient> | undefined).filter((s) => s !== undefined);
    const notScores = not.map((c) => c.score as ReturnType<typeof scoreNotice> | undefined).filter((s) => s !== undefined);
    const plScores = pl.map((c) => c.score as ReturnType<typeof scorePlanner> | undefined).filter((s) => s !== undefined);
    const pairs = sumSets(ingScores.map((s) => s.pairs));
    const groups = sumSets(ingScores.map((s) => s.groups));
    const upcs = sumSets(notScores.map((s) => s.upcs));
    const allergens = sumSets(notScores.map((s) => s.allergens));
    const lots = sumSets(notScores.map((s) => s.lots));
    const extraction = [...ing, ...not];
    out[tag] = {
      all: summarise([...extraction, ...pl]),
      extraction: summarise(extraction),
      planner: summarise(pl),
      ingredient: {
        ...summarise(ing),
        pairs: { ...pairs, ...prf(pairs) },
        groups: { ...groups, ...prf(groups) },
        spans: ingScores.reduce((a, s) => a + s.spans, 0),
        spansDroppedUngrounded: ingScores.reduce((a, s) => a + s.dropped, 0),
        trapFalseAlarms: ingScores.reduce((a, s) => a + s.trapFalseAlarms, 0),
      },
      notice: {
        ...summarise(not),
        upcs: { ...upcs, ...prf(upcs) },
        upcsInvented: notScores.reduce((a, s) => a + s.upcsInvented.length, 0),
        allergens: { ...allergens, ...prf(allergens) },
        lots: { ...lots, ...prf(lots) },
        reasonOk: notScores.filter((s) => s.reasonOk).length,
      },
      plannerScores: {
        scored: plScores.length,
        progress: plScores.filter((s) => s.progress).length,
        firstOpen: plScores.filter((s) => s.firstOpen).length,
        doneOk: plScores.filter((s) => s.doneOk).length,
        inputOk: plScores.filter((s) => s.inputOk === true).length,
        inputApplicable: plScores.filter((s) => s.inputOk !== null).length,
        checklistEchoOk: plScores.filter((s) => s.checklistEchoOk).length,
        evidenceIdsOk: plScores.filter((s) => s.evidenceIdsOk).length,
        contradictionSurfaced: plScores.filter((s) => s.contradictionSurfaced === true).length,
        contradictionExpected: plScores.filter((s) => s.contradictionSurfaced !== null).length,
        thoughtOk: plScores.filter((s) => s.thoughtOk).length,
      },
    };
  }
  return out;
}

// ---------- G8b ----------

// Constructed adjudication inputs: the FDA rows, product fields and the coconut rule
// come from the fetched records, but the DQ results, extraction/verifier outcomes and
// policy proposals are hand-built states (no pipeline existed yet). Synthetic bench
// input only; never shown as a real run.
const BRIEF_INPUTS: BriefInput[] = [
  {
    subject: "0816929000119 (Frankie's Organic Plant-Based Puffs Vegan Cheddar)",
    market: "UK",
    proposed: "HOLD (R1 exact-GTIN recall Terminated within 24 months; R3 DQ has_ingredients; R4 vegan claim NOT SUPPORTED)",
    evidence: [
      { id: "ev-b1-01", summary: "product data: labels en:vegan; declared allergens none; no ingredient text; label language fr" },
      { id: "ev-b1-02", summary: "FDA H-1328-2026, Class I, Terminated, reported 2026-09-09: 'Product tested positive for undeclared milk.' UPC 816929000119" },
      { id: "ev-b1-03", summary: "DQ gate: has_ingredients invalid; english_label invalid" },
    ],
  },
  {
    subject: "4056489125846 (Lidl Eridanous shortbread with coconut sprinkles)",
    market: "US",
    proposed: "BLOCK (R1 exact-GTIN recall Ongoing, US market)",
    evidence: [
      { id: "ev-b2-01", summary: "FDA H-1275-2026, Class II, Ongoing, reported 2026-09-02: units shipped to US stores carry only foreign-language labels; undeclared wheat, soy, milk, eggs and tree nut (coconut)" },
      { id: "ev-b2-02", summary: "extraction: wheat, milk and soy verified as contains; coconut is not a tree nut under FDA Q&A Edition 5 (January 2025)" },
      { id: "ev-b2-03", summary: "DQ gate: FK orphan US:gluten_cereal (the US list names wheat, not gluten)" },
    ],
  },
  {
    subject: "4056489125846 (Lidl Eridanous shortbread with coconut sprinkles)",
    market: "UK",
    proposed: "HOLD (R3 english_label; R1 US recall of this GTIN, UK units not covered by the notice)",
    evidence: [
      { id: "ev-b3-01", summary: "FDA H-1275-2026, Ongoing, distribution US retail stores only" },
      { id: "ev-b3-02", summary: "extraction: wheat, milk and soy verified as contains; one unreadable fragment before '***' may hide egg" },
      { id: "ev-b3-03", summary: "DQ gate: english_label invalid (label text mostly French)" },
    ],
  },
];

async function runG8b(model: string, baselineModel: string): Promise<void> {
  const client = new OllamaClient({ model });
  const env = {
    startedAt: new Date().toISOString(),
    model,
    baselineModel,
    ollama: await (await fetch(`${client.baseUrl}/api/version`)).json(),
    gpu: await gpuInfo(),
    totalRamMiB: Math.round(os.totalmem() / 1048576),
    options: { temperature: 0, seed: 7, num_ctx: 8192, num_predict: { thinkOff: 400, thinkOn: 2048 } },
  };
  console.log("env", env);
  for (const m of await client.loaded()) await client.unload(m.name);
  const mon = new Monitor();
  const ac = new AbortController();
  let lowStreak = 0;
  let aborted = "";
  // Watchdog: a 30B partial offload must not push the host into heavy paging.
  mon.onSample = (s) => {
    if (s.phase.startsWith("30b") && s.availMiB < 2048) lowStreak++;
    else lowStreak = 0;
    if (lowStreak >= 3 && !ac.signal.aborted) {
      aborted = `watchdog: available RAM below 2 GB for 3 s (last ${Math.round(s.availMiB)} MiB); 30B run stopped and unloaded`;
      ac.abort();
    }
  };
  mon.start();
  const top: Record<string, string[]> = {};
  mon.phase = "idle";
  top.idle = await topProcesses();
  await sleep(4000);

  const calls: CallRecord[] = [];
  const briefCall = async (m: string, i: number, think: boolean, phase: string) => {
    mon.phase = phase;
    const outcome = await client.chatJson<AdjudicationBrief>({
      model: m,
      messages: briefMessages(BRIEF_INPUTS[i]),
      schema: briefSchema,
      think,
      keepAlive: "5m",
      options: { num_predict: think ? 2048 : 400 },
      timeoutMs: 600_000,
      signal: ac.signal,
    }, 1);
    const rec = record("brief", `brief:${i + 1}`, m, think, outcome);
    const first = outcome.attempts[0].result;
    console.log(phase, rec.caseId, think ? "think-on" : "think-off", rec.validFirst ? "valid" : "INVALID", Math.round(rec.wallMs), "ms", round(rec.tokensPerSecond), "tok/s", "load", Math.round(first.metrics.loadMs), "ms");
    return { rec, loadMs: first.metrics.loadMs };
  };

  // Baseline: the same briefs on the 4B, think off then on.
  for (const think of [false, true]) {
    for (let i = 0; i < BRIEF_INPUTS.length; i++) {
      calls.push((await briefCall(baselineModel, i, think, `4b:${!think && i === 0 ? "load" : "run"}`)).rec);
    }
  }
  const loaded4b = await client.loaded();
  await client.unload(baselineModel);
  mon.phase = "between";
  await sleep(5000);
  const availBefore30b = os.freemem() / 1048576;

  // Pre-check: weights that do not fit in free VRAM stay in host RAM. If what would
  // be left is already under the gate's 3 GB, loading only adds paging pressure for
  // everything else on the machine, so the load is skipped unless --force is given.
  const tags = (await (await fetch(`${client.baseUrl}/api/tags`)).json()) as { models: Array<{ name: string; size: number }> };
  const modelMiB = (tags.models.find((m) => m.name === model)?.size ?? 0) / 1048576;
  const freeVramMiB = await gpuFreeMiB();
  const vramReserveMiB = 1024;
  const estHostMiB = Math.max(0, modelMiB - Math.max(0, (freeVramMiB ?? 0) - vramReserveMiB));
  const precheck = {
    label: "estimated",
    modelMiB: Math.round(modelMiB),
    freeVramMiB,
    vramReserveMiB,
    estHostResidentMiB: Math.round(estHostMiB),
    availRamMiB: Math.round(availBefore30b),
    projectedFreeRamMiB: Math.round(availBefore30b - estHostMiB),
    gateMinFreeRamMiB: 3072,
    pass: availBefore30b - estHostMiB >= 3072,
    forced: process.argv.includes("--force"),
  };
  console.log("30B pre-check", precheck);

  let load30bMs: number | null = null;
  let loaded30b: Awaited<ReturnType<OllamaClient["loaded"]>> = [];
  const thirtyB = async () => {
    const first = await briefCall(model, 0, false, "30b:load");
    calls.push(first.rec);
    load30bMs = first.loadMs;
    loaded30b = await client.loaded();
    top["30b:run"] = await topProcesses();
    for (let i = 1; i < BRIEF_INPUTS.length; i++) calls.push((await briefCall(model, i, false, "30b:run")).rec);
    calls.push((await briefCall(model, 0, true, "30b:run-think")).rec);
  };
  const aborter = new Promise<never>((_, reject) => ac.signal.addEventListener("abort", () => reject(new Error(aborted))));
  let error: string | null = null;
  try {
    if (!precheck.pass && !precheck.forced) {
      throw new Error(`pre-check: projected free RAM ${precheck.projectedFreeRamMiB} MiB is under 3072 MiB; 30B not loaded (use --force to load anyway)`);
    }
    await Promise.race([thirtyB(), aborter]);
  } catch (e) {
    error = (e as Error).message;
    console.error("30B run stopped:", error);
  }
  mon.phase = "unload";
  await client.unload(model).catch((e) => console.error("unload failed", e));
  await sleep(5000);
  mon.phase = "after";
  await sleep(2000);
  mon.stop();

  const of = (m: string, think?: boolean) => calls.filter((c) => c.model === m && (think === undefined || c.think === think));
  const result = {
    gate: "G8b",
    env,
    error,
    topProcesses: top,
    loaded4b,
    loaded30b,
    load30bMs,
    precheck,
    availBefore30bMiB: Math.round(availBefore30b),
    monitor: {
      idle: mon.stats("idle"),
      run4b: mon.stats("4b:"),
      load30b: mon.stats("30b:load"),
      run30b: mon.stats("30b:run"),
      all30b: mon.stats("30b"),
      after: mon.stats("after"),
    },
    summary: {
      baseline4bThinkOff: summarise(of(baselineModel, false)),
      baseline4bThinkOn: summarise(of(baselineModel, true)),
      model30bThinkOff: of(model, false).length ? summarise(of(model, false)) : null,
      model30bThinkOn: of(model, true).length ? summarise(of(model, true)) : null,
    },
    calls,
    samples: mon.rawSamples(),
    finishedAt: new Date().toISOString(),
  };
  writeResult("g8b", result);
  console.log(JSON.stringify({ error, availBefore30bMiB: result.availBefore30bMiB, load30bMs, loaded30b, monitor: result.monitor, summary: result.summary }, null, 2));
}

// ---------- Host-RAM soak ----------

/**
 * Host-RAM soak: `--calls` planner steps at the adopted settings (think on unless
 * `--think off`, num_predict 2048), cycling the 10 planner cases, then `--long` think-on
 * ingredient calls at num_predict 4096 with one retry,
 * the long generations that preceded the RAM drop in the first G8 run. Ollama process
 * memory is sampled every second and saved. The client's RAM guard stays on, and a
 * watchdog stops the soak if available RAM stays under 1.5 GB for 3 s.
 *
 * Growth counts as reproduced (set before the run) when the runner's private memory
 * rises more than 2,048 MiB above its level after the first soak call, or the guard
 * or the watchdog fires.
 */
async function runSoak(model: string): Promise<void> {
  const plannerCalls = Number(argValue("--calls") ?? 20);
  const longCalls = Number(argValue("--long") ?? 10);
  const plannerThink = argValue("--think") !== "off";
  const client = new OllamaClient({ model });
  const { off } = loadInputs();
  const env = {
    startedAt: new Date().toISOString(),
    model,
    ollama: await (await fetch(`${client.baseUrl}/api/version`)).json(),
    gpu: await gpuInfo(),
    totalRamMiB: Math.round(os.totalmem() / 1048576),
    options: {
      temperature: 0,
      seed: 7,
      num_ctx: 8192,
      planner: { ...ADOPTED_JOB_SETTINGS.planner, think: plannerThink },
      long: { think: true, num_predict: 4096, attempts: 2 },
    },
    selection: { plannerCalls, longCalls, plannerThink },
  };
  console.log("env", env);
  for (const m of await client.loaded()) await client.unload(m.name);

  const WATCHDOG_MIB = 1536;
  const mon = new Monitor();
  const ac = new AbortController();
  let lowStreak = 0;
  let watchdog: string | null = null;
  mon.onSample = (s) => {
    lowStreak = s.phase.startsWith("soak") && s.availMiB < WATCHDOG_MIB ? lowStreak + 1 : 0;
    if (lowStreak >= 3 && !ac.signal.aborted) {
      watchdog = `available RAM under ${WATCHDOG_MIB} MiB for 3 s (last ${Math.round(s.availMiB)} MiB); soak stopped`;
      ac.abort();
    }
  };
  mon.start();
  mon.phase = "idle";
  await sleep(5000);

  const calls: Array<CallRecord & { runnerPrivBeforeMiB: number | null; runnerPrivAfterMiB: number | null; availAfterMiB: number }> = [];
  const runnerPriv = (): number | null => (mon.procs.latest ? Math.round(mon.procs.latest.runnerPrivMiB) : null);
  const step = async <T>(job: CallRecord["job"], caseId: string, think: boolean, run: () => Promise<JsonOutcome<T>>) => {
    const before = runnerPriv();
    const outcome = await run();
    await sleep(1100);
    const rec = {
      ...record(job, caseId, model, think, outcome),
      output: undefined,
      runnerPrivBeforeMiB: before,
      runnerPrivAfterMiB: runnerPriv(),
      availAfterMiB: Math.round(os.freemem() / 1048576),
    };
    calls.push(rec);
    console.log(mon.phase, caseId, rec.validFinal ? "valid" : "INVALID", rec.evalTokens, "tok", "runner", rec.runnerPrivAfterMiB, "MiB", "avail", rec.availAfterMiB, "MiB");
  };

  let error: string | null = null;
  try {
    mon.phase = `soak:planner-think-${plannerThink ? "on" : "off"}`;
    for (let i = 0; i < plannerCalls && !ac.signal.aborted; i++) {
      const c = PLANNER_CASES[i % PLANNER_CASES.length];
      const tools = allowedTools(c.chain, c.checklist, c.noticeSource);
      await step("planner", c.id, plannerThink, () =>
        client.chatJson<PlannerOutput>({
          messages: plannerMessages({ chain: c.chain, subject: c.subject, market: c.market, checklist: c.checklist, tools: toolSpecs(c.chain, tools), evidence: c.evidence, memory: c.memory }),
          schema: plannerSchema(c.chain, tools, c.evidence.map((e) => e.id)),
          semanticCheck: plannerSemanticErrors,
          think: plannerThink,
          options: { num_predict: ADOPTED_JOB_SETTINGS.planner.num_predict },
          signal: ac.signal,
        }),
      );
    }
    mon.phase = "soak:long-think-on";
    for (let i = 0; i < longCalls && !ac.signal.aborted; i++) {
      const c = INGREDIENT_CASES[i % INGREDIENT_CASES.length];
      const text = off[c.gtin]?.ingredients_text;
      if (!text) throw new Error(`no ingredient text for ${c.gtin} in data/bench/off.json`);
      await step("ingredient", c.id, true, () =>
        client.chatJson<IngredientExtraction>({
          messages: extractionMessages(text),
          schema: extractionSchema,
          think: true,
          options: { num_predict: 4096 },
          signal: ac.signal,
        }),
      );
    }
  } catch (e) {
    error = watchdog ?? (e as Error).message;
    console.error("soak stopped:", error);
  }
  mon.phase = "unload";
  await client.unload().catch((e) => console.error("unload failed", e));
  for (let i = 0; i < 20 && (await client.loaded()).length > 0; i++) await sleep(500);
  await sleep(5000);
  mon.phase = "after";
  await sleep(3000);
  mon.stop();

  const soakSamples = mon.samples.filter((s) => s.phase.startsWith("soak") && s.runnerPrivMiB !== undefined && (s.runners ?? 0) > 0);
  const baseline = calls[0]?.runnerPrivAfterMiB ?? null;
  const peak = soakSamples.length ? Math.max(...soakSamples.map((s) => s.runnerPrivMiB as number)) : null;
  const growthMiB = baseline !== null && peak !== null ? Math.round(peak - baseline) : null;
  const reproduced = (growthMiB !== null && growthMiB > 2048) || client.ramGuardEvents.length > 0 || watchdog !== null;
  const lastAfter = (job: CallRecord["job"]) => calls.filter((c) => c.job === job).at(-1)?.runnerPrivAfterMiB ?? null;
  const result = {
    gate: "soak",
    env,
    error,
    watchdog,
    ramGuardEvents: client.ramGuardEvents,
    verdict: {
      rule: "reproduced if runner private memory rises >2048 MiB above its level after the first soak call, or the RAM guard or watchdog fires",
      runnerPrivAfterFirstCallMiB: baseline,
      runnerPrivPeakMiB: peak === null ? null : Math.round(peak),
      runnerPrivAfterPlannerPhaseMiB: lastAfter("planner"),
      runnerPrivAfterLongPhaseMiB: lastAfter("ingredient"),
      growthMiB,
      reproduced,
    },
    monitor: {
      idle: mon.stats("idle"),
      planner: mon.stats("soak:planner"),
      long: mon.stats("soak:long"),
      unload: mon.stats("unload"),
      after: mon.stats("after"),
    },
    summary: {
      planner: summarise(calls.filter((c) => c.job === "planner")),
      long: summarise(calls.filter((c) => c.job === "ingredient")),
    },
    calls,
    samples: mon.rawSamples(),
    finishedAt: new Date().toISOString(),
  };
  writeResult("soak", result);
  console.log(JSON.stringify({ error, verdict: result.verdict, ramGuardEvents: result.ramGuardEvents, monitor: result.monitor, summary: result.summary }, null, 2));
}

function writeResult(gate: string, data: unknown): void {
  mkdirSync(BENCH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const file = new URL(`${gate}-${stamp}.json`, BENCH_DIR);
  writeFileSync(file, JSON.stringify(data, null, 1));
  console.log("wrote", file.pathname);
}

const gate = process.argv[2];
if (gate === "g8") {
  await runG8(argValue("--model") ?? "nemotron-3-nano:4b");
} else if (gate === "g8b") {
  await runG8b(argValue("--model") ?? "nemotron-3-nano:30b", argValue("--baseline") ?? "nemotron-3-nano:4b");
} else if (gate === "soak") {
  await runSoak(argValue("--model") ?? "nemotron-3-nano:4b");
} else {
  console.error("usage: tsx src/llm/bench.ts g8|g8b|soak [--model <name>]");
  process.exit(2);
}
