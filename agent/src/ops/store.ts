// The ops store: the agent's write-back to data/ops/*.json, which the clearshelf-ops nginx
// serves to Zetaris as REST tables (never cached) and the clearance USL federates as
// `decision`, `recall_product_link` and `extracted_allergen`. Contract (SPEC 3.2):
// - every file keeps a sentinel row ("<pk>": "__schema__", every field a typed placeholder
//   string) first, so schema inference never sees an empty array; activations filter it out;
// - every value is a string;
// - writes are atomic (temp file, then rename), under a lock file so the server and the
//   CLI never interleave.
// Decisions are an append-only log: the current decision per (gtin, market) is the row
// with the latest decided_at. Every decision write is checked against a Scout execution
// contract first: HOLD and BLOCK need a valid low-risk contract (the agent issues it),
// CLEAR and CLEAR_WITH_STATEMENT, and RELEASE (stored as the clearance row it results
// in), need one carrying an officer approval. A refused write changes nothing and is
// logged by the verifier.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REPO_ROOT_URL } from "../config.ts";
import { localIso } from "../evidence/store.ts";
import { ContractVerifier, type ContractAction, type ExecutionContract, type RefusalCode } from "../contract/scout.ts";
import { checkDigitOk } from "../verify/gtin.ts";
import { rowsAsObjects, type GatewayClient, type TemplateResult } from "../zetaris/client.ts";
import type { Decision, Market } from "../policy/decide.ts";

export const OPS_FILES = {
  decisions: "decisions.json",
  recall_links: "recall_links.json",
  extractions: "extractions.json",
} as const;
export type OpsName = keyof typeof OPS_FILES;

/** Same sentinels as gateway/onboard.py SENTINELS. */
export const SENTINELS = {
  decisions: {
    decision_id: "__schema__",
    gtin: "string",
    market: "string",
    status: "string",
    statement: "string",
    decided_at: "string",
    decided_date: "string",
    actor: "string",
    contract_id: "string",
    reason: "string",
  },
  recall_links: { link_key: "__schema__", recall_number: "string", gtin: "string", raw_code: "string", transform: "string", extracted_by: "string" },
  extractions: { extracted_key: "__schema__", gtin: "string", market_code: "string", relation: "string", evidence_text: "string", verifier: "string", run_id: "string" },
} as const;

const PK: Record<OpsName, string> = { decisions: "decision_id", recall_links: "link_key", extractions: "extracted_key" };

/** USL column widths (SPEC 3.3); longer values are refused, never truncated silently. */
const WIDTHS: Record<OpsName, Record<string, number>> = {
  decisions: { decision_id: 60, gtin: 14, market: 2, status: 24, statement: 1000, decided_at: 25, decided_date: 10, actor: 60, contract_id: 60, reason: 1000 },
  recall_links: { link_key: 60, recall_number: 20, gtin: 14, raw_code: 40, transform: 30, extracted_by: 20 },
  extractions: { extracted_key: 160, gtin: 14, market_code: 40, relation: 16, evidence_text: 400, verifier: 16, run_id: 40 },
};

export type DecisionRow = Record<keyof (typeof SENTINELS)["decisions"], string>;
export type LinkRow = Record<keyof (typeof SENTINELS)["recall_links"], string>;
export type ExtractionRow = Record<keyof (typeof SENTINELS)["extractions"], string>;

export class OpsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "OpsError";
  }
}

