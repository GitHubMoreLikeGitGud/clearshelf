// HTTP client for the Zetaris gateway (127.0.0.1:8791). The agent sends a template id
// and parameters, never SQL text. Parameters are checked here with the gateway's own
// patterns before any request, so a bad GTIN or notice id fails fast and locally; the
// gateway checks them again. Only loopback gateway hosts are accepted.

import { checkDigitOk } from "../verify/gtin.ts";

export type Role = "reader" | "registrar";
export type CacheState = "hit" | "miss" | "uncached" | "unknown" | string;

/** The gateway's POST /sql/template response body. */
export interface TemplateResponse {
  template_id: string;
  role: Role;
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  sql: string | null;
  sql_sha256: string | null;
  objects: string[];
  raw_objects: string[];
  executed_at: string;
  cache_state: CacheState;
  cache_detail: Record<string, string>;
  source_cached_at: Record<string, string>;
  error: string | null;
}

export interface TemplateResult extends TemplateResponse {
  params: Record<string, string>;
  http_status: number;
  wall_ms: number;
  /** HTTP 503 "warming" replies that were waited out before this result. */
  warm_retries: number;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly response?: Partial<TemplateResponse>,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

// Same patterns as gateway/templates.py PARAM_PATTERNS. openFDA food recall numbers
// start with H- or F- (7 of the 18 recall-matched manifest SKUs carry F- numbers).
export const PARAM_PATTERNS = {
  gtin: /^\d{13}$/u,
  fda_notice: /^[FH]-\d{4}-\d{4}$/u,
  fsa_notice: /^FSA-AA-\d+-\d{4}$/u,
  brand: /^[a-z0-9 ]{1,40}$/u,
  market: /^(UK|US)$/u,
  date: /^\d{4}-\d{2}-\d{2}$/u,
} as const;
export type ParamKind = keyof typeof PARAM_PATTERNS;

/** Parameter kinds per template id, mirroring gateway/templates.py. */
export const TEMPLATE_PARAMS: Record<string, Record<string, ParamKind>> = {
  select_one: {},
  product: { gtin: "gtin" },
  declared: { gtin: "gtin" },
  recalls_by_gtin: { gtin: "gtin" },
  recalls_by_name: { brand: "brand" },
  fda_notice: { recall_number: "fda_notice" },
  fda_recent: { since: "date" },
  fsa_recent: { since: "date" },
  fsa_allergens: { notation: "fsa_notice" },
  market_list: { market: "market" },
  prior_decisions: { gtin: "gtin" },
  recheck_cleared: {},
  join_map: {},
  dqsql_has_ingredients: { gtin: "gtin" },
  dqsql_english_label: { gtin: "gtin" },
  dqsql_declared_market_code: { gtin: "gtin" },
  dqsql_extracted_market_code: { gtin: "gtin" },
  dq_invalid_has_ingredients: {},
  dq_invalid_english_label: {},
  dq_invalid_declared_market_code: {},
  dq_invalid_extracted_market_code: {},
  dq_invalid_signed_clear: {},
  dq_invalid_known_status: {},
  dq_rules: {},
  usl_model: {},
};

export class BadParams extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadParams";
  }
}

export function validateParam(kind: ParamKind, value: string): string {
  if (!PARAM_PATTERNS[kind].test(value)) throw new BadParams(`invalid ${kind}: ${JSON.stringify(value.slice(0, 40))}`);
  if (kind === "gtin" && !checkDigitOk(value)) throw new BadParams(`GTIN check digit fails: ${value}`);
  return value;
}

export function validateTemplateParams(templateId: string, params: Record<string, string>): void {
  const kinds = TEMPLATE_PARAMS[templateId];
  if (!kinds) throw new BadParams(`unknown template: ${templateId}`);
  const extra = Object.keys(params).filter((k) => !(k in kinds));
  const missing = Object.keys(kinds).filter((k) => !(k in params));
  if (extra.length || missing.length) {
    throw new BadParams(`template ${templateId} takes [${Object.keys(kinds).join(", ")}]; missing [${missing}], unexpected [${extra}]`);
  }
  for (const [name, kind] of Object.entries(kinds)) validateParam(kind, params[name]!);
}

/** A lower-case brand token the recalls_by_name template accepts, or null. */
export function brandToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 40)
    .trim();
  return t.length >= 3 && PARAM_PATTERNS.brand.test(t) ? t : null;
}

