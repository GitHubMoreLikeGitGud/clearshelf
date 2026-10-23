// Alias-aware name matching for notices that carry no GTIN (FSA alerts, FDA firm names).
// Step 1 is a pre-filter on normalised brand tokens: a notice is only compared with a
// catalogue brand when they share a distinctive token. Step 2 scores the brand (and every
// alias the World Model holds for it) against the notice text with the reference
// Levenshtein similarity, and step 3 applies the reference merge bands:
//   >= 0.85 auto-link, [0.82, 0.85) officer merge queue, below that a token-only match.
// No band ever changes a listing status: name matches are review items (policy R2).

import { decide, nameSimilarity, normalizeName } from "../../../engines/world-model/reference/src/index.ts";

export const AUTO_LINK_AT = 0.85;
export const REVIEW_FROM = 0.82;

/** Legal-form and filler words that say nothing about which brand a name is. */
const STOPWORDS = new Set([
  "the", "and", "of", "for", "a", "an", "&",
  "ltd", "limited", "llc", "inc", "incorporated", "co", "company", "corp", "corporation", "plc",
  "gmbh", "kg", "ag", "srl", "spa", "sa", "sas", "bv", "nv", "pty", "lp", "llp", "group", "holdings",
  "uk", "us", "usa",
  // Generic trade words: "Halo Foods Limited" says nothing about "Whole Foods Market".
  "food", "foods", "products", "brands", "trading", "international", "global",
]);

/** Lower-case ASCII words: NFKD, combining marks stripped, every non-alphanumeric run a space. */
export function normaliseWords(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return normalizeName(raw)
    .replace(/[^a-z0-9]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 0);
}

/** Distinctive tokens of a brand or business name (stopwords and 1-2 character tokens removed). */
export function brandTokens(raw: string | null | undefined): string[] {
  return [...new Set(normaliseWords(raw).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
}

/** A brand as a tag value: normalised words joined by hyphens ("Skinny crunch" -> "skinny-crunch"). */
export function brandKey(raw: string | null | undefined): string | null {
  const w = normaliseWords(raw);
  return w.length ? w.join("-") : null;
}

/** Every run of `size` consecutive words in the text, as a space-joined string. */
export function wordWindows(words: string[], size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i++) out.push(words.slice(i, i + size).join(" "));
  return out;
}

export type MatchBand = "auto-link" | "review" | "token-only";

export interface BrandCandidate {
  /** World Model entity id of the brand, when the brand is in the graph. */
  brandId?: string;
  /** Canonical name and every alias the sources used. */
  names: string[];
}

export interface BrandScore {
  /** The alias that scored best. */
  alias: string;
  /** The words of the notice text it was compared with. */
  window: string;
  similarity: number;
  band: MatchBand;
  sharedTokens: string[];
}

/**
 * Scores one notice text (title, business or firm) against one brand. Returns null when
 * the pre-filter fails (no shared distinctive token). Otherwise the best similarity of any
 * alias against any window of the text with the alias's word count, plus or minus one word.
 */
export function scoreBrand(text: string, brand: BrandCandidate): BrandScore | null {
  const textWords = normaliseWords(text);
  const textTokens = new Set(textWords.filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
  let best: BrandScore | null = null;
  for (const alias of brand.names) {
    const shared = brandTokens(alias).filter((t) => textTokens.has(t));
    if (shared.length === 0) continue;
    const aliasWords = normaliseWords(alias);
    const aliasText = aliasWords.join(" ");
    for (const size of [aliasWords.length - 1, aliasWords.length, aliasWords.length + 1]) {
      if (size < 1) continue;
      for (const window of wordWindows(textWords, size)) {
        const similarity = Number(nameSimilarity(aliasText, window).toFixed(4));
        if (!best || similarity > best.similarity) {
          best = { alias, window, similarity, band: bandOf(similarity), sharedTokens: shared };
        }
      }
    }
  }
  return best;
}

export function bandOf(similarity: number): MatchBand {
  const d = decide(similarity, AUTO_LINK_AT, REVIEW_FROM);
  return d === "auto-merge" ? "auto-link" : d === "review" ? "review" : "token-only";
}

export interface CatalogueProduct {
  gtin: string;
  name: string | null;
  brand: BrandCandidate | null;
}

export interface NoticeText {
  source: "fda" | "fsa";
  id: string;
  /** FSA title or the first part of the FDA product description. */
  title: string | null;
  /** FSA reporting business or FDA firm. */
  business: string | null;
}

export interface ProductMatch {
  gtin: string;
  notice: string;
  /** Which notice field gave the best brand score. */
  field: "title" | "business";
  brand: BrandScore;
  /** Best similarity of the product name against the notice title and its comma/colon parts (R2 input). */
  nameSimilarity: number;
}

/** Best product-name similarity against a title and each of its comma, semicolon, colon or bracket parts. */
export function titleSimilarity(productName: string | null, title: string | null): number {
  if (!productName || !title) return 0;
  const parts = [title, ...title.split(/[,;:()\n]| - /u)].map((p) => p.trim()).filter((p) => p.length >= 3);
  let best = 0;
  for (const p of parts) best = Math.max(best, nameSimilarity(productName, p));
  return Number(best.toFixed(4));
}

/**
 * Matches one notice against the catalogue. Products without a brand never match by
 * name. Results are sorted by band, then brand similarity, then GTIN.
 */
export function matchNotice(notice: NoticeText, catalogue: CatalogueProduct[]): ProductMatch[] {
  const out: ProductMatch[] = [];
  for (const p of catalogue) {
    if (!p.brand) continue;
    let best: { field: "title" | "business"; score: BrandScore } | null = null;
    for (const field of ["business", "title"] as const) {
      const text = notice[field];
      if (!text) continue;
      const s = scoreBrand(text, p.brand);
      if (s && (!best || s.similarity > best.score.similarity)) best = { field, score: s };
    }
    if (!best) continue;
    out.push({ gtin: p.gtin, notice: notice.id, field: best.field, brand: best.score, nameSimilarity: titleSimilarity(p.name, notice.title) });
  }
  const rank: Record<MatchBand, number> = { "auto-link": 0, review: 1, "token-only": 2 };
  return out.sort((a, b) => rank[a.brand.band] - rank[b.brand.band] || b.brand.similarity - a.brand.similarity || a.gtin.localeCompare(b.gtin));
}
