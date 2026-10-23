// SPEC 9.3 evidence-quality measurement over the evidence files of a scenario run (and any extra
// run ids): E-complete, E-replay (each cited Zetaris/DQ template re-run with the same parameters
// through the gateway; every cited row must still be returned), E-ground, E-contra, E-cov of the
// policy records, and the two safety invariants over the ops decisions and the contract
// verifier log. The numbers in docs/eval-report.md section 2 come from this script. It prints
// counts only, never row contents.
//
//   cd agent && npx tsx src/eval/measure/evidence-quality.ts <data/eval/scenarios-*.json> [run id]...

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, REPO_ROOT_URL } from "../../config.ts";
import type { EvidenceRecord } from "../../evidence/store.ts";
import { GatewayClient, rowsAsObjects } from "../../zetaris/client.ts";

interface ScenarioOut {
  id: string;
  kind: string;
  expected?: { contradiction_kinds?: string[] };
  got?: { run_id?: string; status?: string; e_cov?: number; e_complete?: number; contradiction_kinds?: string[]; baseline?: { sweep?: string }; poll?: { sweep?: string } };
}

const repoFile = (rel: string) => fileURLToPath(new URL(rel, REPO_ROOT_URL));
const rate = (n: number, d: number): number | null => (d ? n / d : null);

// The required fields per kind of the evidence drawer (docs/cursor-tasks/C5): every record id,
// run_id, kind, claim, queried_at; Zetaris and DQ records the SQL citation fields; DQ records
// dq_source; model records model.
const BASE = ["id", "run_id", "kind", "claim", "queried_at"];
const SQL = ["sql", "sql_sha256", "zetaris_object", "raw_objects", "source_url", "licence", "source_cached_at", "row_count", "elapsed_ms", "cache_state"];

/** Fields a record lacks for its kind ("" counts as missing; a null source_cached_at is present). */
export function missingFor(rec: EvidenceRecord): string[] {
  const r = rec as unknown as Record<string, unknown>;
  const k = rec.kind;
  const required = [...BASE, ...(k === "zetaris_sql" || k === "dq" ? SQL : []), ...(k === "dq" ? ["dq_source"] : []), ...(k === "model_extraction" ? ["model"] : [])];
  return required.filter((f) => r[f] === undefined || r[f] === "");
}

