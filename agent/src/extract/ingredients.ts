// Ingredient extraction: Nemotron reads the label text into spans (schema-constrained),
// repeated spans are removed, spans whose evidence_text is not an exact substring of
// the source (after whitespace and case normalisation) are dropped and counted, and the
// lexicon verifier checks every remaining span. Only spans the verifier agrees with may
// reach a statement; the model never decides.

import { createHash } from "node:crypto";
import type { OllamaClient } from "../llm/ollama.ts";
import { extractionMessages } from "../llm/prompts.ts";
import { extractionSchema, type AllergenGroup, type ExtractionSpan, type IngredientExtraction, type SpanRelation } from "../llm/schemas.ts";
import { dedupeSpans, groundSpans } from "../llm/grounding.ts";
import { jobSettings } from "../llm/settings.ts";
import { keywordBaseline, lexiconScan, verifySpans, type AgreementRow, type LexiconHit } from "../verify/lexicon.ts";
import type { EvidenceModel } from "../evidence/store.ts";

export interface IngredientExtractionResult {
  /** False when the model gave no valid JSON in two attempts; spans are then empty (fallback step). */
  ok: boolean;
  errors: string[];
  label_language: string | null;
  unparsed_fragments: string[];
  /** Model spans after dedupe and grounding. */
  spans: ExtractionSpan[];
  duplicates: number;
  /** Spans dropped by the grounding rule (evidence_text not in the source). */
  ungrounded: ExtractionSpan[];
  agreement: AgreementRow[];
  /** Groups the naive keyword baseline (system K) marks as contains. */
  keyword_contains: string[];
  text_sha256_12: string;
  text_chars: number;
  model: EvidenceModel;
  wall_ms: number;
}

export interface VerifiedAllergen {
  group: Exclude<AllergenGroup, "none">;
  relation: "contains" | "may_contain";
  evidence_text: string;
  term: string | undefined;
  /** Tree-nut species from the lexicon hit under the evidence, when it names one. */
  species?: string;
}

