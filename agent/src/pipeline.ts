// The straight clearance pipeline for one SKU and market: every checklist step in a
// fixed order, each result recorded as evidence. The Markovian investigation loop
// calls the same steps as tools; this file is the non-agentic baseline. Nothing here
// writes to the ops store: decisions stay proposals.

import { nameSimilarity } from "../../engines/world-model/reference/src/resolve.ts";
import type { OllamaClient } from "./llm/ollama.ts";
import { claimsFromLabels, claimsFromText, testClaim, type Claim, type ClaimEvidence, type ClaimTestResult } from "./verify/claims.ts";
import { ruleConflicts, type RuleConflict } from "./verify/jurisdiction.ts";
import { brandToken, DqGate, GatewayClient, GatewayError, rowsAsObjects, type TemplateResult } from "./zetaris/client.ts";
import { EvidenceStore, missingFields, type EvidenceRecord } from "./evidence/store.ts";
import {
  allergenDisagreements,
  extractIngredients,
  verifiedAllergens,
  type AllergenReading,
  type ExtractionDisagreement,
  type IngredientExtractionResult,
  type VerifiedAllergen,
} from "./extract/ingredients.ts";
import {
  allergenFamily,
  extractNotice,
  noticeNamesGtin,
  undeclaredGroups,
  type Group,
  type NoticeExtractionResult,
  type NoticeRow,
} from "./extract/notice.ts";
import {
  decide,
  type ContradictionFact,
  type DqFact,
  type Market,
  type NameMatchFact,
  type PolicyResult,
  type RecallFact,
} from "./policy/decide.ts";
import { buildStatement, statementCovers, verifierFindsToConfirm, type Statement } from "./policy/statement.ts";
import { notChecked, type NotCheckedItem } from "./policy/notChecked.ts";
import { SKU_CHECKLIST } from "./llm/schemas.ts";

export interface PipelineDeps {
  gateway: GatewayClient;
  dq: DqGate;
  ollama: OllamaClient;
  evidence: EvidenceStore;
  log?: (line: string) => void;
  /** Reuse a verified extraction for an unchanged label text (keyed by model and text sha). */
  extractionMemo?: Map<string, { result: IngredientExtractionResult; evidenceId: string }>;
  noticeMemo?: Map<string, { result: NoticeExtractionResult; evidenceId: string }>;
}

export interface CardClaim {
  text: string;
  evidenceIds: string[];
}