export function rowsAsObjects(res: Pick<TemplateResponse, "columns" | "rows">): Record<string, unknown>[] {
  return res.rows.map((r) => Object.fromEntries(res.columns.map((c, i) => [c, r[i] ?? null])));
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
let refusedGatewayHosts = 0;

/** Attempts to reach a non-loopback gateway host since the process started. */
export function refusedGatewayHostAttempts(): number {
  return refusedGatewayHosts;
}

export interface GatewayClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Client-side bound per request; the gateway bounds each query at 60 s itself. */
  timeoutMs?: number;
  /** How many HTTP 503 "warming" replies to wait out, and how long between them. */
  warmRetries?: number;
  warmDelayMs?: number;
}

export class GatewayClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly warmRetries: number;
  private readonly warmDelayMs: number;

  constructor(opts: GatewayClientOptions = {}) {
    const base = new URL(opts.baseUrl ?? process.env.GATEWAY_URL ?? "http://127.0.0.1:8791");
    if (!LOOPBACK_HOSTS.has(base.hostname)) {
      refusedGatewayHosts++;
      throw new GatewayError(`refusing non-local gateway host ${base.hostname}`, 0);
    }
    this.baseUrl = base.origin;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.warmRetries = opts.warmRetries ?? 6;
    this.warmDelayMs = opts.warmDelayMs ?? 10_000;
  }

  async health(): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(30_000) });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new GatewayError(`gateway /health HTTP ${res.status}`, res.status, body as Partial<TemplateResponse>);
    return body;
  }

  /** Runs one named template. Throws GatewayError on any non-200 reply (after waiting out warm-up 503s). */
  async template(templateId: string, params: Record<string, string> = {}, role: Role = "reader"): Promise<TemplateResult> {
    validateTemplateParams(templateId, params);
    let warm = 0;
    for (;;) {
      const started = performance.now();
      const res = await this.fetchImpl(`${this.baseUrl}/sql/template`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template_id: templateId, params, role }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const wall = performance.now() - started;
      let body: TemplateResponse;
      try {
        body = (await res.json()) as TemplateResponse;
      } catch {
        throw new GatewayError(`gateway ${templateId}: non-JSON reply (HTTP ${res.status})`, res.status);
      }
      if (res.status === 503 && String(body.error ?? "").startsWith("warming") && warm < this.warmRetries) {
        warm++;
        await new Promise((r) => setTimeout(r, this.warmDelayMs));
        continue;
      }
      if (res.status !== 200 || body.error) {
        throw new GatewayError(`gateway ${templateId} HTTP ${res.status}: ${String(body.error ?? "").slice(0, 300)}`, res.status, body);
      }
      return { ...body, params, http_status: res.status, wall_ms: Math.round(wall), warm_retries: warm };
    }
  }
}

// ---------- DQ gate ----------

export type DqRule = "has_ingredients" | "english_label" | "declared_market_code" | "extracted_market_code";

export interface DqRuleSpec {
  rule: DqRule;
  /** The Zetaris rule name as LIST DQ shows it. */
  zetarisRule: string;
  table: string;
  native: string;
  equivalent: string;
  /** market_code rules are filtered to the market being cleared. */
  perMarket: boolean;
}

export const DQ_GATE: readonly DqRuleSpec[] = [
  { rule: "has_ingredients", zetarisRule: "has_ingredients", table: "product", native: "dq_invalid_has_ingredients", equivalent: "dqsql_has_ingredients", perMarket: false },
  { rule: "english_label", zetarisRule: "english_label", table: "product", native: "dq_invalid_english_label", equivalent: "dqsql_english_label", perMarket: false },
  { rule: "declared_market_code", zetarisRule: "market_code", table: "declared_allergen", native: "dq_invalid_declared_market_code", equivalent: "dqsql_declared_market_code", perMarket: true },
  { rule: "extracted_market_code", zetarisRule: "market_code", table: "extracted_allergen", native: "dq_invalid_extracted_market_code", equivalent: "dqsql_extracted_market_code", perMarket: true },
];

export interface DqRuleResult {
  spec: DqRuleSpec;
  /** "zetaris_dq" = SHOW DQ INVALID RECORD; "dq_equivalent_sql" = the plain-SQL fallback. */
  source: "zetaris_dq" | "dq_equivalent_sql";
  result: TemplateResult;
  /** Invalid records for this GTIN (and market, for the market_code rules). */
  invalid: Record<string, unknown>[];
  /** Invalid records for this GTIN in the other market (shown, not gating). */
  otherMarket: Record<string, unknown>[];
  nativeError: string | null;
  /** Why the plain-SQL equivalent ran instead of SHOW DQ (native error, or a truncated reply); null for a native result. */
  fallbackReason: string | null;
  /** True when a table-wide SHOW DQ result from earlier in this process was reused. */
  reused: boolean;
}

interface Memo {
  at: number;
  result: TemplateResult;
}