async function main(): Promise<void> {
  const gw = new GatewayClient({ baseUrl: loadConfig().gatewayUrl });
  const [scenFile, ...extraRuns] = process.argv.slice(2);
  if (!scenFile) throw new Error("usage: evidence-quality.ts <scenarios json> [run id]...");
  const scen = JSON.parse(readFileSync(scenFile, "utf8")) as { results: ScenarioOut[] };
  const runs: { scenario: string; run_id: string }[] = [];
  for (const r of scen.results) {
    if (r.got?.run_id && r.kind !== "synthetic_injection") runs.push({ scenario: r.id, run_id: r.got.run_id });
    if (r.kind === "replay") for (const k of ["baseline", "poll"] as const) if (r.got?.[k]?.sweep) runs.push({ scenario: `${r.id} ${k}`, run_id: r.got[k]!.sweep! });
  }
  for (const x of extraRuns) runs.push({ scenario: "extra", run_id: x });

  const rerunCache = new Map<string, Set<string> | { error: string }>();
  const rerun = async (t: string, p: Record<string, string>) => {
    const key = `${t}|${JSON.stringify(p)}`;
    if (!rerunCache.has(key)) {
      try {
        const r = await gw.template(t, p);
        rerunCache.set(key, new Set(r.rows.map((x) => JSON.stringify(x))));
      } catch (e) {
        rerunCache.set(key, { error: (e as Error).message.slice(0, 160) });
      }
    }
    return rerunCache.get(key)!;
  };

  const perRun: Record<string, unknown>[] = [];
  const tot = { records: 0, complete: 0, null_cached_at: 0, missingByField: {} as Record<string, number>, replay_records: 0, replay_ok: 0, replay_zero_rows: 0, replay_errors: [] as string[], replay_vanished: [] as string[], grounded: 0, dropped: 0, extraction_records: 0, firings: 0, firings_cited: 0, review: 0, review_cited: 0 };
  for (const { scenario, run_id } of runs) {
    const f = repoFile(`data/evidence/${run_id}.jsonl`);
    if (!existsSync(f)) {
      perRun.push({ scenario, run_id, error: "no evidence file" });
      continue;
    }
    const recs = readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as EvidenceRecord);
    const r = { scenario, run_id, records: recs.length, complete: 0, replay: 0, replay_ok: 0, grounded: 0, dropped: 0 };
    for (const rec of recs) {
      tot.records++;
      const m = missingFor(rec);
      if (!m.length) {
        r.complete++;
        tot.complete++;
      }
      for (const x of m) tot.missingByField[`${rec.kind}.${x}`] = (tot.missingByField[`${rec.kind}.${x}`] ?? 0) + 1;
      const sqlKind = rec.kind === "zetaris_sql" || rec.kind === "dq";
      if (sqlKind && rec.source_cached_at === null) tot.null_cached_at++;
      if (sqlKind && rec.template_id) {
        tot.replay_records++;
        r.replay++;
        const now = await rerun(rec.template_id, (rec.params ?? {}) as Record<string, string>);
        if ("error" in now) {
          tot.replay_errors.push(`${rec.id} ${rec.template_id}: ${now.error}`);
          continue;
        }
        const cited = (rec.rows ?? []) as unknown[][];
        if (!cited.length) tot.replay_zero_rows++;
        const gone = cited.filter((row) => !now.has(JSON.stringify(row)));
        if (!gone.length) {
          tot.replay_ok++;
          r.replay_ok++;
        } else tot.replay_vanished.push(`${rec.id} ${rec.template_id} ${gone.length}/${cited.length} row(s) gone`);
      }
      const d = (rec.details ?? {}) as { spans?: unknown[]; ungrounded?: unknown[]; firings?: { evidenceIds?: string[] }[]; review?: { evidenceIds?: string[] }[] };
      if (rec.kind === "model_extraction" && Array.isArray(d.spans)) {
        tot.extraction_records++;
        const g = d.spans.length;
        const dr = (d.ungrounded ?? []).length;
        tot.grounded += g;
        tot.dropped += dr;
        r.grounded += g;
        r.dropped += dr;
      }
      if (rec.kind === "policy" && rec.run_id === run_id) {
        for (const x of d.firings ?? []) {
          tot.firings++;
          if ((x.evidenceIds ?? []).length) tot.firings_cited++;
        }
        for (const x of d.review ?? []) {
          tot.review++;
          if ((x.evidenceIds ?? []).length) tot.review_cited++;
        }
      }
    }
    perRun.push(r);
  }

  const cards = scen.results.filter((r) => typeof r.got?.e_cov === "number").map((r) => ({ id: r.id, e_cov: r.got!.e_cov, e_complete_runner: r.got!.e_complete }));
  let contraExp = 0;
  let contraGot = 0;
  const contra: { id: string; kind: string; surfaced: boolean }[] = [];
  for (const r of scen.results)
    for (const k of r.expected?.contradiction_kinds ?? []) {
      contraExp++;
      const ok = (r.got?.contradiction_kinds ?? []).includes(k);
      if (ok) contraGot++;
      contra.push({ id: r.id, kind: k, surfaced: ok });
    }

  // Safety invariants.
  const ops = (JSON.parse(readFileSync(repoFile("data/ops/decisions.json"), "utf8")) as { data: Record<string, string>[] }).data.slice(1);
  const vlogFile = repoFile("data/contracts/verifier-agent-ops.jsonl");
  const vlog = existsSync(vlogFile) ? readFileSync(vlogFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { ok: boolean; action: string; contract_id: string }) : [];
  const okHigh = new Set(vlog.filter((v) => v.ok && ["CLEAR", "CLEAR_WITH_STATEMENT", "RELEASE"].includes(v.action)).map((v) => v.contract_id));
  const defs = (JSON.parse(readFileSync(new URL("../scenarios.json", import.meta.url), "utf8")) as { scenarios: { id: string; gtin?: string }[] }).scenarios;
  const clears = [
    ...scen.results.filter((r) => /^CLEAR/u.test(r.got?.status ?? "") && r.kind !== "synthetic_injection").map((r) => ({ where: `scenario ${r.id}`, gtin: defs.find((d) => d.id === r.id)?.gtin })),
    ...ops.filter((d) => /^CLEAR/u.test(d.status ?? "")).map((d) => ({ where: `ops ${d.decision_id}`, gtin: d.gtin })),
  ];
  let clearOnOngoing = 0;
  const clearChecks: Record<string, unknown>[] = [];
  for (const c of clears) {
    if (!c.gtin) continue;
    const rr = rowsAsObjects(await gw.template("recalls_by_gtin", { gtin: c.gtin }));
    const ongoing = rr.filter((x) => String(x.status) === "Ongoing").map((x) => x.recall_number);
    if (ongoing.length) clearOnOngoing++;
    clearChecks.push({ where: c.where, gtin: c.gtin, ongoing_exact_recalls: ongoing });
  }
  const unsigned = ops.filter((d) => /^CLEAR/u.test(d.status ?? "") || /RELEASE/u.test(d.reason ?? "")).filter((d) => !okHigh.has(d.contract_id!) || !/officer/u.test(d.actor ?? ""));

  const out = {
    generated_at: new Date().toISOString(),
    label: "measured",
    runs: perRun,
    e_cov_card_runner: cards,
    e_cov_policy_record: { firings: tot.firings, firings_cited: tot.firings_cited, review: tot.review, review_cited: tot.review_cited },
    e_complete: { records: tot.records, complete: tot.complete, rate: rate(tot.complete, tot.records), missing_by_field: tot.missingByField, sql_records_with_null_source_cached_at: tot.null_cached_at },
    e_replay: {
      records_rerun: tot.replay_records,
      cited_rows_all_present: tot.replay_ok,
      rate: rate(tot.replay_ok, tot.replay_records - tot.replay_errors.length),
      records_citing_zero_rows: tot.replay_zero_rows,
      distinct_queries: rerunCache.size,
      errors: tot.replay_errors,
      vanished: tot.replay_vanished,
    },
    e_ground: { extraction_records: tot.extraction_records, grounded_spans: tot.grounded, dropped_spans: tot.dropped, rate: rate(tot.grounded, tot.grounded + tot.dropped) },
    e_contra: { expected: contraExp, surfaced: contraGot, rate: rate(contraGot, contraExp), items: contra },
    safety: { clear_on_exact_gtin_ongoing_recall: clearOnOngoing, clear_checks: clearChecks, executed_clear_or_release_without_officer_contract: unsigned.length, unsigned_rows: unsigned.map((d) => d.decision_id), ops_rows: ops.length },
  };
  mkdirSync(new URL("data/eval/", REPO_ROOT_URL), { recursive: true });
  const file = repoFile(`data/eval/evidence-quality-${out.generated_at.replace(/[:.]/gu, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 1));
  console.log(`wrote ${file}`);
}

if (process.argv[1] && /measure[\\/]evidence-quality\.ts$/u.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });
}