export interface ClearResult {
  run_id: string;
  gtin: string;
  market: Market;
  as_of: string;
  started_at: string;
  product: {
    found: boolean;
    name: string | null;
    brand: string | null;
    lang: string | null;
    has_text: boolean;
    text_field: "ingredients_text" | "ingredients_text_en" | null;
    labels: string | null;
  };
  decision: PolicyResult;
  statement: Statement | null;
  claim_tests: ClaimTestResult[];
  contradictions: ContradictionFact[];
  not_checked: NotCheckedItem[];
  card: CardClaim[];
  extraction: {
    ran: boolean;
    reused: boolean;
    ok: boolean;
    spans: number;
    duplicates: number;
    ungrounded: number;
    agreed: number;
    disagreed: number;
    unparsed_fragments: string[];
    verified: VerifiedAllergen[];
    keyword_contains: string[];
    model: IngredientExtractionResult["model"] | null;
    wall_ms: number;
  };
  notices: Array<{
    recall_number: string;
    ok: boolean;
    reused: boolean;
    upcs_kept: string[];
    upcs_rejected: string[];
    names_this_gtin: { byModel: boolean; byScan: boolean };
    reason_groups: Group[];
    undeclared_groups: Group[];
    allergens_agreed: Group[];
    allergens_model_only: Group[];
    allergens_reason_only: Group[];
    model: NoticeExtractionResult["model"];
  }>;
  name_matches: NameMatchFact[];
  dq: Array<{ rule: string; table: string; source: string; invalid: number; other_market: number; reused: boolean; native_error: string | null }>;
  checklist: Record<string, boolean>;
  gaps: string[];
  timings_ms: Record<string, number>;
  evidence_file: string | null;
  evidence_ids: string[];
  quality: { e_cov: number; claims: number; e_complete: number; records: number; incomplete_records: Record<string, string[]> };
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** Best similarity of the product name against the notice title and each of its comma/semicolon parts. */
export function bestNameSimilarity(productName: string, title: string): number {
  const parts = [title, ...title.split(/[,;:()\n]| - /u)].map((p) => p.trim()).filter((p) => p.length >= 3);
  let best = 0;
  for (const p of parts) best = Math.max(best, nameSimilarity(productName, p));
  return best;
}

function dedupeNotes(notes: { text: string; evidenceIds: string[] }[]): { text: string; evidenceIds: string[] }[] {
  const seen = new Set<string>();
  return notes.filter((n) => (seen.has(n.text) ? false : (seen.add(n.text), true)));
}

function groupOfMarketCode(code: string): string {
  return code.split(":").slice(1).join(":");
}

function readingLabel(r: AllergenReading): string {
  return `${r.group}${r.species ? ` (${r.species.replace(/_/gu, " ")})` : ""} ${r.relation}`;
}

/** One line for a disagreement: who reads what at which text. */
export function describeDisagreement(d: ExtractionDisagreement): string {
  if (d.source === "label_scan") {
    return `the verifier reads "${d.evidence_text}" as ${d.readings.map(readingLabel).join(", ")} and no verified span names it`;
  }
  const lexText = d.lexicon ? `${d.lexicon.group ? `${d.lexicon.group} ` : ""}${d.lexicon.relation}` : "no allergen";
  if (!d.model) return `the verifier reads "${d.evidence_text}" as ${d.readings.map(readingLabel).join(", ")} and the model missed it`;
  const modelText = `${d.model.group} ${d.model.relation}`;
  if (d.unresolved) return `the model reads "${d.evidence_text}" as ${modelText} and the verifier reads an allergen there it cannot place in a group (${lexText})`;
  return `the model reads "${d.evidence_text}" as ${modelText} and the verifier reads ${d.lexicon?.term && d.lexicon.term !== d.evidence_text ? `"${d.lexicon.term}" as ` : ""}${lexText}`;
}

export async function clearSku(gtin: string, market: Market, deps: PipelineDeps, asOf = today()): Promise<ClearResult> {
  const { gateway, dq, ollama, evidence } = deps;
  const log = deps.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const timings: Record<string, number> = {};
  const gaps: string[] = [];
  const card: CardClaim[] = [];
  const contradictions: ContradictionFact[] = [];
  const reviewNotes: { text: string; evidenceIds: string[] }[] = [];
  const incomplete: { step: string; error: string; evidenceIds: string[] }[] = [];
  const checklist: Record<string, boolean> = Object.fromEntries(SKU_CHECKLIST.map((k) => [k, false]));
  const evStart = evidence.all().length;

  const timed = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      timings[step] = (timings[step] ?? 0) + Math.round(performance.now() - t0);
    }
  };
  const fail = (step: string, e: unknown) => {
    const msg = e instanceof GatewayError ? `gateway HTTP ${e.status}: ${e.message.slice(0, 200)}` : (e as Error).message.slice(0, 200);
    incomplete.push({ step, error: msg, evidenceIds: [] });
    gaps.push(`${step} failed: ${msg}`);
    log(`  ! ${step} failed: ${msg}`);
  };

  // 1. product row
  log(`product ${gtin}`);
  let productRow: Record<string, unknown> | null = null;
  let productEv: EvidenceRecord | null = null;
  try {
    const res = await timed("product", () => gateway.template("product", { gtin }));
    productRow = rowsAsObjects(res)[0] ?? null;
    const text = productRow ? str(productRow.ingredients_text)?.trim() || str(productRow.ingredients_text_en)?.trim() || "" : "";
    productEv = evidence.fromTemplate(
      res,
      productRow
        ? `Product row: "${str(productRow.product_name)}" (brand ${str(productRow.brand) ?? "none"}), lang ${str(productRow.lang)}, ingredient text ${text ? `${text.length} chars` : "none"}, labels ${str(productRow.labels) ?? "none"}`
        : `No clearance_usl.product row for ${gtin}`,
    );
    checklist.product_fetched = true;
    card.push({ text: productEv.claim, evidenceIds: [productEv.id] });
  } catch (e) {
    fail("product", e);
  }

  const productName = str(productRow?.product_name);
  const brand = str(productRow?.brand);
  const rawText = str(productRow?.ingredients_text)?.trim() ?? "";
  const rawTextEn = str(productRow?.ingredients_text_en)?.trim() ?? "";
  // The label as printed: ingredients_text (the reference labels are scored on it); the English field only when it is the only text.
  const text = rawText || rawTextEn;
  const textField: ClearResult["product"]["text_field"] = rawText ? "ingredients_text" : rawTextEn ? "ingredients_text_en" : null;
  const hasText = text.length > 0;

  // 2. declared allergens (OFF tags mapped to market codes)
  let declaredRows: Record<string, unknown>[] = [];
  let declaredEv: EvidenceRecord | null = null;
  if (productRow) {
    try {
      const res = await timed("declared", () => gateway.template("declared", { gtin }));
      declaredRows = rowsAsObjects(res).filter((r) => String(r.market_code ?? "").startsWith(`${market}:`));
      const fmt = (rel: string) =>
        declaredRows.filter((r) => r.relation === rel).map((r) => `${groupOfMarketCode(String(r.market_code))}${r.display_name ? "" : " (no statutory match)"}`);
      const c = fmt("contains");
      const m = fmt("may_contain");
      declaredEv = evidence.fromTemplate(
        res,
        `Open Food Facts tags for ${market}: contains [${c.join(", ") || "none"}], may contain [${m.join(", ") || "none"}]`,
        { filter: (r) => String(r.market_code ?? "").startsWith(`${market}:`) },
      );
      card.push({ text: declaredEv.claim, evidenceIds: [declaredEv.id] });
    } catch (e) {
      fail("declared", e);
    }
  }

  // 3. guard: not built yet
  gaps.push("guard_scanned: the injection guard is not built yet; untrusted text is fenced in the prompt but not scanned");

  // 4-5. extraction and verifier
  let extraction: IngredientExtractionResult | null = null;
  let extractionEvId: string | null = null;
  let verifierEvId: string | null = null;
  let extractionReused = false;
  const disagreements: ExtractionDisagreement[] = [];
  if (productRow && hasText) {
    const key = `${ollama.model}|${text.length}|${text}`;
    const memo = deps.extractionMemo?.get(key);
    try {
      if (memo) {
        extraction = memo.result;
        extractionReused = true;
      } else {
        log(`  extract.ingredients (${text.length} chars)`);
        extraction = await timed("extract.ingredients", () => extractIngredients(text, ollama));
      }
      const ex = extraction;
      const exEv = evidence.add({
        kind: "model_extraction",
        claim: ex.ok
          ? `Nemotron read ${ex.spans.length} grounded span(s) from ${textField} (${ex.duplicates} duplicate(s) removed, ${ex.ungrounded.length} ungrounded dropped); label language ${ex.label_language}; ${ex.unparsed_fragments.length} unparsed fragment(s)`
          : `Nemotron gave no valid extraction in ${ex.model.attempts} attempt(s): ${ex.errors.slice(0, 2).join("; ")}`,
        model: ex.model,
        derived_from: productEv ? [productEv.id] : [],
        ...(memo ? { reused: true } : {}),
        details: {
          text_field: textField,
          text_sha256_12: ex.text_sha256_12,
          spans: ex.spans,
          ungrounded: ex.ungrounded,
          unparsed_fragments: ex.unparsed_fragments,
          wall_ms: ex.wall_ms,
          ...(memo ? { reused_from: memo.evidenceId } : {}),
        },
      });
      extractionEvId = exEv.id;
      if (!memo && ex.ok) deps.extractionMemo?.set(key, { result: ex, evidenceId: exEv.id });
      checklist.ingredients_extracted = ex.ok;
      card.push({ text: exEv.claim, evidenceIds: [exEv.id] });

      if (ex.ok) {
        const agreed = ex.agreement.filter((r) => r.agree).length;
        const dis = allergenDisagreements(ex.agreement, text);
        disagreements.push(...dis);
        const rowDis = dis.filter((d) => d.source === "row").length;
        const vEv = evidence.add({
          kind: "verifier",
          claim: `Lexicon verifier: ${agreed} span(s) agree, ${ex.agreement.length - agreed} do not; ${rowDis} allergen disagreement(s) (contains or may contain), ${dis.length - rowDis} further lexicon find(s) checked against the verified spans. Keyword baseline (system K) marks contains: [${ex.keyword_contains.join(", ") || "none"}]`,
          derived_from: [exEv.id],
          details: { agreement: ex.agreement, allergen_disagreements: dis, keyword_contains: ex.keyword_contains },
        });
        verifierEvId = vEv.id;
        checklist.verifier_run = true;
        card.push({ text: vEv.claim, evidenceIds: [vEv.id, exEv.id] });
        // R4 is about the statement, not spans: a disagreement is only a review note when the verified
        // spans already give every reading in it the same entry, qualifier (nut species or cereal) and
        // an equal or stronger relation in this market. Anything else may change the statement: R4.
        const verifiedNow = verifiedAllergens(ex.agreement);
        for (const d of dis) {
          const what = describeDisagreement(d);
          const covered = !d.unresolved && d.readings.every((r) => statementCovers(market, verifiedNow, r));
          if (!covered) {
            contradictions.push({ kind: "model_vs_verifier", text: what, evidenceIds: [vEv.id, exEv.id] });
          } else if (d.source === "row") {
            reviewNotes.push({ text: `span-level disagreement the verified spans already state in ${market}: ${what}`, evidenceIds: [vEv.id, exEv.id] });
          }
        }
      }
    } catch (e) {
      fail("extract.ingredients", e);
    }
  } else if (productRow) {
    gaps.push("extract.ingredients: skipped, the product row has no ingredient text");
  }

  const verified = extraction?.ok ? verifiedAllergens(extraction.agreement) : [];
  const verifiedEvIds = [verifierEvId, extractionEvId].filter((x): x is string => !!x);
  const verifiedContainsFamilies = new Set(verified.filter((v) => v.relation === "contains").map((v) => allergenFamily(v.group)));

  // 6. exact-GTIN recalls and their notices
  const recalls: RecallFact[] = [];
  const notices: ClearResult["notices"] = [];
  const undeclaredByRecall: { recall: string; groups: Group[]; evId: string }[] = [];
  const linkedNumbers = new Set<string>();
  let recallRows: Record<string, unknown>[] = [];
  if (productRow) {
    try {
      const res = await timed("recalls_by_gtin", () => gateway.template("recalls_by_gtin", { gtin }));
      recallRows = rowsAsObjects(res);
      const ev = evidence.fromTemplate(
        res,
        recallRows.length
          ? recallRows
              .map((r) => `FDA ${str(r.recall_number)} (${str(r.classification)}, ${str(r.status)}, reported ${str(r.report_date)}) is linked to this GTIN by ${str(r.transform)} of "${str(r.raw_code)}": ${str(r.reason)}`)
              .join(" | ")
          : "No FDA recall is linked to this GTIN in recall_product_link",
      );
      checklist.recall_check_gtin = true;
      card.push({ text: ev.claim, evidenceIds: [ev.id] });
      for (const r of recallRows) {
        const n = String(r.recall_number);
        linkedNumbers.add(n);
        recalls.push({
          recall_number: n,
          report_date: String(r.report_date),
          status: str(r.status),
          classification: str(r.classification),
          distribution: str(r.distribution),
          evidenceIds: [ev.id],
        });
        const row: NoticeRow = {
          recall_number: n,
          report_date: String(r.report_date),
          classification: str(r.classification),
          status: str(r.status),
          firm: str(r.firm),
          distribution: str(r.distribution),
          product_description: str(r.product_description),
          reason: str(r.reason),
          code_info: str(r.code_info),
        };
        // Rule-against-rule conflicts stated by the notice itself ("tree nut (coconut)").
        for (const rc of ruleConflicts(market, `${row.reason ?? ""}\n${row.product_description ?? ""}`)) {
          pushRuleConflict(rc, `FDA ${n}`, [ev.id]);
        }
        try {
          const memo = deps.noticeMemo?.get(n);
          const nres = memo ? memo.result : await timed("extract.notice", () => extractNotice(row, ollama));
          if (!memo) log(`  extract.notice ${n}`);
          const names = noticeNamesGtin(nres, gtin);
          const nev = evidence.add({
            kind: "model_extraction",
            claim: nres.ok
              ? `Nemotron read FDA ${n}: ${nres.upcs.filter((u) => u.kept).length} UPC(s) kept of ${nres.upcs.length} (literal in the notice and check digit), this GTIN ${names.byModel ? "named" : "not named"} by the model and ${names.byScan ? "found" : "not found"} by the GS1 scan; allergens agreed with the reason text [${nres.allergens_agreed.join(", ") || "none"}], model only [${nres.allergens_model_only.join(", ") || "none"}], reason only [${nres.allergens_reason_only.join(", ") || "none"}]`
              : `Nemotron gave no valid notice extraction for FDA ${n}; the lexicon reads [${nres.reason_groups.join(", ") || "none"}] in the reason`,
            model: nres.model,
            derived_from: [ev.id],
            ...(memo ? { reused: true } : {}),
            details: {
              recall_number: n,
              extraction: nres.extraction,
              upcs: nres.upcs,
              scanned_upcs: nres.scanned_upcs.map((u) => ({ raw: u.raw_code, gtin13: u.gtin13, transform: u.transform })),
              lots_literal: nres.lots_literal,
              lots_not_found: nres.lots_not_found,
              reason_groups: nres.reason_groups,
              undeclared_groups: nres.undeclared_groups,
              coconut_as_tree_nut: nres.coconut_as_tree_nut,
              ...(memo ? { reused_from: memo.evidenceId } : {}),
            },
          });
          if (!memo) deps.noticeMemo?.set(n, { result: nres, evidenceId: nev.id });
          card.push({ text: nev.claim, evidenceIds: [nev.id, ev.id] });
          notices.push({
            recall_number: n,
            ok: nres.ok,
            reused: !!memo,
            upcs_kept: nres.upcs.filter((u) => u.kept).map((u) => u.gtin13!),
            upcs_rejected: nres.upcs.filter((u) => !u.kept).map((u) => u.raw),
            names_this_gtin: names,
            reason_groups: nres.reason_groups,
            undeclared_groups: nres.undeclared_groups,
            allergens_agreed: nres.allergens_agreed,
            allergens_model_only: nres.allergens_model_only,
            allergens_reason_only: nres.allergens_reason_only,
            model: nres.model,
          });
          undeclaredByRecall.push({ recall: n, groups: nres.undeclared_groups, evId: ev.id });
          if (!names.byModel && !names.byScan) {
            gaps.push(`FDA ${n}: neither the model nor the GS1 scan finds ${gtin} in the notice text; the link rests on recall_product_link alone`);
          }
        } catch (e) {
          fail(`extract.notice ${n}`, e);
          // The deterministic reading of the reason does not need the model.
          undeclaredByRecall.push({ recall: n, groups: undeclaredGroups(row.reason ?? "").groups, evId: ev.id });
        }
      }
    } catch (e) {
      fail("recalls_by_gtin", e);
    }
  }

  function pushRuleConflict(rc: RuleConflict, where: string, evIds: string[]) {
    const rev = evidence.add({
      kind: "verifier",
      claim: `Rule-against-rule (${rc.id}, ${market}) in ${where}: "${rc.evidence_text}". ${rc.summary} Handling: ${rc.handling}`,
      derived_from: evIds,
      details: { conflict: rc },
    });
    contradictions.push({ kind: "rule_conflict", text: `${rc.id} in ${where}: ${rc.summary}`, evidenceIds: [rev.id, ...evIds] });
    card.push({ text: rev.claim, evidenceIds: [rev.id, ...evIds] });
  }

  // Rule conflicts in the label text itself.
  if (hasText && productEv) {
    for (const rc of ruleConflicts(market, text)) pushRuleConflict(rc, "the label text", [productEv.id]);
  }

  // 7. name-only matches by brand token
  const nameMatches: NameMatchFact[] = [];
  const tokens = [...new Set((brand ?? "").split(",").map((b) => brandToken(b)).filter((t): t is string => !!t))].slice(0, 2);
  if (productRow && tokens.length === 0) gaps.push("recall_check_brand: no usable brand token on the product row (none, or shorter than 3 characters)");
  for (const token of tokens) {
    try {
      const res = await timed("recalls_by_name", () => gateway.template("recalls_by_name", { brand: token }));
      const rows = rowsAsObjects(res).filter((r) => !linkedNumbers.has(String(r.notice_id)));
      const ev = evidence.fromTemplate(
        res,
        `Brand token "${token}": ${res.row_count} FDA/FSA notice(s) name it (${res.row_count - rows.length} already linked by GTIN, ${rows.length} name-only)`,
      );
      card.push({ text: ev.claim, evidenceIds: [ev.id] });
      for (const r of rows) {
        const title = str(r.title) ?? "";
        nameMatches.push({
          source: String(r.source) === "fsa" ? "fsa" : "fda",
          notice_id: String(r.notice_id),
          notice_date: str(r.notice_date),
          business: str(r.business),
          title: title.slice(0, 200),
          brand_token: token,
          similarity: productName ? Number(bestNameSimilarity(productName, title).toFixed(3)) : 0,
          evidenceIds: [ev.id],
        });
      }
    } catch (e) {
      fail(`recalls_by_name "${token}"`, e);
    }
  }
  if (productRow) checklist.recall_check_brand = tokens.length > 0 && !incomplete.some((s) => s.step.startsWith("recalls_by_name"));

  // 8. DQ gate
  const dqFacts: DqFact[] = [];
  const dqSummary: ClearResult["dq"] = [];
  let dqComplete = false;
  if (productRow) {
    try {
      const results = await timed("dq_gate", () => dq.run(gtin, market));
      for (const r of results) {
        const perMarket = r.spec.perMarket;
        const ev = evidence.fromTemplate(
          r.result,
          `DQ ${r.spec.zetarisRule} on ${r.spec.table} (${r.source === "zetaris_dq" ? "Zetaris DQ, SHOW DQ INVALID RECORD" : `DQ-equivalent SQL for this GTIN${r.fallbackReason ? `, because ${r.fallbackReason}` : ""}`}): ${r.invalid.length ? `${r.invalid.length} invalid record(s) for this GTIN${perMarket ? ` in ${market}` : ""}${perMarket ? `: ${r.invalid.map((x) => String(x.market_code)).join(", ")}` : ""}` : `no invalid record for this GTIN${perMarket ? ` in ${market}` : ""}`}`,
          {
            kind: "dq",
            dqSource: r.source,
            reused: r.reused,
            filter: (row) => row.gtin === gtin && (!perMarket || String(row.market_code ?? "").startsWith(`${market}:`)),
            gtin,
            details: { rule: r.spec.zetarisRule, table: r.spec.table, native_error: r.nativeError, fallback_reason: r.fallbackReason, other_market_rows: r.otherMarket.length },
          },
        );
        dqFacts.push({ rule: r.spec.zetarisRule, table: r.spec.table, invalidRows: r.invalid.length, source: r.source, evidenceIds: [ev.id] });
        dqSummary.push({
          rule: r.spec.zetarisRule,
          table: r.spec.table,
          source: r.source,
          invalid: r.invalid.length,
          other_market: r.otherMarket.length,
          reused: r.reused,
          native_error: r.nativeError,
        });
        card.push({ text: ev.claim, evidenceIds: [ev.id] });
      }
      dqComplete = results.length === 4;
      checklist.dq_checked = dqComplete;
    } catch (e) {
      fail("dq_gate", e);
    }
  }

  // 9. prior decisions (H-MEM rulings are not built yet)
  if (productRow) {
    try {
      const res = await timed("prior_decisions", () => gateway.template("prior_decisions", { gtin }));
      const ev = evidence.fromTemplate(res, `${res.row_count} earlier decision(s) for this GTIN in the ops store`);
      card.push({ text: ev.claim, evidenceIds: [ev.id] });
    } catch (e) {
      fail("prior_decisions", e);
    }
  }
  gaps.push("memory_checked: H-MEM rulings and allergen-polarity conflicts are not built yet; only prior decisions in the ops store were read");

  // 10. claim tests
  const claims = new Set<Claim>([...claimsFromLabels(str(productRow?.labels)), ...(hasText ? claimsFromText(text) : [])]);
  const ingredientState: ClaimEvidence["ingredientText"] = !hasText
    ? "none"
    : !extraction?.ok || (extraction.unparsed_fragments.length ?? 0) > 0
      ? "partial"
      : "full";
  const claimEvidence: ClaimEvidence = {
    ingredientText: ingredientState,
    spans: [
      ...verified.map((v) => ({ evidenceId: verifierEvId ?? "", group: v.group, relation: v.relation, verified: true })),
      // Every allergen reading nobody agreed on, on either side and at either relation, is unverified evidence.
      ...disagreements.flatMap((d) => d.readings.map((r) => ({ evidenceId: verifierEvId ?? "", group: r.group, relation: r.relation, verified: false }))),
    ],
    recalls: undeclaredByRecall.map((u) => ({ evidenceId: u.evId, recallNumber: u.recall, undeclared: u.groups })),
  };
  const claimTests: ClaimTestResult[] = [];
  for (const c of claims) {
    const t = testClaim(c, claimEvidence);
    claimTests.push(t);
    const cev = evidence.add({
      kind: "verifier",
      claim: `Claim "${c}" (${claimsFromLabels(str(productRow?.labels)).includes(c) ? "Open Food Facts labels" : "label text"}): ${t.verdict.replace("_", " ")} (${t.reason}${t.contradicting.length ? `: ${t.contradicting.join(", ")}` : ""})`,
      derived_from: [...new Set([productEv?.id, ...t.evidenceIds].filter((x): x is string => !!x))],
      details: { claim: c, result: t },
    });
    card.push({ text: cev.claim, evidenceIds: [cev.id] });
    if (t.verdict === "NOT_SUPPORTED") {
      contradictions.push({ kind: "claim_not_supported", text: `claim "${c}" is not supported: ${t.contradicting.join(", ")}`, evidenceIds: [cev.id, ...t.evidenceIds] });
    }
  }

  // 11. source against source: recall-undeclared and declared-tag allergens the label text does not verify
  if (hasText && extraction?.ok) {
    for (const u of undeclaredByRecall) {
      for (const g of u.groups) {
        if (verifiedContainsFamilies.has(allergenFamily(g))) continue;
        contradictions.push({
          kind: "recall_vs_label",
          text: `FDA ${u.recall} reports undeclared ${g}; the label text has no verified ${g}`,
          evidenceIds: [u.evId, ...verifiedEvIds],
        });
      }
    }
    // Allergen tags need a verified contains span; traces tags a verified span at either relation.
    const verifiedFamilies = new Set(verified.map((v) => allergenFamily(v.group)));
    for (const r of declaredRows.filter((x) => (x.relation === "contains" || x.relation === "may_contain") && x.display_name)) {
      const g = groupOfMarketCode(String(r.market_code)) as Group;
      const traces = r.relation === "may_contain";
      if ((traces ? verifiedFamilies : verifiedContainsFamilies).has(allergenFamily(g))) continue;
      contradictions.push({
        kind: "declared_vs_extraction",
        text: `Open Food Facts tags declare ${g} (${traces ? "may contain, traces" : "contains"} tag ${str(r.source_tag)}); no verified ${g} span in the label text`,
        evidenceIds: [declaredEv?.id, ...verifiedEvIds].filter((x): x is string => !!x),
      });
    }
  }

  // One contradiction per distinct statement (a word repeated in the label gives one disagreement row per place).
  const seenContra = new Set<string>();
  for (let i = contradictions.length - 1; i >= 0; i--) {
    const k = `${contradictions[i]!.kind}|${contradictions[i]!.text}`;
    if (seenContra.has(k)) contradictions.splice(i, 1);
    seenContra.add(k);
  }

  // 12. policy
  const decision = decide({
    gtin,
    market,
    asOf,
    product: { found: !!productRow, evidenceIds: productEv ? [productEv.id] : [] },
    extraction: productRow
      ? { ok: !!extraction?.ok, hasText, unparsedFragments: extraction?.unparsed_fragments.length ?? 0, evidenceIds: verifiedEvIds }
      : null,
    dqComplete: productRow ? dqComplete : true,
    recalls,
    nameMatches,
    dq: dqFacts,
    contradictions,
    verified: verified.map((v) => ({ group: v.group, relation: v.relation, evidenceIds: verifiedEvIds })),
    incompleteSteps: incomplete,
    reviewNotes: dedupeNotes(reviewNotes),
  });
  checklist.policy_proposed = true;

  const statement =
    hasText && extraction?.ok
      ? buildStatement(
          market,
          verified.map((v) => ({ ...v, evidenceIds: verifiedEvIds })),
          text,
          verifierFindsToConfirm(market, verified, disagreements.flatMap((d) => d.readings), verifiedEvIds),
        )
      : null;

  const nc = notChecked({
    market,
    hasIngredientText: hasText,
    linkedRecalls: recalls.length,
    nameMatches: nameMatches.length,
    sulphiteSeen:
      verified.some((v) => v.group === "sulphite") ||
      declaredRows.some((r) => String(r.market_code).endsWith(":sulphite")) ||
      undeclaredByRecall.some((u) => u.groups.includes("sulphite")),
    brandSearched: tokens.length > 0,
  });

  const firingIds = [...new Set([...decision.firings, ...decision.review].flatMap((f) => f.evidenceIds))];
  const pev = evidence.add({
    kind: "policy",
    claim: `Decision ${decision.status} (${[...new Set(decision.firings.map((f) => f.rule))].join(", ")})${decision.pendingSignature ? ", proposed, pending the officer's signed approval" : ", may be applied automatically"}${statement ? `. Statement draft (${market}): ${statement.text}` : ""}`,
    derived_from: firingIds,
    details: { policy_version: decision.policyVersion, firings: decision.firings, review: decision.review, notes: decision.notes, statement: statement?.text ?? null },
  });
  card.push({ text: pev.claim, evidenceIds: [pev.id, ...firingIds] });
  for (const c of contradictions) card.push({ text: `Contradiction (${c.kind}): ${c.text}`, evidenceIds: c.evidenceIds });

  const mine = evidence.all().slice(evStart);
  const incompleteRecords: Record<string, string[]> = {};
  for (const r of mine) {
    const m = missingFields(r);
    if (m.length) incompleteRecords[r.id] = m;
  }
  const cited = card.filter((c) => c.evidenceIds.length > 0).length;

  return {
    run_id: evidence.runId,
    gtin,
    market,
    as_of: asOf,
    started_at: startedAt,
    product: {
      found: !!productRow,
      name: productName,
      brand,
      lang: str(productRow?.lang),
      has_text: hasText,
      text_field: textField,
      labels: str(productRow?.labels),
    },
    decision,
    statement,
    claim_tests: claimTests,
    contradictions,
    not_checked: nc,
    card,
    extraction: {
      ran: !!extraction,
      reused: extractionReused,
      ok: !!extraction?.ok,
      spans: extraction?.spans.length ?? 0,
      duplicates: extraction?.duplicates ?? 0,
      ungrounded: extraction?.ungrounded.length ?? 0,
      agreed: extraction?.agreement.filter((r) => r.agree).length ?? 0,
      disagreed: extraction?.agreement.filter((r) => !r.agree).length ?? 0,
      unparsed_fragments: extraction?.unparsed_fragments ?? [],
      verified,
      keyword_contains: extraction?.keyword_contains ?? [],
      model: extraction?.model ?? null,
      wall_ms: extraction?.wall_ms ?? 0,
    },
    notices,
    name_matches: nameMatches,
    dq: dqSummary,
    checklist,
    gaps,
    timings_ms: timings,
    evidence_file: evidence.path,
    evidence_ids: mine.map((r) => r.id),
    quality: {
      e_cov: card.length ? cited / card.length : 1,
      claims: card.length,
      e_complete: mine.length ? (mine.length - Object.keys(incompleteRecords).length) / mine.length : 1,
      records: mine.length,
      incomplete_records: incompleteRecords,
    },
  };
}
