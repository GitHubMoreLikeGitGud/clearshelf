// Evidence records and their JSONL store (data/evidence/<runId>.jsonl, gitignored).
// Every claim on a card cites one or more of these ids. A Zetaris record carries the
// SQL text, its sha256, the rows (at most 20), the Zetaris object, the raw source
// objects, the source URL and licence, and both timestamps: when the gateway ran the
// query and when it last cached the source.

import { appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { REPO_ROOT_URL } from "../config.ts";
import type { TemplateResult } from "../zetaris/client.ts";

export type EvidenceKind = "zetaris_sql" | "model_extraction" | "verifier" | "memory" | "world_model" | "policy" | "dq";

export interface EvidenceModel {
  name: string;
  think: boolean;
  prompt_sha256: string;
  /** Summed over every attempt of the call (see `attempts`). */
  tokens_in: number;
  tokens_out: number;
  attempts: number;
  eval_ms: number;
  tokens_per_s: number | null;
  label: "measured";
}

export interface SourceRef {
  object: string;
  url: string;
  licence: string;
  cached_at: string | null;
}

export interface EvidenceRecord {
  id: string;
  run_id: string;
  kind: EvidenceKind;
  claim: string;
  queried_at: string;
  template_id?: string;
  params?: Record<string, string>;
  sql?: string;
  sql_sha256?: string;
  zetaris_object?: string;
  /** Every USL object the statement reads; zetaris_object is the one the claim is about. */
  zetaris_objects?: string[];
  raw_objects?: string[];
  source_url?: string;
  licence?: string;
  source_cached_at?: string | null;
  sources?: SourceRef[];
  rows?: unknown[][];
  columns?: string[];
  row_count?: number;
  elapsed_ms?: number;
  cache_state?: string;
  /** dq records: whether the result came from Zetaris DQ or from the plain-SQL equivalent. */
  dq_source?: "zetaris_dq" | "dq_equivalent_sql";
  /** True when a table-wide result from an earlier query in this process was reused. */
  reused?: boolean;
  model?: EvidenceModel;
  /** Evidence this record was computed from (model, verifier and policy records). */
  derived_from?: string[];
  details?: Record<string, unknown>;
}

export const MAX_EVIDENCE_ROWS = 20;

const FDA_URL =
  "https://api.fda.gov/food/enforcement.json?search=reason_for_recall:undeclared&sort=report_date:desc&limit=1000";
const FSA_URL = "https://data.food.gov.uk/food-alerts/id?type=AA&_sort=-created&_limit=200";
const OFF_FIELDS =
  "code,product_name,brands,lang,ingredients_text,ingredients_text_en,allergens_tags,traces_tags,labels_tags,countries_tags,last_modified_t";

export const LICENCES = {
  fda: "openFDA public domain / CC0; not endorsed by the FDA",
  fsa: "UK FSA, Open Government Licence v3.0",
  off: "Open Food Facts, ODbL 1.0",
  reference: "ClearShelf reference table (statute and citation URL on each row)",
  ops: "ClearShelf ops store",
} as const;

/** Source URL and licence for a raw Zetaris object (as the gateway resolves it). */
export function sourceFor(rawObject: string): { url: string; licence: string } {
  const o = rawObject.toLowerCase();
  if (o === "clearshelf_fda.enforcement_undeclared") return { url: FDA_URL, licence: LICENCES.fda };
  if (o === "clearshelf_fsa.allergy_alerts") return { url: FSA_URL, licence: LICENCES.fsa };
  const off = /^clearshelf_off\.off_(\d{13})$/u.exec(o);
  if (off) {
    return { url: `https://world.openfoodfacts.org/api/v2/product/${off[1]}.json?fields=${OFF_FIELDS}`, licence: LICENCES.off };
  }
  if (o === "clearshelf_off.off_*") return { url: "https://world.openfoodfacts.org/api/v2/product/<gtin13>.json", licence: LICENCES.off };
  const ops = /^clearshelf_ops\.(\w+)$/u.exec(o);
  if (ops) {
    const name = ops[1]!;
    return {
      url: `http://clearshelf-ops/${name}.json`,
      licence: name === "market_allergens" ? LICENCES.reference : name === "recall_links" ? `${LICENCES.ops} (links measured against openFDA records)` : LICENCES.ops,
    };
  }
  return { url: "unknown", licence: "unknown" };
}

const ALWAYS: (keyof EvidenceRecord)[] = ["id", "run_id", "kind", "claim", "queried_at"];
const SQL_FIELDS: (keyof EvidenceRecord)[] = [
  "template_id",
  "sql",
  "sql_sha256",
  "zetaris_object",
  "raw_objects",
  "source_url",
  "licence",
  "source_cached_at",
  "rows",
  "row_count",
  "elapsed_ms",
  "cache_state",
];

/** Fields a record of this kind must carry. `source_cached_at` must be present but is null for uncached ops tables. */
export function requiredFields(kind: EvidenceKind): (keyof EvidenceRecord)[] {
  if (kind === "zetaris_sql") return [...ALWAYS, ...SQL_FIELDS];
  if (kind === "dq") return [...ALWAYS, ...SQL_FIELDS, "dq_source"];
  if (kind === "model_extraction") return [...ALWAYS, "model", "derived_from"];
  return [...ALWAYS, "derived_from"];
}

export function missingFields(rec: EvidenceRecord): string[] {
  const missing: string[] = requiredFields(rec.kind).filter((k) => !(k in rec) || rec[k] === undefined);
  if (rec.kind === "model_extraction" && rec.model) {
    for (const k of ["name", "think", "prompt_sha256", "tokens_in", "tokens_out", "label"] as const) {
      if (rec.model[k] === undefined) missing.push(`model.${k}`);
    }
  }
  return missing;
}

export function newRunId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `r${stamp}${randomBytes(2).toString("hex")}`;
}

