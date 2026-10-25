// Recall-notice extraction at scale: Nemotron (extractNotice, the agent's notice job) against
// the deterministic GS1 scan (extractUpcs) on every cached openFDA notice that prints a UPC.
// Each notice is read through the gateway (fda_notice, one record), exactly as the agent reads
// it. One model call per notice, one at a time. The gateway returns at most 200 rows per
// template (gateway/app.py MAX_ROWS), so fda_recent lists only the newest 200 cached notices;
// --ids <file> gives the full list of recall numbers instead (an openFDA page JSON, such as the
// dev-time page in data/curation/raw/, or a JSON array), and the run records how many the gateway
// found.
//
//   cd agent && npx tsx src/eval/measure/notices.ts run [--ids <file>] [--limit n]  -> data/eval/notices-<time>.json
//   cd agent && npx tsx src/eval/measure/notices.ts score <run.json> [<adjudication.json>]
//
// Gold UPCs (score): a GTIN is TRUE when both readers return it (each passes the GS1 check
// digit and its digits appear in the notice text); a model code whose digits are not in the
// text is invented; a code only one reader returns is decided by hand (the adjudication file
// lists each one by notice id); codes printed with a failing check digit are counted apart.
// Allergen groups are compared with the lexicon's reading of the reason text; every notice
// where they differ is listed for hand-checking. The run file keeps codes and group labels,
// never product descriptions or reason text.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, REPO_ROOT_URL } from "../../config.ts";
import { allergenFamily, extractNotice, noticeText, reasonGroups, type NoticeRow } from "../../extract/notice.ts";
import { OllamaClient } from "../../llm/ollama.ts";
import { extractUpcs } from "../../verify/gtin.ts";
import { GatewayClient, rowsAsObjects } from "../../zetaris/client.ts";

const KEYWORD = /\b(?:UPC|EAN|GTIN|bar ?codes?)\b/iu;
const LONG_RUN = /\d(?:[ -]?\d){7,}/u;

/** A notice prints a UPC when it names a barcode (UPC, EAN, GTIN, barcode) and has a run of 8+ digits. */
export function printsUpc(text: string): boolean {
  return KEYWORD.test(text) && LONG_RUN.test(text);
}

interface NoticeRecord {
  recall_number: string;
  report_date: string;
  scan: { gtin13: string[]; rejected: { raw_code: string; reason: string }[] };
  model: {
    ok: boolean;
    errors: string[];
    upcs: { raw: string; gtin13: string | null; literal: boolean; check_digit: boolean; kept: boolean }[];
    allergens: string[];
    reason_type: string | null;
    tokens_in: number;
    tokens_out: number;
    attempts: number;
    tokens_per_s: number | null;
    wall_ms: number;
  };
  reason_groups: string[];
}

