// The decision policy. Deterministic and authoritative: no model call, no I/O. Every
// firing cites the evidence ids it rests on. HOLD and BLOCK may be executed
// automatically; CLEAR and CLEAR_WITH_STATEMENT are only proposals that wait for the
// officer's signed approval. An escalation (approved memory invariant, adjudication
// brief) can make the result stricter, never laxer.
//
// R0  preconditions: the product row exists and the ingredients were extracted (else HOLD, "investigation incomplete")
// R1  exact-GTIN recall: Ongoing/Pending -> BLOCK (US market, or UK covered or unknown), HOLD (UK, US-only distribution);
//     Completed/Terminated with report_date within 24 months of as-of -> HOLD ("lot codes not matched")
// R2  name only: brand token match -> review item; brand + product-name similarity >= 0.85 -> HOLD
// R3  any DQ-gate invalid record for the GTIN (and market) -> HOLD, quoting the rule
// R4  any unresolved contradiction -> HOLD
// R5  >= 1 verified allergen, nothing above -> CLEAR_WITH_STATEMENT (pending signature)
// R6  no allergens, ingredients fully parsed, nothing above -> CLEAR (pending signature)
//
// The 24-month window counts from report_date, the only recall date clearance_usl.fda_recall
// federates (openFDA termination dates are not in the USL).

export type Decision = "CLEAR" | "CLEAR_WITH_STATEMENT" | "HOLD" | "BLOCK";
export type Market = "UK" | "US";
export type Rule = "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "ESC";

export const POLICY_VERSION = "2026-10-23.1";
export const R1_WINDOW_MONTHS = 24;
export const R2_NAME_SIMILARITY = 0.85;

export interface RecallFact {
  recall_number: string;
  report_date: string;
  status: string | null;
  classification: string | null;
  distribution: string | null;
  evidenceIds: string[];
}

export interface NameMatchFact {
  source: "fda" | "fsa";
  notice_id: string;
  notice_date: string | null;
  business: string | null;
  title: string | null;
  brand_token: string;
  /** Best product-name similarity against the notice title (0..1). */
  similarity: number;
  evidenceIds: string[];
}

export interface DqFact {
  rule: string;
  table: string;
  invalidRows: number;
  source: "zetaris_dq" | "dq_equivalent_sql";
  evidenceIds: string[];
}

export type ContradictionKind =
  | "claim_not_supported"
  | "model_vs_verifier"
  | "rule_conflict"
  | "untrusted_text"
  | "memory_conflict"
  | "declared_vs_extraction"
  | "recall_vs_label";

export interface ContradictionFact {
  kind: ContradictionKind;
  text: string;
  evidenceIds: string[];
}

export interface VerifiedAllergenFact {
  group: string;
  relation: "contains" | "may_contain";
  evidenceIds: string[];
}

export interface Escalation {
  to: "HOLD" | "BLOCK";
  source: "brief" | "invariant";
  reason: string;
  evidenceIds: string[];
}

export interface PolicyInput {
  gtin: string;
  market: Market;
  /** YYYY-MM-DD; the R1 window and as-of replays are measured against it. */
  asOf: string;
  product: { found: boolean; evidenceIds: string[] };
  /** Null when the extraction step did not run because an earlier precondition failed. */
  extraction: {
    ok: boolean;
    hasText: boolean;
    unparsedFragments: number;
    evidenceIds: string[];
  } | null;
  /** True when every DQ-gate rule produced a result (native or plain-SQL equivalent). */
  dqComplete: boolean;
  recalls: RecallFact[];
  nameMatches: NameMatchFact[];
  dq: DqFact[];
  contradictions: ContradictionFact[];
  verified: VerifiedAllergenFact[];
  /** Items for the officer that change no status (e.g. span-level misses on an allergen already verified). */
  reviewNotes?: { text: string; evidenceIds: string[] }[];
  /** Pipeline steps that failed (gateway or model error); each holds the SKU. */
  incompleteSteps?: { step: string; error: string; evidenceIds: string[] }[];
  escalations?: Escalation[];
}

export interface Firing {
  rule: Rule;
  effect: Decision | "REVIEW" | "INFO";
  reason: string;
  evidenceIds: string[];
}