/** Local time with its UTC offset, e.g. 2026-10-23T10:12:03+08:00. */
export function localIso(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${p(off / 60)}:${p(off % 60)}`;
}

export type NewEvidence = Omit<EvidenceRecord, "id" | "run_id" | "queried_at"> & { queried_at?: string };

export class EvidenceStore {
  readonly runId: string;
  readonly path: string | null;
  private readonly records: EvidenceRecord[] = [];

  /** `dir` null keeps the records in memory only (tests). */
  constructor(runId = newRunId(), dir: string | null = fileURLToPath(new URL("data/evidence/", REPO_ROOT_URL))) {
    this.runId = runId;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      this.path = `${dir.replace(/[\\/]$/u, "")}/${runId}.jsonl`;
    } else {
      this.path = null;
    }
  }

  add(e: NewEvidence): EvidenceRecord {
    const id = `ev-${this.runId}-${String(this.records.length + 1).padStart(2, "0")}`;
    const rec: EvidenceRecord = { id, run_id: this.runId, ...e, queried_at: e.queried_at ?? localIso() };
    this.records.push(rec);
    if (this.path) appendFileSync(this.path, `${JSON.stringify(rec)}\n`, "utf8");
    return rec;
  }

  /**
   * A record for one gateway template result. `filter` keeps only the rows that back
   * the claim (a table-wide SHOW DQ result filtered to one GTIN); row_count then counts
   * the kept rows and `details.table_row_count` the rows the statement returned.
   */
  fromTemplate(
    res: TemplateResult,
    claim: string,
    opts: {
      kind?: "zetaris_sql" | "dq";
      filter?: (row: Record<string, unknown>) => boolean;
      dqSource?: "zetaris_dq" | "dq_equivalent_sql";
      reused?: boolean;
      details?: Record<string, unknown>;
      /** The GTIN a table-wide result was filtered to. */
      gtin?: string;
    } = {},
  ): EvidenceRecord {
    let rows = res.rows;
    const details: Record<string, unknown> = { ...(opts.details ?? {}) };
    if (opts.filter) {
      const f = opts.filter;
      rows = res.rows.filter((r) => f(Object.fromEntries(res.columns.map((c, i) => [c, r[i] ?? null]))));
      details.table_row_count = res.row_count;
    }
    // A table-wide statement (SHOW DQ INVALID RECORD) names the OFF tables by wildcard; when the
    // record is filtered to one GTIN, its own OFF table is the source. The gateway reports no
    // cache time for a wildcard, so cached_at stays null there.
    const raw = res.raw_objects.map((o) => (o === "clearshelf_off.off_*" && opts.gtin ? `clearshelf_off.off_${opts.gtin}` : o));
    const sources: SourceRef[] = raw.map((o) => ({ object: o, ...sourceFor(o), cached_at: res.source_cached_at[o] ?? null }));
    const primaryIndex = Math.max(0, sources.findIndex((s) => !s.object.startsWith("clearshelf_ops.")));
    const primary = sources[primaryIndex];
    // The template lists its USL objects in the same order as their raw sources.
    const zetarisObject = res.objects.length === raw.length ? res.objects[primaryIndex] : res.objects[0];
    if (res.truncated) details.truncated_by_gateway = true;
    return this.add({
      kind: opts.kind ?? "zetaris_sql",
      claim,
      template_id: res.template_id,
      params: res.params,
      sql: res.sql ?? "",
      sql_sha256: res.sql_sha256 ?? "",
      zetaris_object: zetarisObject ?? "",
      zetaris_objects: res.objects,
      raw_objects: raw,
      source_url: primary?.url ?? "none",
      licence: primary?.licence ?? "none",
      source_cached_at: primary?.cached_at ?? null,
      sources,
      columns: res.columns,
      rows: rows.slice(0, MAX_EVIDENCE_ROWS),
      row_count: opts.filter ? rows.length : res.row_count,
      elapsed_ms: res.elapsed_ms,
      cache_state: res.cache_state,
      queried_at: res.executed_at,
      ...(opts.kind === "dq" ? { dq_source: opts.dqSource ?? "zetaris_dq" } : {}),
      ...(opts.reused ? { reused: true } : {}),
      ...(Object.keys(details).length ? { details } : {}),
    });
  }

  all(): readonly EvidenceRecord[] {
    return this.records;
  }

  get(id: string): EvidenceRecord | undefined {
    return this.records.find((r) => r.id === id);
  }
}