const median = (xs: number[]): number | null => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  return a.length ? (a.length % 2 ? a[(a.length - 1) / 2]! : (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2) : null;
};
const pct = (xs: number[], p: number): number | null => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)]! : null;
};
const round = (x: number | null, d = 3): number | null => (x === null ? null : Number(x.toFixed(d)));

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function run(): Promise<void> {
  const cfg = loadConfig();
  const gw = new GatewayClient({ baseUrl: cfg.gatewayUrl });
  const ollama = new OllamaClient({ baseUrl: cfg.ollamaUrl, model: cfg.model });
  const t0 = performance.now();
  const started = new Date().toISOString();
  const recent = await gw.template("fda_recent", { since: "2000-01-01" });
  const listed = rowsAsObjects(recent).map((r) => String(r.recall_number));
  const idsFile = flag("ids");
  let ids = listed;
  if (idsFile) {
    const doc = JSON.parse(readFileSync(idsFile, "utf8")) as unknown;
    ids = Array.isArray(doc) ? doc.map(String) : (doc as { results: { recall_number: string }[] }).results.map((r) => String(r.recall_number));
  }
  ids = [...new Set(ids)];
  process.stderr.write(`gateway: ${recent.row_count} cached notices, ${listed.length} listed${recent.truncated ? " (truncated)" : ""}; ids to read: ${ids.length}\n`);
  const rows: NoticeRow[] = [];
  const missing: string[] = [];
  const tRead = performance.now();
  for (const id of ids) {
    const res = rowsAsObjects(await gw.template("fda_notice", { recall_number: id }));
    if (res[0]) rows.push(res[0] as unknown as NoticeRow);
    else missing.push(id);
  }
  const readMs = Math.round(performance.now() - tRead);
  const subset = rows.filter((r) => printsUpc(noticeText(r)));
  process.stderr.write(`read ${rows.length} notices in ${(readMs / 1000).toFixed(1)} s (${missing.length} not in Zetaris); ${subset.length} print a UPC\n`);
  const limit = Number(flag("limit") ?? subset.length);
  const records: NoticeRecord[] = [];
  for (const [i, row] of subset.slice(0, limit).entries()) {
    const text = noticeText(row);
    const scan = extractUpcs(text);
    const res = await extractNotice(row, ollama);
    records.push({
      recall_number: row.recall_number,
      report_date: String(row.report_date).slice(0, 10),
      scan: { gtin13: scan.accepted.map((a) => a.gtin13), rejected: scan.rejected.map((x) => ({ raw_code: x.raw_code, reason: x.reason })) },
      model: {
        ok: res.ok,
        errors: res.errors.map((e) => e.slice(0, 160)),
        upcs: res.upcs.map((u) => ({ raw: u.raw, gtin13: u.gtin13, literal: u.literal, check_digit: u.check_digit, kept: u.kept })),
        allergens: res.extraction?.allergens ?? [],
        reason_type: res.extraction?.reason_type ?? null,
        tokens_in: res.model.tokens_in,
        tokens_out: res.model.tokens_out,
        attempts: res.model.attempts,
        tokens_per_s: res.model.tokens_per_s,
        wall_ms: res.wall_ms,
      },
      reason_groups: reasonGroups(row.reason ?? ""),
    });
    if ((i + 1) % 25 === 0) process.stderr.write(`  ${i + 1}/${subset.length} (${((performance.now() - t0) / 1000).toFixed(0)} s)\n`);
  }
  mkdirSync(new URL("data/eval/", REPO_ROOT_URL), { recursive: true });
  const file = fileURLToPath(new URL(`data/eval/notices-${started.replace(/[:.]/gu, "-")}.json`, REPO_ROOT_URL));
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        label: "measured",
        model: cfg.model,
        started_at: started,
        wall_ms: Math.round(performance.now() - t0),
        gateway_read_ms: readMs,
        gateway_row_count: recent.row_count,
        gateway_listed: listed.length,
        ids_source: idsFile ? "file" : "fda_recent",
        ids_requested: ids.length,
        newest_listed_in_ids: listed.filter((x) => ids.includes(x)).length,
        not_in_zetaris: missing,
        cached_notices: rows.length,
        printing_upc: subset.length,
        records,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`wrote ${file}`);
}

interface Adjudication {
  /** "<recall_number>|<gtin13>" -> true (a product barcode the notice prints) or false. */
  codes: Record<string, { verdict: boolean; why: string }>;
  /** Allergen disagreements: "<recall_number>" -> which reader is right, per group. */
  allergens?: Record<string, { truth: string[]; why: string }>;
}

