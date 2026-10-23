// Dev-time fetch of the bench inputs. Not part of the agent: at runtime the agent reads
// these sources only through Zetaris. Output goes to a NEW directory (never over the
// inputs a bench result was measured on), and every request is logged to
// fetch-log.jsonl with its start time, HTTP status, duration and size.
//
//   npx tsx src/llm/benchFetch.ts [--out <new dir>] [--off <gtin,...>] [--skip-fda] [--skip-fsa]
//
// Etiquette: one openFDA call (200 records); Open Food Facts product calls 3 s apart
// (the floor is 2.5 s) with the ClearShelf User-Agent; one FSA alerts call. Only the
// fields the bench uses are kept: no firm addresses and no OFF contributor fields.

import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INGREDIENT_CASES } from "./bench.cases.ts";

const OFF_GAP_MS = 3000;
const OFF_FIELDS = "code,status,product_name,brands,lang,ingredients_text,allergens_tags,traces_tags,labels_tags,last_modified_t";
const FDA_URL = "https://api.fda.gov/food/enforcement.json?search=reason_for_recall:undeclared&sort=report_date:desc&limit=200";
const FDA_FIELDS = [
  "recall_number",
  "recalling_firm",
  "product_description",
  "reason_for_recall",
  "code_info",
  "classification",
  "status",
  "report_date",
  "distribution_pattern",
  "product_quantity",
] as const;
const FSA_URL = "https://data.food.gov.uk/food-alerts/id?type=AA&_sort=-created&_limit=3";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function userAgent(): string {
  const ua = process.env.CLEARSHELF_USER_AGENT;
  return ua && !ua.includes("<") ? ua : "ClearShelf/0.1";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const outDir = path.resolve(argValue("--out") ?? path.join(repoRoot, "data", "bench", `fetch-${stamp}`));
  if (existsSync(outDir) && readdirSync(outDir).length > 0) throw new Error(`refusing to write into non-empty ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  const logFile = path.join(outDir, "fetch-log.jsonl");
  const headers = { "User-Agent": userAgent(), Accept: "application/json" };

  const get = async (source: string, url: string): Promise<unknown> => {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    let status: number | null = null;
    let bytes = 0;
    let error: string | null = null;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
      status = res.status;
      const text = await res.text();
      bytes = Buffer.byteLength(text);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(text);
    } catch (e) {
      error = (e as Error).message;
      throw e;
    } finally {
      const entry = { source, url, startedAt, status, ms: Math.round(performance.now() - t0), bytes, error };
      appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
      console.log(source, status ?? "-", entry.ms, "ms", url);
    }
  };

  if (!process.argv.includes("--skip-fda")) {
    const data = (await get("openFDA", FDA_URL)) as { results: Array<Record<string, unknown>> };
    const rows = data.results.map((r) => Object.fromEntries(FDA_FIELDS.map((f) => [f, r[f]])));
    writeFileSync(path.join(outDir, "fda_200.json"), JSON.stringify(rows, null, 1));
  }
  if (!process.argv.includes("--skip-fsa")) {
    writeFileSync(path.join(outDir, "fsa_3.json"), JSON.stringify(await get("FSA", FSA_URL), null, 1));
  }

  const gtins = (argValue("--off") ?? INGREDIENT_CASES.map((c) => c.gtin).join(",")).split(",").filter(Boolean);
  const off: Record<string, unknown> = {};
  for (let i = 0; i < gtins.length; i++) {
    if (i > 0) await sleep(OFF_GAP_MS);
    const gtin = gtins[i];
    if (!/^\d{8,14}$/u.test(gtin)) throw new Error(`not a GTIN: ${gtin}`);
    const data = (await get("OFF", `https://world.openfoodfacts.org/api/v2/product/${gtin}.json?fields=${OFF_FIELDS}`)) as {
      status?: number;
      product?: Record<string, unknown>;
    };
    off[gtin] = { status: data.status, ...(data.product ?? {}) };
  }
  if (gtins.length > 0) writeFileSync(path.join(outDir, "off.json"), JSON.stringify(off, null, 1));
  console.log("wrote", outDir);
}

await main();