export function textSha12(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

export async function extractIngredients(text: string, ollama: OllamaClient): Promise<IngredientExtractionResult> {
  const settings = jobSettings("ingredient");
  const messages = extractionMessages(text);
  const started = performance.now();
  const outcome = await ollama.chatJson<IngredientExtraction>({
    messages,
    schema: extractionSchema,
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
  const keyword_contains = [...new Set(keywordBaseline(text).map((h) => h.group))];
  const base = { text_sha256_12: textSha12(text), text_chars: text.length, model, wall_ms: Math.round(wall), keyword_contains };

  if (!outcome.ok) {
    return {
      ok: false,
      errors: outcome.errors,
      label_language: null,
      unparsed_fragments: [],
      spans: [],
      duplicates: 0,
      ungrounded: [],
      agreement: [],
      ...base,
    };
  }

  const { unique, duplicates } = dedupeSpans(outcome.value.spans);
  const { kept, dropped } = groundSpans(unique, text);
  const { rows, dropped: verifierDropped } = verifySpans(text, kept);
  return {
    ok: true,
    errors: [],
    label_language: outcome.value.label_language,
    unparsed_fragments: outcome.value.unparsed_fragments,
    spans: kept,
    duplicates,
    ungrounded: [...dropped, ...verifierDropped],
    agreement: rows,
    ...base,
  };
}

function isAllergenRelation(r: SpanRelation | undefined): r is "contains" | "may_contain" {
  return r === "contains" || r === "may_contain";
}

/**
 * Allergens the model and the verifier agree on. The model's group is kept, except
 * that a model gluten_cereal span the verifier matched to a wheat word is reported
 * as wheat, so the statement can name the cereal.
 */
export function verifiedAllergens(rows: AgreementRow[]): VerifiedAllergen[] {
  const out: VerifiedAllergen[] = [];
  for (const r of rows) {
    if (!r.agree || !r.model || r.group === "none" || !isAllergenRelation(r.relation)) continue;
    const hits = lexiconScan(r.term ?? r.evidence_text).filter((h) => h.relation === "contains" || h.relation === "may_contain");
    const wheatWord = hits.some((h) => h.group === "wheat");
    const species = hits.find((h) => h.species)?.species;
    const group = r.group === "gluten_cereal" && wheatWord ? "wheat" : r.group;
    out.push({ group, relation: r.relation, evidence_text: r.evidence_text, term: r.term, ...(species ? { species } : {}) });
  }
  return out;
}

/** One allergen reading of a text, by the model or by the verifier. */
export interface AllergenReading {
  group: Exclude<AllergenGroup, "none">;
  relation: "contains" | "may_contain";
  /** The model's quote, or the lexicon term the verifier matched. */
  evidence_text: string;
  /** The lexicon term under the text, which names the cereal ("spelt") or the nut. */
  term?: string;
  /** Tree-nut species from the lexicon, when the text names one. */
  species?: string;
}

export interface ExtractionDisagreement {
  /**
   * row: an agreement row where the model and the verifier disagree. label_scan: an allergen the
   * lexicon finds in the label that no row accounts for (a second cereal or nut inside an agreed
   * span, or a hit under a disagreeing span that the row does not show).
   */
  source: "row" | "label_scan";
  /** The model's quote, or the lexicon term when the model quoted nothing there. */
  evidence_text: string;
  /** What the model said at this text; null when it quoted nothing there (it missed the verifier's find). */
  model: { group: AllergenGroup; relation: SpanRelation } | null;
  /** What the verifier reads at this text; null when the lexicon has nothing there. */
  lexicon: { group: AllergenGroup | null; relation: SpanRelation; term?: string } | null;
  /**
   * The allergen readings no agreed span confirms: the model's allergen the verifier does not
   * confirm, and the verifier's allergen (contains or may contain) the model did not agree with.
   */
  readings: AllergenReading[];
  /** The verifier reads an allergen here that could not be placed in a group; the caller must hold. */
  unresolved: boolean;
}

function compatibleGroups(a: AllergenGroup, b: AllergenGroup): boolean {
  return a === b || (a === "gluten_cereal" && b === "wheat") || (a === "wheat" && b === "gluten_cereal");
}

/** The lexicon hit in the label behind a row's term and relation, preferring the row's own group. */
function hitFor(hits: LexiconHit[], term: string | undefined, relation: SpanRelation | undefined, group: AllergenGroup): LexiconHit | undefined {
  if (!term || !relation) return undefined;
  const cands = hits.filter((h) => h.term === term && h.relation === relation);
  return cands.find((h) => compatibleGroups(group, h.group)) ?? cands[0];
}

/** The model's own allergen reading of its quote, with the cereal or nut the lexicon sees in it. */
function modelReading(r: AgreementRow & { group: Exclude<AllergenGroup, "none">; relation: "contains" | "may_contain" }): AllergenReading {
  const hit = lexiconScan(r.evidence_text).find((h) => isAllergenRelation(h.relation) && compatibleGroups(r.group, h.group));
  const group = r.group === "gluten_cereal" && hit?.group === "wheat" ? "wheat" : r.group;
  return { group, relation: r.relation, evidence_text: r.evidence_text, ...(hit ? { term: hit.term } : {}), ...(hit?.species ? { species: hit.species } : {}) };
}

function hitReading(h: LexiconHit & { relation: "contains" | "may_contain" }): AllergenReading {
  return { group: h.group, relation: h.relation, evidence_text: h.term, term: h.term, ...(h.species ? { species: h.species } : {}) };
}

/**
 * Every disagreement between the model and the verifier that puts an allergen at stake, at
 * contains or may-contain level, on either side: the verifier's find the model missed or called
 * something else, and the model's allergen the verifier does not confirm. Then every allergen the
 * lexicon finds in the label that no row accounts for (`label_scan`): the caller checks those
 * against the verified spans too, so no lexicon find can drop out unseen. `text` is the label
 * text the rows were verified against.
 */
export function allergenDisagreements(rows: AgreementRow[], text: string): ExtractionDisagreement[] {
  const hits = lexiconScan(text);
  const out: ExtractionDisagreement[] = [];
  for (const r of rows) {
    if (r.agree) continue;
    const readings: AllergenReading[] = [];
    let unresolved = false;
    let lexicon: ExtractionDisagreement["lexicon"] = null;
    if (r.model) {
      if (r.group !== "none" && isAllergenRelation(r.relation)) readings.push(modelReading({ ...r, group: r.group, relation: r.relation }));
      if (r.lexicon && r.lexicon_relation) {
        const h = hitFor(hits, r.term, r.lexicon_relation, r.group);
        lexicon = { group: h?.group ?? null, relation: r.lexicon_relation, ...(r.term ? { term: r.term } : {}) };
        if (isAllergenRelation(r.lexicon_relation)) {
          const group = h?.group ?? (r.group !== "none" ? r.group : null);
          if (group) {
            readings.push({
              group,
              relation: r.lexicon_relation,
              evidence_text: r.term ?? r.evidence_text,
              ...(r.term ? { term: r.term } : {}),
              ...(h?.species ? { species: h.species } : {}),
            });
          } else {
            unresolved = true;
          }
        }
      }
    } else if (r.group !== "none" && isAllergenRelation(r.relation)) {
      const h = hitFor(hits, r.term ?? r.evidence_text, r.relation, r.group);
      lexicon = { group: r.group, relation: r.relation, ...(r.term ? { term: r.term } : {}) };
      readings.push({
        group: r.group,
        relation: r.relation,
        evidence_text: r.evidence_text,
        ...(r.term ? { term: r.term } : {}),
        ...(h?.species ? { species: h.species } : {}),
      });
    }
    if (readings.length === 0 && !unresolved) continue;
    out.push({ source: "row", evidence_text: r.evidence_text, model: r.model ? { group: r.group, relation: r.relation } : null, lexicon, readings, unresolved });
  }

  const key = (group: AllergenGroup, relation: SpanRelation, term: string | undefined) => `${group}|${relation}|${term ?? ""}`;
  const accounted = new Set(out.flatMap((d) => d.readings.map((x) => key(x.group, x.relation, x.term))));
  const seen = new Set<string>();
  for (const h of hits) {
    if (!isAllergenRelation(h.relation)) continue;
    const k = key(h.group, h.relation, h.term);
    if (accounted.has(k) || seen.has(k)) continue;
    // The term an agreed row was verified on.
    if (rows.some((r) => r.agree && r.term === h.term && r.relation === h.relation && compatibleGroups(r.group, h.group))) continue;
    seen.add(k);
    out.push({
      source: "label_scan",
      evidence_text: h.term,
      model: null,
      lexicon: { group: h.group, relation: h.relation, term: h.term },
      readings: [hitReading({ ...h, relation: h.relation })],
      unresolved: false,
    });
  }
  return out;
}