function score(runFile: string, adjFile?: string): void {
  const doc = JSON.parse(readFileSync(runFile, "utf8")) as { records: NoticeRecord[]; cached_notices: number; printing_upc: number; model: string; wall_ms: number };
  const adj: Adjudication = adjFile ? (JSON.parse(readFileSync(adjFile, "utf8")) as Adjudication) : { codes: {} };
  const recs = doc.records;
  let truePool = 0,
    xTp = 0,
    xFp = 0,
    nTp = 0,
    nFp = 0,
    agreed = 0,
    invented = 0,
    failsCheck = 0,
    rawModel = 0,
    unadjudicated = 0,
    xOnlyTrue = 0,
    nOnlyTrue = 0,
    printedNotUsable = 0;
  const pending: { key: string; who: "scan" | "model" }[] = [];
  const perNotice: { recall_number: string; x_missed: number; n_missed: number }[] = [];
  for (const r of recs) {
    const x = new Set(r.scan.gtin13);
    const nKept = new Set(r.model.upcs.filter((u) => u.kept).map((u) => u.gtin13!));
    rawModel += r.model.upcs.length;
    for (const u of r.model.upcs) {
      if (!u.literal) invented++;
      else if (!u.check_digit) failsCheck++;
    }
    printedNotUsable += r.scan.rejected.filter((j) => j.reason === "check_digit").length;
    const pool = new Set([...x, ...nKept]);
    let xm = 0,
      nm = 0;
    for (const g of pool) {
      const both = x.has(g) && nKept.has(g);
      let truth: boolean | null;
      if (both) {
        truth = true;
        agreed++;
      } else {
        const a = adj.codes[`${r.recall_number}|${g}`];
        truth = a ? a.verdict : null;
        if (truth === null) {
          unadjudicated++;
          pending.push({ key: `${r.recall_number}|${g}`, who: x.has(g) ? "scan" : "model" });
          continue;
        }
        if (truth && x.has(g)) xOnlyTrue++;
        if (truth && nKept.has(g)) nOnlyTrue++;
      }
      if (truth) {
        truePool++;
        if (x.has(g)) xTp++;
        else xm++;
        if (nKept.has(g)) nTp++;
        else nm++;
      } else {
        if (x.has(g)) xFp++;
        if (nKept.has(g)) nFp++;
      }
    }
    if (xm || nm) perNotice.push({ recall_number: r.recall_number, x_missed: xm, n_missed: nm });
  }
  // Allergen typing against the lexicon's reading of the reason text.
  let exact = 0,
    modelOnly = 0,
    reasonOnly = 0,
    agreedGroups = 0,
    okCalls = 0,
    rtAgree = 0;
  const allergenDiff: { recall_number: string; model: string[]; reason: string[] }[] = [];
  for (const r of recs) {
    if (!r.model.ok) continue;
    okCalls++;
    const m = new Set(r.model.allergens.map((g) => allergenFamily(g as never)));
    const l = new Set(r.reason_groups.map((g) => allergenFamily(g as never)));
    const mo = [...m].filter((g) => !l.has(g));
    const lo = [...l].filter((g) => !m.has(g));
    agreedGroups += [...m].filter((g) => l.has(g)).length;
    modelOnly += mo.length;
    reasonOnly += lo.length;
    if (!mo.length && !lo.length) exact++;
    else allergenDiff.push({ recall_number: r.recall_number, model: [...m].sort(), reason: [...l].sort() });
    const lexType = l.size ? "undeclared_allergen" : "other";
    if (r.model.reason_type === lexType) rtAgree++;
  }
  const walls = recs.map((r) => r.model.wall_ms);
  const out = {
    label: "measured",
    model: doc.model,
    cached_notices: doc.cached_notices,
    printing_upc: doc.printing_upc,
    scored_notices: recs.length,
    model_json_valid: recs.filter((r) => r.model.ok).length,
    model_retried: recs.filter((r) => r.model.attempts > 1).length,
    upc: {
      gold_rule: "TRUE when both readers return the GTIN (literal in the text, GS1 check digit passes); single-reader codes decided by hand (adjudication file); invented = model digits not in the text",
      true_in_pool: truePool,
      agreed_by_both: agreed,
      single_reader_true: { scan_only: xOnlyTrue, model_only: nOnlyTrue },
      unadjudicated,
      scan: { precision: round(xTp + xFp ? xTp / (xTp + xFp) : null), recall: round(truePool ? xTp / truePool : null), tp: xTp, fp: xFp, fn: truePool - xTp },
      model_after_host_check: { precision: round(nTp + nFp ? nTp / (nTp + nFp) : null), recall: round(truePool ? nTp / truePool : null), tp: nTp, fp: nFp, fn: truePool - nTp },
      model_raw_codes: rawModel,
      model_invented_not_in_text: invented,
      model_copied_but_fails_check_digit: failsCheck,
      scan_rejected_check_digit: printedNotUsable,
    },
    allergens: {
      gold_rule: "the lexicon's reading of the recall reason text; disagreements listed for hand-checking",
      notices: okCalls,
      exact_group_match: exact,
      groups_agreed: agreedGroups,
      model_only_groups: modelOnly,
      reason_only_groups: reasonOnly,
      reason_type_agrees_with_lexicon: rtAgree,
    },
    timing: {
      model_wall_ms_median: median(walls),
      model_wall_ms_p95: pct(walls, 95),
      model_wall_ms_max: Math.max(...walls),
      tokens_per_s_median: round(median(recs.map((r) => r.model.tokens_per_s ?? Number.NaN)), 1),
      tokens_out_median: median(recs.map((r) => r.model.tokens_out)),
      run_wall_ms: doc.wall_ms,
    },
    notices_with_misses: perNotice,
    allergen_disagreements: allergenDiff,
    pending_adjudication: pending,
  };
  console.log(JSON.stringify(out, null, 2));
}

if (process.argv[1] && /measure[\\/]notices\.ts$/u.test(process.argv[1])) {
  const cmd = process.argv[2];
  const p = cmd === "run" ? run() : cmd === "score" ? Promise.resolve(score(process.argv[3]!, process.argv[4])) : Promise.reject(new Error("usage: notices.ts run [--ids <file>] [--limit n] | score <run.json> [<adjudication.json>]"));
  p.catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });
}