// Notice extraction: Nemotron copies structured facts out of one openFDA recall record
// (schema-constrained), and every value is then checked against the record itself.
// A UPC is kept only if its digits appear literally in the notice and it passes the
// GS1 check digit; lots must appear literally too. Undeclared allergen groups are read
// deterministically from the reason text by the lexicon and compared with the model's.

import type { OllamaClient } from "../llm/ollama.ts";
import { noticeMessages } from "../llm/prompts.ts";
import { noticeSchema, type AllergenGroup, type NoticeExtraction } from "../llm/schemas.ts";
import { jobSettings } from "../llm/settings.ts";
import { extractUpcs, normalise, type AcceptedUpc } from "../verify/gtin.ts";
import { lexiconScan } from "../verify/lexicon.ts";
import { ruleConflicts } from "../verify/jurisdiction.ts";
import type { EvidenceModel } from "../evidence/store.ts";

export const RECALL_NUMBER = /^[FH]-\d{4}-\d{4}$/u;

/** One fda_recall row as the recalls_by_gtin and fda_notice templates return it. */
export interface NoticeRow {
  recall_number: string;
  report_date: string;
  classification: string | null;
  status: string | null;
  firm: string | null;
  distribution: string | null;
  product_description: string | null;
  reason: string | null;
  code_info: string | null;
}

export interface CheckedUpc {
  raw: string;
  gtin13: string | null;
  transform: string | null;
  literal: boolean;
  check_digit: boolean;
  kept: boolean;
}

export type Group = Exclude<AllergenGroup, "none">;

export interface NoticeExtractionResult {
  recall_number: string;
  ok: boolean;
  errors: string[];
  extraction: NoticeExtraction | null;
  /** The model's UPCs, each checked against the notice text and the check digit. */
  upcs: CheckedUpc[];
  /** UPCs the deterministic GS1 scan finds in the same text (no model). */
  scanned_upcs: AcceptedUpc[];
  lots_literal: string[];
  lots_not_found: string[];
  /** Groups the lexicon reads in the reason text (contains or may_contain hits). */
  reason_groups: Group[];
  /** reason_groups less a generic tree nut that the notice itself says is coconut. */
  undeclared_groups: Group[];
  coconut_as_tree_nut: boolean;
  allergens_agreed: Group[];
  allergens_model_only: Group[];
  allergens_reason_only: Group[];
  model: EvidenceModel;
  wall_ms: number;
}

export function noticeText(row: NoticeRow): string {
  return [row.product_description, row.reason, row.code_info].filter(Boolean).join("\n");
}

function compactDigits(text: string): string {
  // "8 16929 00011 9" and "816929-000119" are the same digits as written.
  return text.replace(/(\d)[ -](?=\d)/gu, "$1");
}

export function checkUpc(raw: string, text: string): CheckedUpc {
  const digits = raw.replace(/\D/gu, "");
  const literal = digits.length > 0 && (text.includes(digits) || compactDigits(text).includes(digits));
  const n = normalise(digits);
  return {
    raw,
    gtin13: n.ok ? n.gtin13 : null,
    transform: n.ok ? n.transform : null,
    literal,
    check_digit: n.ok,
    kept: literal && n.ok,
  };
}

/** Allergen groups the lexicon finds in a recall reason (contains or may_contain hits). */
export function reasonGroups(reason: string): Group[] {
  const groups = new Set<Group>();
  for (const h of lexiconScan(reason)) {
    if (h.relation === "contains" || h.relation === "may_contain") groups.add(h.group);
  }
  return [...groups];
}

/**
 * Groups a recall reason reports as undeclared, for the policy and the claim tester.
 * When the notice calls coconut a tree nut ("tree nut (coconut)"), a generic "tree nut"
 * is the coconut: it is not counted (the jurisdiction module raises the rule-against-rule
 * conflict instead), unless the reason also names a tree-nut species.
 */
