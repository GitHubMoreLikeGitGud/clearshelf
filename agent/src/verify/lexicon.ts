/** Lexicon scan, span verification against lexicon hits, and naive keyword baseline. */

import { isGrounded, normaliseForGrounding } from "../llm/grounding.ts";
import type { AllergenGroup, ExtractionSpan, SpanRelation } from "../llm/schemas.ts";
import {
  ALLERGEN_TERMS,
  FREE_FROM_PATTERNS,
  PRECAUTIONARY_PATTERNS,
  RULE_TERMS,
  TRAP_TERMS,
  type LexLang,
} from "./lexicon.data.ts";

export { isGrounded };

export interface LexiconHit {
  group: Exclude<AllergenGroup, "none">;
  relation: SpanRelation;
  term: string;
  lang: LexLang;
  start: number;
  end: number;
  species?: string;
  trap?: { term: string; reason: string };
  ruleConflict?: string;
  claim?: string;
}

export interface AgreementRow {
  group: AllergenGroup;
  relation: SpanRelation;
  model: boolean;
  lexicon: boolean;
  agree: boolean;
  evidence_text: string;
  grounded: true;
  lexicon_relation?: SpanRelation;
  term?: string;
}

interface RawMatch {
  start: number;
  end: number;
  term: string;
  lang: LexLang;
  group: Exclude<AllergenGroup, "none">;
  species?: string;
  kind: "allergen" | "trap" | "rule" | "free_from";
  reason?: string;
  ruleConflict?: string;
  claim?: string;
}

function isLetter(ch: string | undefined): boolean {
  return !!ch && /\p{L}/u.test(ch);
}

function findTermMatches(
  text: string,
  term: string,
  lang: LexLang,
  matchMode: "compound" | "word",
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const lower = text.toLocaleLowerCase("und");
  const needle = term.normalize("NFC").toLocaleLowerCase("und");
  if (!needle) return out;
  let from = 0;
  while (from <= lower.length - needle.length) {
    const idx = lower.indexOf(needle, from);
    if (idx < 0) break;
    const end = idx + needle.length;
    const deCompound = lang === "de" && matchMode === "compound";
    const before = text[idx - 1];
    const after = text[end];
    if (deCompound) {
      out.push({ start: idx, end });
    } else if (!isLetter(before) && !isLetter(after)) {
      out.push({ start: idx, end });
    }
    from = idx + 1;
  }
  return out;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Sentence end: full stop not between digits, semicolon, line break, or EOS. German also ends after enthalten. */
function scopeEnd(text: string, from: number, lang: LexLang): number {
  let sentenceEnd = text.length;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === ";" || ch === "\n" || ch === "\r") {
      sentenceEnd = i;
      break;
    }
    if (ch === ".") {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (prev && next && /\d/u.test(prev) && /\d/u.test(next)) continue;
      sentenceEnd = i;
      break;
    }
  }
  if (lang === "de") {
    // Only an "enthalten" inside the same sentence closes the clause early.
    const ent = text.slice(from, sentenceEnd).search(/enthalten/iu);
    if (ent >= 0) return from + ent + "enthalten".length;
  }
  return sentenceEnd;
}

function collectPrecautionaryScopes(text: string): { start: number; end: number; lang: LexLang }[] {
  const scopes: { start: number; end: number; lang: LexLang }[] = [];
  // Longer / more specific patterns first (array order in data file).
  for (const p of PRECAUTIONARY_PATTERNS) {
    const re = new RegExp(p.source, "giu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = scopeEnd(text, start + m[0].length, p.lang);
      scopes.push({ start, end, lang: p.lang });
    }
  }
  return scopes;
}

function inAnyScope(pos: { start: number; end: number }, scopes: { start: number; end: number }[]): boolean {
  return scopes.some((s) => pos.start >= s.start && pos.start < s.end);
}

function collectRawMatches(text: string): RawMatch[] {
  const raw: RawMatch[] = [];

  for (const t of TRAP_TERMS) {
    const mode = t.lang === "de" ? "compound" : "word";
    for (const m of findTermMatches(text, t.term, t.lang, mode)) {
      raw.push({
        start: m.start,
        end: m.end,
        term: t.term,
        lang: t.lang,
        group: t.group,
        kind: "trap",
        reason: t.reason,
      });
    }
  }

  for (const t of RULE_TERMS) {
    const mode = t.lang === "de" ? "compound" : "word";
    for (const m of findTermMatches(text, t.term, t.lang, mode)) {
      raw.push({
        start: m.start,
        end: m.end,
        term: t.term,
        lang: t.lang,
        group: t.group,
        kind: "rule",
        reason: t.reason,
        ruleConflict: t.ruleConflict,
      });
    }
  }

  for (const t of ALLERGEN_TERMS) {
    const mode = t.match ?? (t.lang === "de" ? "compound" : "word");
    for (const m of findTermMatches(text, t.term, t.lang, mode)) {
      raw.push({
        start: m.start,
        end: m.end,
        term: t.term,
        lang: t.lang,
        group: t.group,
        species: t.species,
        kind: "allergen",
      });
    }
  }

  for (const p of FREE_FROM_PATTERNS) {
    const re = new RegExp(p.source, "giu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      raw.push({
        start: m.index,
        end: m.index + m[0].length,
        term: m[0],
        lang: p.lang,
        group: p.group ?? "milk",
        kind: "free_from",
        claim: p.claim,
      });
    }
  }

  return raw;
}