/** A refused contract: HTTP 403, nothing written. */
export class ContractRefused extends OpsError {
  constructor(
    readonly refusal: RefusalCode,
    reason: string,
  ) {
    super(`refused: contract ${refusal}: ${reason}`, 403, refusal);
    this.name = "ContractRefused";
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const RECALL = /^[FH]-\d{4}-\d{4}$/u;
const STATUSES: readonly Decision[] = ["CLEAR", "CLEAR_WITH_STATEMENT", "HOLD", "BLOCK"];

export interface DecisionWrite {
  gtin: string;
  market: Market;
  status: Decision;
  /** The published statement (CLEAR_WITH_STATEMENT); empty otherwise. */
  statement?: string | null;
  reason: string;
  actor: string;
  contract: ExecutionContract | unknown;
  /** RELEASE is stored as the CLEAR / CLEAR_WITH_STATEMENT row it results in (decision.signed_clear). */
  action?: "RELEASE";
  /** As-of replay: the date the decision engine stood at; the reason is prefixed with the replay banner. */
  replay?: { asOf: string; banner: string } | null;
}

export interface DecisionWriteResult {
  row: DecisionRow;
  contract_id: string;
  file: string;
  file_sha256: string;
  rows_in_file: number;
}

export interface OpsStoreOptions {
  dir?: string;
  verifier: ContractVerifier;
  clock?: () => Date;
  lockTimeoutMs?: number;
}

/** The parameters a decision contract must carry for this write. */
export function decisionContractParams(w: Pick<DecisionWrite, "gtin" | "market" | "status" | "statement" | "action">): { action: ContractAction; params: Record<string, string> } {
  const params: Record<string, string> = { gtin: w.gtin, market: w.market };
  if (w.action === "RELEASE") params.release_to = w.status;
  else params.status = w.status;
  if (w.status === "CLEAR_WITH_STATEMENT") params.statement_sha256 = sha256(w.statement ?? "");
  return { action: w.action === "RELEASE" ? "RELEASE" : w.status, params };
}

export class OpsStore {
  readonly dir: string;
  readonly verifier: ContractVerifier;
  private readonly clock: () => Date;
  private readonly lockTimeoutMs: number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: OpsStoreOptions) {
    this.dir = (opts.dir ?? fileURLToPath(new URL("data/ops/", REPO_ROOT_URL))).replace(/[\\/]$/u, "");
    this.verifier = opts.verifier;
    this.clock = opts.clock ?? (() => new Date());
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 10_000;
    mkdirSync(this.dir, { recursive: true });
  }

  path(name: OpsName): string {
    return `${this.dir}/${OPS_FILES[name]}`;
  }

  /** Rows of an ops file without the sentinel. A missing file reads as empty. */
  rows<N extends OpsName>(name: N): Record<string, string>[] {
    return this.readDoc(name).filter((r) => r[PK[name]] !== "__schema__");
  }

  private readDoc(name: OpsName): Record<string, string>[] {
    const p = this.path(name);
    if (!existsSync(p)) return [{ ...SENTINELS[name] }];
    const doc = JSON.parse(readFileSync(p, "utf8")) as { data?: unknown };
    if (!doc || !Array.isArray(doc.data)) throw new OpsError(`${OPS_FILES[name]} is not an ops file with a data array`, 500, "corrupt_ops_file");
    return doc.data as Record<string, string>[];
  }

  /** Atomic rewrite with the sentinel first; returns the sha256 of the bytes written. */
  private writeDoc(name: OpsName, rows: Record<string, string>[]): string {
    const sentinel = rows.find((r) => r[PK[name]] === "__schema__") ?? { ...SENTINELS[name] };
    const data = [sentinel, ...rows.filter((r) => r[PK[name]] !== "__schema__")];
    const text = `${JSON.stringify({ data }, null, 1)}\n`;
    const p = this.path(name);
    const tmp = `${p}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, p);
    return sha256(text);
  }

  /** Serialises writers in this process (promise chain) and across processes (lock file). */
  private async locked<T>(name: OpsName, fn: () => T): Promise<T> {
    const run = async () => {
      const lock = `${this.path(name)}.lock`;
      const t0 = Date.now();
      let fd: number | null = null;
      while (fd === null) {
        try {
          fd = openSync(lock, "wx");
        } catch {
          try {
            if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock); // stale lock from a crashed writer
          } catch {
            // the holder released it between the two calls
          }
          if (Date.now() - t0 > this.lockTimeoutMs) throw new OpsError(`could not lock ${OPS_FILES[name]}`, 503, "locked");
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      try {
        return fn();
      } finally {
        closeSync(fd);
        try {
          unlinkSync(lock);
        } catch {
          // already gone
        }
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private checkWidths(name: OpsName, row: Record<string, string>): void {
    for (const [k, w] of Object.entries(WIDTHS[name])) {
      const v = row[k];
      if (typeof v !== "string") throw new OpsError(`${name}.${k} must be a string`, 400, "bad_row");
      if (v.length > w) throw new OpsError(`${name}.${k} is ${v.length} characters; the USL column holds ${w}`, 400, "too_long");
    }
  }

  // ---------- decisions ----------

  private newDecisionId(gtin: string, market: string, replay: boolean): string {
    const d = this.clock();
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
    return `${replay ? "rp" : "d"}-${gtin}-${market}-${stamp}-${randomBytes(2).toString("hex")}`;
  }

  /**
   * Verifies the contract, then appends one decision row. Throws ContractRefused (403)
   * without writing when the contract does not authorise exactly this write.
   */
  async writeDecision(w: DecisionWrite): Promise<DecisionWriteResult> {
    if (!checkDigitOk(w.gtin) || !/^\d{13}$/u.test(w.gtin)) throw new OpsError(`not a GTIN-13: ${w.gtin}`, 400, "bad_gtin");
    if (w.market !== "UK" && w.market !== "US") throw new OpsError(`market must be UK or US`, 400, "bad_market");
    if (!STATUSES.includes(w.status)) throw new OpsError(`status must be one of ${STATUSES.join(", ")}`, 400, "bad_status");
    if (w.action === "RELEASE" && w.status !== "CLEAR" && w.status !== "CLEAR_WITH_STATEMENT") {
      throw new OpsError("a RELEASE is stored as CLEAR or CLEAR_WITH_STATEMENT", 400, "bad_status");
    }
    if (w.status === "CLEAR_WITH_STATEMENT" && !(w.statement ?? "").trim()) throw new OpsError("CLEAR_WITH_STATEMENT needs the statement", 400, "bad_statement");
    if (w.replay && !DATE.test(w.replay.asOf)) throw new OpsError("replay as-of must be YYYY-MM-DD", 400, "bad_date");
    const { action, params } = decisionContractParams(w);
    const v = this.verifier.verify(w.contract, { action, params });
    if (!v.ok) throw new ContractRefused(v.code, v.reason);
    const contract = v.contract;
    return this.locked("decisions", () => {
      // Re-check under the lock: two requests with the same contract must not both write.
      if (this.verifier.isUsed(contract.contractId)) throw new ContractRefused("replayed", `contract ${contract.contractId} was already used`);
      const now = this.clock();
      const decidedAt = localIso(now);
      const reasonPrefix = w.replay ? `${w.replay.banner.toUpperCase()} | ` : "";
      const row: DecisionRow = {
        decision_id: this.newDecisionId(w.gtin, w.market, !!w.replay),
        gtin: w.gtin,
        market: w.market,
        status: w.status,
        statement: w.status === "CLEAR_WITH_STATEMENT" ? (w.statement ?? "") : "",
        decided_at: decidedAt,
        decided_date: w.replay ? w.replay.asOf : decidedAt.slice(0, 10),
        actor: w.actor,
        contract_id: contract.contractId,
        reason: `${reasonPrefix}${w.action === "RELEASE" ? "RELEASE: " : ""}${w.reason}`.slice(0, 1000),
      };
      this.checkWidths("decisions", row);
      const rows = this.readDoc("decisions");
      rows.push(row);
      const fileSha = this.writeDoc("decisions", rows);
      this.verifier.consume(contract);
      return { row, contract_id: contract.contractId, file: this.path("decisions"), file_sha256: fileSha, rows_in_file: rows.length - 1 };
    });
  }

  decisions(): DecisionRow[] {
    return this.rows("decisions") as DecisionRow[];
  }

  /** The current decision per "gtin|market": the row with the latest decided_at. */
  current(): Map<string, DecisionRow> {
    const out = new Map<string, DecisionRow>();
    for (const r of this.decisions()) {
      const k = `${r.gtin}|${r.market}`;
      const prev = out.get(k);
      if (!prev || Date.parse(r.decided_at) >= Date.parse(prev.decided_at)) out.set(k, r);
    }
    return out;
  }

  // ---------- recall links and extractions (agent facts, no contract) ----------

  /** Appends links the agent measured (notice extraction or GS1 scan). A link_key already present keeps its row. */
  async addLinks(links: LinkRow[]): Promise<{ added: LinkRow[]; skipped: string[]; file_sha256: string | null }> {
    for (const l of links) {
      if (!RECALL.test(l.recall_number)) throw new OpsError(`bad recall number ${l.recall_number}`, 400, "bad_recall");
      if (!checkDigitOk(l.gtin) || !/^\d{13}$/u.test(l.gtin)) throw new OpsError(`not a GTIN-13: ${l.gtin}`, 400, "bad_gtin");
      if (l.link_key !== `${l.recall_number}|${l.gtin}`) throw new OpsError(`link_key must be <recall_number>|<gtin>`, 400, "bad_row");
      this.checkWidths("recall_links", l);
    }
    if (!links.length) return { added: [], skipped: [], file_sha256: null };
    return this.locked("recall_links", () => {
      const rows = this.readDoc("recall_links");
      const keys = new Set(rows.map((r) => r.link_key));
      const added: LinkRow[] = [];
      const skipped: string[] = [];
      for (const l of links) {
        if (keys.has(l.link_key)) skipped.push(l.link_key);
        else {
          rows.push({ ...l });
          keys.add(l.link_key);
          added.push(l);
        }
      }
      return { added, skipped, file_sha256: added.length ? this.writeDoc("recall_links", rows) : null };
    });
  }

  /** Replaces the extraction rows of one GTIN with a new verified set (the latest run wins). */
  async replaceExtractions(gtin: string, rows: ExtractionRow[]): Promise<{ removed: number; added: number; file_sha256: string }> {
    for (const r of rows) {
      if (r.gtin !== gtin) throw new OpsError("every extraction row must carry the GTIN being replaced", 400, "bad_row");
      this.checkWidths("extractions", r);
    }
    return this.locked("extractions", () => {
      const all = this.readDoc("extractions");
      const kept = all.filter((r) => r.extracted_key === "__schema__" || r.gtin !== gtin);
      const removed = all.length - kept.length;
      return { removed, added: rows.length, file_sha256: this.writeDoc("extractions", [...kept, ...rows.map((r) => ({ ...r }))]) };
    });
  }
}

// ---------- closed loop through Zetaris ----------

export interface Visibility {
  visible: boolean;
  attempts: number;
  result: TemplateResult | null;
  error: string | null;
}

/**
 * Proves a written decision is visible inside Zetaris: prior_decisions(gtin) reads the USL
 * `decision` table, activated from the uncached ops REST table, so the row must appear on
 * the next query. Retries briefly in case nginx served the previous file.
 */
export async function confirmDecisionVisible(gateway: GatewayClient, row: DecisionRow, attempts = 3, delayMs = 1500): Promise<Visibility> {
  let last: TemplateResult | null = null;
  let error: string | null = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      last = await gateway.template("prior_decisions", { gtin: row.gtin });
      error = null;
      if (rowsAsObjects(last).some((r) => r.decision_id === row.decision_id)) return { visible: true, attempts: i, result: last, error: null };
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { visible: false, attempts, result: last, error };
}
