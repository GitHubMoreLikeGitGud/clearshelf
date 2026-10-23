// Grounding rule for extraction spans: evidence_text must be an exact substring of
// the source text after whitespace and case normalisation, otherwise the span is
// dropped and counted. Nothing is fuzzy-matched.

import type { ExtractionSpan } from "./schemas.ts";

export function normaliseForGrounding(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("und");
}

export function isGrounded(evidence: string, source: string): boolean {
  const e = normaliseForGrounding(evidence);
  return e.length > 0 && normaliseForGrounding(source).includes(e);
}

export interface GroundingResult {
  kept: ExtractionSpan[];
  dropped: ExtractionSpan[];
}

/**
 * Removes repeated spans (same normalised evidence text, group and relation), keeping
 * the first. A 4B reply can loop on one span until the schema's maxItems closes it, so
 * extraction dedupes before verifying.
 */
export function dedupeSpans(spans: ExtractionSpan[]): { unique: ExtractionSpan[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: ExtractionSpan[] = [];
  for (const span of spans) {
    const key = `${normaliseForGrounding(span.evidence_text)}\u0000${span.allergen_group}\u0000${span.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(span);
  }
  return { unique, duplicates: spans.length - unique.length };
}

export function groundSpans(spans: ExtractionSpan[], source: string): GroundingResult {
  const normSource = normaliseForGrounding(source);
  const kept: ExtractionSpan[] = [];
  const dropped: ExtractionSpan[] = [];
  for (const span of spans) {
    const e = normaliseForGrounding(span.evidence_text);
    (e.length > 0 && normSource.includes(e) ? kept : dropped).push(span);
  }
  return { kept, dropped };
}