function preferLang(a: LexLang, b: LexLang, preferred?: LexLang): LexLang {
  if (preferred && a === preferred) return a;
  if (preferred && b === preferred) return b;
  return a;
}

export function lexiconScan(text: string, lang?: LexLang): LexiconHit[] {
  const nfc = text.normalize("NFC");
  const scopes = collectPrecautionaryScopes(nfc);
  const raw = collectRawMatches(nfc);

  const traps = raw.filter((r) => r.kind === "trap");
  const rules = raw.filter((r) => r.kind === "rule");
  const allergens = raw.filter((r) => r.kind === "allergen");
  const freeFrom = raw.filter((r) => r.kind === "free_from");

  const hits: LexiconHit[] = [];

  // Traps: not_allergen for the group they resemble.
  for (const t of traps) {
    hits.push({
      group: t.group,
      relation: "not_allergen",
      term: nfc.slice(t.start, t.end),
      lang: t.lang,
      start: t.start,
      end: t.end,
      trap: { term: t.term, reason: t.reason ?? "" },
    });
  }

  // Rule terms.
  for (const r of rules) {
    hits.push({
      group: r.group,
      relation: "not_allergen",
      term: nfc.slice(r.start, r.end),
      lang: r.lang,
      start: r.start,
      end: r.end,
      ruleConflict: r.ruleConflict,
    });
  }

  // Free-from claims.
  for (const f of freeFrom) {
    hits.push({
      group: f.group,
      relation: "free_from_claim",
      term: nfc.slice(f.start, f.end),
      lang: f.lang,
      start: f.start,
      end: f.end,
      claim: f.claim,
    });
  }

  // Allergen contains / may_contain, suppressed where a trap or rule overlaps.
  for (const a of allergens) {
    const suppressedByTrap = traps.some((t) => overlaps(a, t) && t.group === a.group);
    const suppressedByRule = rules.some((r) => overlaps(a, r) && r.group === a.group);
    // A word inside a free-from claim ("gluten" in "gluten-free", "Milch" in "milchfrei") is not an ingredient.
    const suppressedByFreeFrom = freeFrom.some((f) => overlaps(a, f));
    if (suppressedByTrap || suppressedByRule || suppressedByFreeFrom) continue;

    // Prefer longer term matches at the same span (e.g. "brazil nut" over "nut").
    const dominated = allergens.some(
      (o) =>
        o !== a &&
        o.group === a.group &&
        o.start <= a.start &&
        o.end >= a.end &&
        o.end - o.start > a.end - a.start,
    );
    if (dominated) continue;

    const relation: SpanRelation = inAnyScope(a, scopes) ? "may_contain" : "contains";
    hits.push({
      group: a.group,
      relation,
      term: nfc.slice(a.start, a.end),
      lang: lang ? preferLang(a.lang, a.lang, lang) : a.lang,
      start: a.start,
      end: a.end,
      species: a.species,
    });
  }

  // Dedupe identical hits (same start/end/group/relation), preferring preferred lang.
  const byKey = new Map<string, LexiconHit>();
  for (const h of hits) {
    const key = `${h.start}:${h.end}:${h.group}:${h.relation}:${h.claim ?? ""}:${h.ruleConflict ?? ""}:${h.trap?.term ?? ""}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, h);
      continue;
    }
    if (lang && h.lang === lang && prev.lang !== lang) byKey.set(key, h);
  }

  return [...byKey.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

function locateEvidence(nfc: string, evidence: string): { start: number; end: number } | null {
  const normE = normaliseForGrounding(evidence);
  if (!normE) return null;
  // Walk NFC text with the same normalisation collapsing whitespace.
  const lower = nfc.toLocaleLowerCase("und");
  const needle = evidence.normalize("NFC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("und");
  if (!needle) return null;

  // Try exact case-insensitive substring first (common path).
  const idx = lower.indexOf(needle);
  if (idx >= 0) return { start: idx, end: idx + needle.length };

  // Whitespace-flexible: find by scanning normalised windows.
  const parts = needle.split(" ").filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0]!;
  let from = 0;
  while (from < lower.length) {
    const i = lower.indexOf(first, from);
    if (i < 0) break;
    let cursor = i + first.length;
    let ok = true;
    for (let p = 1; p < parts.length; p++) {
      while (cursor < nfc.length && /\s/u.test(nfc[cursor]!)) cursor++;
      const part = parts[p]!;
      if (lower.slice(cursor, cursor + part.length) !== part) {
        ok = false;
        break;
      }
      cursor += part.length;
    }
    if (ok) return { start: i, end: cursor };
    from = i + 1;
  }
  return null;
}

function groupsCompatible(model: AllergenGroup, lexicon: AllergenGroup, lexiconIsWheatTerm: boolean): boolean {
  if (model === lexicon) return true;
  if (lexiconIsWheatTerm && model === "gluten_cereal" && lexicon === "wheat") return true;
  if (lexiconIsWheatTerm && model === "wheat" && lexicon === "gluten_cereal") return true;
  return false;
}

export function verifySpans(
  text: string,
  spans: ExtractionSpan[],
): { rows: AgreementRow[]; dropped: ExtractionSpan[]; droppedCount: number } {
  const nfc = text.normalize("NFC");
  const hits = lexiconScan(nfc);
  const dropped: ExtractionSpan[] = [];
  const rows: AgreementRow[] = [];
  const coveredHitKeys = new Set<string>();

  for (const span of spans) {
    if (!isGrounded(span.evidence_text, nfc)) {
      dropped.push(span);
      continue;
    }
    const loc = locateEvidence(nfc, span.evidence_text);
    if (!loc) {
      dropped.push(span);
      continue;
    }

    const overlapping = hits.filter((h) => overlaps(loc, h));
    // Every lexicon hit of a compatible group under this span is accounted for by this row,
    // whether or not the relations agree, so it is not reported again as missed.
    for (const h of overlapping) {
      if (groupsCompatible(span.allergen_group, h.group, h.group === "wheat")) {
        coveredHitKeys.add(`${h.start}:${h.end}:${h.group}:${h.relation}`);
      }
    }
    const trapOrRule = overlapping.filter((h) => h.relation === "not_allergen");
    const sameRelation = overlapping.filter((h) => {
      const wheatTerm = h.group === "wheat";
      return groupsCompatible(span.allergen_group, h.group, wheatTerm) && h.relation === span.relation;
    });

    // A real hit inside the span wins over a trap elsewhere in the same span ("cocoa butter, milk powder").
    if (sameRelation.length > 0) {
      const h = sameRelation[0]!;
      for (const s of sameRelation) coveredHitKeys.add(`${s.start}:${s.end}:${s.group}:${s.relation}`);
      rows.push({
        group: span.allergen_group,
        relation: span.relation,
        model: true,
        lexicon: true,
        agree: true,
        evidence_text: span.evidence_text,
        grounded: true,
        lexicon_relation: h.relation,
        term: h.term,
      });
      continue;
    }

    if (span.relation === "contains" && trapOrRule.some((h) => groupsCompatible(span.allergen_group, h.group, h.group === "wheat"))) {
      const t = trapOrRule.find((h) => groupsCompatible(span.allergen_group, h.group, h.group === "wheat"))!;
      rows.push({
        group: span.allergen_group,
        relation: span.relation,
        model: true,
        lexicon: true,
        agree: false,
        evidence_text: span.evidence_text,
        grounded: true,
        lexicon_relation: t.relation,
        term: t.term,
      });
      continue;
    }

    // Model asserted something with no matching lexicon relation at this location.
    const any = overlapping[0];
    rows.push({
      group: span.allergen_group,
      relation: span.relation,
      model: true,
      lexicon: !!any,
      agree: false,
      evidence_text: span.evidence_text,
      grounded: true,
      lexicon_relation: any?.relation,
      term: any?.term,
    });
  }

  for (const h of hits) {
    if (h.relation !== "contains" && h.relation !== "may_contain") continue;
    const key = `${h.start}:${h.end}:${h.group}:${h.relation}`;
    if (coveredHitKeys.has(key)) continue;
    rows.push({
      group: h.group,
      relation: h.relation,
      model: false,
      lexicon: true,
      agree: false,
      evidence_text: h.term,
      grounded: true,
      lexicon_relation: h.relation,
      term: h.term,
    });
  }

  return { rows, dropped, droppedCount: dropped.length };
}

/** System K: plain keyword matches; every hit is contains; traps and scope ignored. */
export function keywordBaseline(text: string): { group: Exclude<AllergenGroup, "none">; term: string; start: number; end: number }[] {
  const nfc = text.normalize("NFC");
  const out: { group: Exclude<AllergenGroup, "none">; term: string; start: number; end: number }[] = [];
  for (const t of ALLERGEN_TERMS) {
    const mode = t.match ?? (t.lang === "de" ? "compound" : "word");
    for (const m of findTermMatches(nfc, t.term, t.lang, mode)) {
      out.push({ group: t.group, term: nfc.slice(m.start, m.end), start: m.start, end: m.end });
    }
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  // Dedupe identical spans.
  const seen = new Set<string>();
  return out.filter((h) => {
    const k = `${h.start}:${h.end}:${h.group}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