export function undeclaredGroups(reason: string): { groups: Group[]; coconutAsTreeNut: boolean } {
  const coconutAsTreeNut = ruleConflicts("US", reason).some((c) => c.id === "coconut-tree-nut");
  const groups = new Set<Group>();
  for (const h of lexiconScan(reason)) {
    if (h.relation !== "contains" && h.relation !== "may_contain") continue;
    if (h.group === "tree_nut" && coconutAsTreeNut && !h.species) continue;
    groups.add(h.group);
  }
  return { groups: [...groups], coconutAsTreeNut };
}

/** Wheat is a gluten cereal: the two compare as one family. */
export function allergenFamily(g: Group): Group {
  return g === "wheat" ? "gluten_cereal" : g;
}

export async function extractNotice(row: NoticeRow, ollama: OllamaClient): Promise<NoticeExtractionResult> {
  if (!RECALL_NUMBER.test(row.recall_number)) throw new Error(`malformed recall number: ${row.recall_number}`);
  const settings = jobSettings("notice");
  const started = performance.now();
  const outcome = await ollama.chatJson<NoticeExtraction>({
    messages: noticeMessages({
      id: row.recall_number,
      product_description: row.product_description ?? "",
      reason_for_recall: row.reason ?? "",
      code_info: row.code_info ?? "",
      recalling_firm: row.firm ?? "",
    }),
    schema: noticeSchema,
    think: settings.think,
    options: { num_predict: settings.num_predict },
  });
  const wall = performance.now() - started;
  const attempts = outcome.attempts.map((a) => a.result);
  const last = attempts[attempts.length - 1];
  const model: EvidenceModel = {
    name: last?.model ?? ollama.model,
    think: settings.think,
    prompt_sha256: last?.promptSha256 ?? "",
    tokens_in: attempts.reduce((s, r) => s + r.metrics.promptTokens, 0),
    tokens_out: attempts.reduce((s, r) => s + r.metrics.evalTokens, 0),
    attempts: attempts.length,
    eval_ms: Math.round(attempts.reduce((s, r) => s + r.metrics.evalMs, 0)),
    tokens_per_s: last?.metrics.tokensPerSecond ?? null,
    label: "measured",
  };

  const text = noticeText(row);
  const scanned = extractUpcs(text).accepted;
  const reason = reasonGroups(row.reason ?? "");
  const und = undeclaredGroups(row.reason ?? "");
  const base = {
    recall_number: row.recall_number,
    scanned_upcs: scanned,
    reason_groups: reason,
    undeclared_groups: und.groups,
    coconut_as_tree_nut: und.coconutAsTreeNut,
    model,
    wall_ms: Math.round(wall),
  };

  if (!outcome.ok) {
    return {
      ...base,
      ok: false,
      errors: outcome.errors,
      extraction: null,
      upcs: [],
      lots_literal: [],
      lots_not_found: [],
      allergens_agreed: [],
      allergens_model_only: [],
      allergens_reason_only: reason,
    };
  }

  const ex = outcome.value;
  const lower = text.toLowerCase();
  const lotsLiteral = ex.lots.filter((l) => lower.includes(l.toLowerCase()));
  const modelGroups = [...new Set<Group>(ex.allergens)];
  const modelFamilies = new Set(modelGroups.map(allergenFamily));
  const reasonFamilies = new Set(reason.map(allergenFamily));
  return {
    ...base,
    ok: true,
    errors: [],
    extraction: ex,
    upcs: ex.upcs.map((u) => checkUpc(u, text)),
    lots_literal: lotsLiteral,
    lots_not_found: ex.lots.filter((l) => !lotsLiteral.includes(l)),
    allergens_agreed: reason.filter((g) => modelFamilies.has(allergenFamily(g))),
    allergens_model_only: modelGroups.filter((g) => !reasonFamilies.has(allergenFamily(g))),
    allergens_reason_only: reason.filter((g) => !modelFamilies.has(allergenFamily(g))),
  };
}

/** Whether the notice text names this catalogue GTIN, by the model's checked UPCs or the deterministic scan. */
export function noticeNamesGtin(res: NoticeExtractionResult, gtin13: string): { byModel: boolean; byScan: boolean } {
  return {
    byModel: res.upcs.some((u) => u.kept && u.gtin13 === gtin13),
    byScan: res.scanned_upcs.some((u) => u.gtin13 === gtin13),
  };
}