export interface PolicyResult {
  status: Decision;
  firings: Firing[];
  /** Name-only matches and other items for the officer that change no status. */
  review: Firing[];
  notes: Firing[];
  /** HOLD/BLOCK: may be executed automatically. */
  autoExecutable: boolean;
  /** CLEAR/CLEAR_WITH_STATEMENT: a proposal that needs the officer's signed approval. */
  pendingSignature: boolean;
  policyVersion: string;
}

const SEVERITY: Record<Decision, number> = { CLEAR: 0, CLEAR_WITH_STATEMENT: 1, HOLD: 2, BLOCK: 3 };

export function stricter(a: Decision, b: Decision): Decision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

const UK_TERMS =
  /\b(?:U\.?K\.?|united\s+kingdom|great\s+britain|britain|england|scotland|wales|northern\s+ireland|europe(?:an)?|e\.?u\.?|worldwide|world\s*wide|international(?:ly)?|global(?:ly)?|overseas|foreign\s+countries)\b/iu;

/**
 * Whether a recall's distribution pattern reaches the UK. "unknown" when the text is
 * empty. International, worldwide and European distribution count as reaching the UK;
 * online sales alone do not (they say nothing about where units were shipped).
 */
export function distributionCoversUk(distribution: string | null): "yes" | "no" | "unknown" {
  const t = (distribution ?? "").trim();
  if (!t) return "unknown";
  return UK_TERMS.test(t) ? "yes" : "no";
}

