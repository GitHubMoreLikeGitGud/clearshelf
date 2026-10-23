// As-of replay (SPEC 8.2): the decision engine sees only notices dated on or before the
// as-of date. The gateway's templates bound the lower date in SQL (fda_recent and
// fsa_recent take `since`) but have no upper bound, so the upper bound is applied here, to
// the rows each template returned, by the notice's own date column. The SQL text and its
// sha256 stay exactly as executed; every filtered result and its evidence record carry
// `as_of_filter` (column, rows returned, rows dropped) and the replay banner, so a replayed
// event is never shown as live.

import { GatewayClient, type Role, type TemplateResult } from "../zetaris/client.ts";
import { EvidenceStore, type EvidenceRecord } from "../evidence/store.ts";

/** Date column per template; templates not listed are passed through unchanged. */
export const AS_OF_COLUMNS: Record<string, string> = {
  recalls_by_gtin: "report_date",
  recalls_by_name: "notice_date",
  fda_notice: "report_date",
  fda_recent: "report_date",
  fsa_recent: "created",
  recheck_cleared: "report_date",
  prior_decisions: "decided_date",
};

export interface AsOfFilter {
  as_of: string;
  column: string;
  rows_returned: number;
  rows_dropped: number;
  applied: "client-side on the rows the template returned (the SQL has no upper date bound)";
}

export type AsOfResult = TemplateResult & { as_of_filter?: AsOfFilter; replay_banner?: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Replay as of 10 Oct 2026". */
export function replayBanner(asOf: string): string {
  const [y, m, d] = asOf.split("-").map(Number);
  return `Replay as of ${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** Rows whose date column is empty or later than as-of are dropped (an undated notice cannot be placed in time). */
export function filterAsOf(res: TemplateResult, asOf: string, column: string): AsOfResult {
  const i = res.columns.indexOf(column);
  if (i < 0) return res;
  const kept = res.rows.filter((r) => {
    const v = r[i];
    return typeof v === "string" && v.length >= 10 && v.slice(0, 10) <= asOf;
  });
  return {
    ...res,
    rows: kept,
    row_count: res.row_count - (res.rows.length - kept.length),
    as_of_filter: { as_of: asOf, column, rows_returned: res.rows.length, rows_dropped: res.rows.length - kept.length, applied: "client-side on the rows the template returned (the SQL has no upper date bound)" },
  };
}

/**
 * A gateway client that sees the world as of a date: it delegates to `inner` and filters
 * dated templates. `asOf` null passes everything through. It is a GatewayClient, so the
 * clearance pipeline and every tool take it unchanged.
 */
export class AsOfGateway extends GatewayClient {
  constructor(
    readonly inner: GatewayClient,
    public asOf: string | null,
    public banner: string | null,
  ) {
    super({ baseUrl: inner.baseUrl });
  }

  override health(): Promise<Record<string, unknown>> {
    return this.inner.health();
  }

  override async template(templateId: string, params: Record<string, string> = {}, role: Role = "reader"): Promise<AsOfResult> {
    const res = await this.inner.template(templateId, params, role);
    const col = AS_OF_COLUMNS[templateId];
    if (!this.asOf || !col) return res;
    return { ...filterAsOf(res, this.asOf, col), ...(this.banner ? { replay_banner: this.banner } : {}) };
  }
}

/** An evidence store that records the as-of filter and the replay banner on every Zetaris record. */
export class ReplayEvidenceStore extends EvidenceStore {
  constructor(
    readonly replay: { as_of: string; banner: string } | null,
    runId?: string,
    dir?: string | null,
  ) {
    super(runId, dir);
  }

  override fromTemplate(res: TemplateResult, claim: string, opts: Parameters<EvidenceStore["fromTemplate"]>[2] = {}): EvidenceRecord {
    const r = res as AsOfResult;
    const details = { ...(opts.details ?? {}) };
    if (r.as_of_filter) details.as_of_filter = r.as_of_filter;
    if (this.replay) details.replay = this.replay;
    return super.fromTemplate(res, claim, { ...opts, details });
  }
}