/**
 * The DQ gate for one GTIN and market. SHOW DQ INVALID RECORD returns the invalid rows
 * of the whole table, so one result can serve every GTIN. It is reused only when the
 * caller asks (`memoTtlMs` > 0: a `--manifest` batch over SKUs onboarded before it
 * started); by default every run queries afresh, so a GTIN registered or re-activated
 * after an earlier result is never judged against it. The plain-SQL equivalent for the
 * GTIN runs instead, and the result says why, when the native statement fails or times
 * out, or when the gateway truncated its reply (an invalid row past the cap would
 * otherwise read as "no invalid record").
 */
export class DqGate {
  private readonly memo = new Map<string, Memo>();
  constructor(
    private readonly client: GatewayClient,
    private readonly memoTtlMs = 0,
  ) {}

  async run(gtin: string, market: "UK" | "US"): Promise<DqRuleResult[]> {
    validateParam("gtin", gtin);
    const out: DqRuleResult[] = [];
    for (const spec of DQ_GATE) {
      let nativeError: string | null = null;
      let fallbackReason: string | null = null;
      let reused = false;
      let result: TemplateResult | null = null;
      const m = this.memoTtlMs > 0 ? this.memo.get(spec.native) : undefined;
      if (m && Date.now() - m.at < this.memoTtlMs) {
        result = m.result;
        reused = true;
      } else {
        try {
          result = await this.client.template(spec.native, {});
          if (this.memoTtlMs > 0) this.memo.set(spec.native, { at: Date.now(), result });
        } catch (e) {
          nativeError = (e as Error).message.slice(0, 300);
          fallbackReason = `SHOW DQ failed: ${nativeError}`;
        }
      }
      if (result && !result.truncated) {
        const rows = rowsAsObjects(result).filter((r) => r.gtin === gtin);
        const split = splitByMarket(rows, market, spec.perMarket);
        out.push({ spec, source: "zetaris_dq", result, ...split, nativeError, fallbackReason: null, reused });
        continue;
      }
      if (result) {
        fallbackReason = `SHOW DQ returned ${result.rows.length} of ${result.row_count} rows (truncated by the gateway${reused ? ", reused result" : ""})`;
      }
      const eq = await this.client.template(spec.equivalent, { gtin });
      const split = splitByMarket(rowsAsObjects(eq), market, spec.perMarket);
      out.push({ spec, source: "dq_equivalent_sql", result: eq, ...split, nativeError, fallbackReason, reused: false });
    }
    return out;
  }
}

// ---------- write-back DQ ----------

export type WritebackRule = "signed_clear" | "known_status";

export const WRITEBACK_DQ: readonly { rule: WritebackRule; template: string }[] = [
  { rule: "signed_clear", template: "dq_invalid_signed_clear" },
  { rule: "known_status", template: "dq_invalid_known_status" },
];

export interface WritebackDqResult {
  rule: WritebackRule;
  /** Invalid records in the whole USL decision table (empty when the rule could not run). */
  invalid: Record<string, unknown>[];
  result: TemplateResult | null;
  error: string | null;
}

/**
 * Zetaris's own check of the decisions it reads back from the ops store: SHOW DQ INVALID RECORD
 * for the write-back rules on clearance_usl.decision. signed_clear flags a CLEAR or
 * CLEAR_WITH_STATEMENT row without a contract id, independently of the agent server's contract
 * check before the write. A failure is reported in `error`, never thrown: the check runs after
 * the decision is already written.
 */
export async function writebackDq(client: GatewayClient, rules: readonly WritebackRule[] = ["signed_clear", "known_status"]): Promise<WritebackDqResult[]> {
  const out: WritebackDqResult[] = [];
  for (const spec of WRITEBACK_DQ.filter((x) => rules.includes(x.rule))) {
    try {
      const result = await client.template(spec.template, {});
      out.push({ rule: spec.rule, invalid: rowsAsObjects(result), result, error: result.truncated ? `truncated: ${result.rows.length} of ${result.row_count} rows` : null });
    } catch (e) {
      out.push({ rule: spec.rule, invalid: [], result: null, error: (e as Error).message.slice(0, 300) });
    }
  }
  return out;
}

function splitByMarket(
  rows: Record<string, unknown>[],
  market: "UK" | "US",
  perMarket: boolean,
): { invalid: Record<string, unknown>[]; otherMarket: Record<string, unknown>[] } {
  if (!perMarket) return { invalid: rows, otherMarket: [] };
  const mine = (r: Record<string, unknown>) => String(r.market_code ?? "").startsWith(`${market}:`);
  return { invalid: rows.filter(mine), otherMarket: rows.filter((r) => !mine(r)) };
}