/** Whole months from `from` to `to` (YYYY-MM-DD), negative if `from` is later. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return months;
}

function normStatus(s: string | null): string {
  return (s ?? "").trim().toLowerCase();
}

export function decide(input: PolicyInput): PolicyResult {
  const firings: Firing[] = [];
  const review: Firing[] = [];
  const notes: Firing[] = [];

  // R0: preconditions
  if (!input.product.found) {
    firings.push({
      rule: "R0",
      effect: "HOLD",
      reason: `investigation incomplete: no clearance_usl.product row for ${input.gtin}`,
      evidenceIds: input.product.evidenceIds,
    });
  }

  for (const s of input.incompleteSteps ?? []) {
    firings.push({ rule: "R0", effect: "HOLD", reason: `investigation incomplete: ${s.step} failed (${s.error})`, evidenceIds: s.evidenceIds });
  }

  // R1: exact-GTIN recalls
  for (const r of input.recalls) {
    const st = normStatus(r.status);
    const label = `${r.recall_number} (${r.classification ?? "class unknown"}, ${r.status ?? "status unknown"}, reported ${r.report_date})`;
    if (st === "ongoing" || st === "pending") {
      if (input.market === "US") {
        firings.push({ rule: "R1", effect: "BLOCK", reason: `${label}: active US recall of this GTIN`, evidenceIds: r.evidenceIds });
      } else {
        const covers = distributionCoversUk(r.distribution);
        if (covers === "no") {
          firings.push({
            rule: "R1",
            effect: "HOLD",
            reason: `${label}: US recall of this GTIN; UK units not covered by the notice`,
            evidenceIds: r.evidenceIds,
          });
        } else {
          firings.push({
            rule: "R1",
            effect: "BLOCK",
            reason: `${label}: active recall of this GTIN; distribution ${covers === "yes" ? "reaches the UK" : "not stated"}`,
            evidenceIds: r.evidenceIds,
          });
        }
      }
    } else if (st === "completed" || st === "terminated") {
      const months = monthsBetween(r.report_date, input.asOf);
      if (months < R1_WINDOW_MONTHS) {
        firings.push({
          rule: "R1",
          effect: "HOLD",
          reason: `${label}: recall of this GTIN within ${R1_WINDOW_MONTHS} months; lot codes not matched`,
          evidenceIds: r.evidenceIds,
        });
      } else {
        notes.push({
          rule: "R1",
          effect: "INFO",
          reason: `${label}: reported ${months} months before ${input.asOf}, outside the ${R1_WINDOW_MONTHS}-month window`,
          evidenceIds: r.evidenceIds,
        });
      }
    } else {
      firings.push({ rule: "R1", effect: "HOLD", reason: `${label}: recall status not recognised; held for review`, evidenceIds: r.evidenceIds });
    }
  }

  // R2: name-only matches
  for (const m of input.nameMatches) {
    const what = `${m.source.toUpperCase()} ${m.notice_id} matches brand token "${m.brand_token}" (name similarity ${m.similarity.toFixed(2)})`;
    if (m.similarity >= R2_NAME_SIMILARITY) {
      firings.push({ rule: "R2", effect: "HOLD", reason: `${what}: held pending the officer's confirmation`, evidenceIds: m.evidenceIds });
    } else {
      review.push({ rule: "R2", effect: "REVIEW", reason: `${what}: name-only match for review, no status change`, evidenceIds: m.evidenceIds });
    }
  }

  for (const n of input.reviewNotes ?? []) {
    review.push({ rule: "R4", effect: "REVIEW", reason: n.text, evidenceIds: n.evidenceIds });
  }

  // R3: DQ gate
  for (const d of input.dq) {
    if (d.invalidRows > 0) {
      firings.push({
        rule: "R3",
        effect: "HOLD",
        reason: `DQ ${d.rule} on ${d.table}: ${d.invalidRows} invalid record(s) for this GTIN (${d.source === "zetaris_dq" ? "Zetaris DQ" : "DQ-equivalent SQL"})`,
        evidenceIds: d.evidenceIds,
      });
    }
  }
  if (!input.dqComplete) {
    firings.push({ rule: "R3", effect: "HOLD", reason: "DQ gate incomplete: a rule produced no result", evidenceIds: input.dq.flatMap((d) => d.evidenceIds) });
  }

  // R4: contradictions
  for (const c of input.contradictions) {
    firings.push({ rule: "R4", effect: "HOLD", reason: `unresolved contradiction (${c.kind}): ${c.text}`, evidenceIds: c.evidenceIds });
  }

  // R0 again: the extraction precondition, only if a product row exists
  const ex = input.extraction;
  if (input.product.found) {
    if (!ex || !ex.hasText) {
      // No ingredient text: has_ingredients (R3) already holds; no clearance can be proposed without a parse.
      if (!firings.some((f) => f.rule === "R3")) {
        firings.push({ rule: "R0", effect: "HOLD", reason: "investigation incomplete: no ingredient text to read", evidenceIds: input.product.evidenceIds });
      }
    } else if (!ex.ok) {
      firings.push({
        rule: "R0",
        effect: "HOLD",
        reason: "investigation incomplete: ingredient extraction gave no valid output in two attempts (fallback step)",
        evidenceIds: ex.evidenceIds,
      });
    } else if (ex.unparsedFragments > 0) {
      firings.push({
        rule: "R0",
        effect: "HOLD",
        reason: `investigation incomplete: ${ex.unparsedFragments} unparsed fragment(s) in the ingredient text`,
        evidenceIds: ex.evidenceIds,
      });
    }
  }

  let status: Decision;
  const blocking = firings.filter((f) => f.effect === "HOLD" || f.effect === "BLOCK");
  if (blocking.length > 0) {
    status = blocking.reduce<Decision>((s, f) => stricter(s, f.effect as Decision), "HOLD");
  } else if (input.verified.length > 0) {
    status = "CLEAR_WITH_STATEMENT";
    firings.push({
      rule: "R5",
      effect: "CLEAR_WITH_STATEMENT",
      reason: `${input.verified.length} verified allergen span(s); none of R1-R4; proposed, pending the officer's signature`,
      evidenceIds: [...new Set(input.verified.flatMap((v) => v.evidenceIds))],
    });
  } else {
    status = "CLEAR";
    firings.push({
      rule: "R6",
      effect: "CLEAR",
      reason: "no allergens; ingredients fully parsed; none of R1-R4; proposed, pending the officer's signature",
      evidenceIds: ex?.evidenceIds ?? [],
    });
  }

  for (const e of input.escalations ?? []) {
    if (SEVERITY[e.to] > SEVERITY[status]) {
      firings.push({ rule: "ESC", effect: e.to, reason: `escalated by ${e.source}: ${e.reason}`, evidenceIds: e.evidenceIds });
      status = e.to;
    } else {
      notes.push({ rule: "ESC", effect: "INFO", reason: `escalation to ${e.to} by ${e.source} does not change ${status}: ${e.reason}`, evidenceIds: e.evidenceIds });
    }
  }

  return {
    status,
    firings,
    review,
    notes,
    autoExecutable: status === "HOLD" || status === "BLOCK",
    pendingSignature: status === "CLEAR" || status === "CLEAR_WITH_STATEMENT",
    policyVersion: POLICY_VERSION,
  };
}
