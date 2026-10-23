// Statement builder: deterministic, from verified spans only.
// UK: "Contains: ..." with Annex II names ("Cereals containing gluten (wheat)", "Nuts (almond)"),
//     "May contain: ...", and the ingredient list with allergen words in bold.
// US: "Contains: ..." with FALCPA names: wheat (never "gluten"), tree-nut species named,
//     coconut and other non-Table-1 nuts left out (they stay in the ingredient list), and
//     groups that are not US major food allergens left out.

import { displayName, isMajorAllergen } from "../verify/jurisdiction.ts";
import type { Market } from "./decide.ts";

export interface StatementSpan {
  group: string;
  relation: "contains" | "may_contain";
  evidence_text: string;
  term?: string;
  species?: string;
  evidenceIds: string[];
}

export interface StatementEntry {
  /** Statement heading, e.g. "Cereals containing gluten" or "Tree nuts". */
  name: string;
  /** The text shown, with any qualifier, e.g. "Cereals containing gluten (wheat, barley)". */
  label: string;
  groups: string[];
  evidenceIds: string[];
}

export interface ExcludedEntry {
  group: string;
  species?: string;
  evidence_text: string;
  reason: string;
  evidenceIds: string[];
}

export interface Statement {
  market: Market;
  contains: StatementEntry[];
  mayContain: StatementEntry[];
  /**
   * Contains-level allergens the deterministic verifier found and no verified span states (the
   * model missed or contradicted them). They are in the draft marked "(to confirm)", so a draft
   * never under-declares; the disagreement holds the SKU (R4) until the officer resolves it.
   */
  toConfirm: StatementEntry[];
  excluded: ExcludedEntry[];
  text: string;
  /** The ingredient list with each verified contains phrase in **bold**; null without text. */
  ingredientsMarked: string | null;
}

// Display order: the order of each market's statutory list.
const ORDER: Record<Market, string[]> = {
  UK: ["gluten_cereal", "crustacean", "egg", "fish", "peanut", "soy", "milk", "tree_nut", "celery", "mustard", "sesame", "sulphite", "lupin", "mollusc"],
  US: ["milk", "egg", "fish", "crustacean", "tree_nut", "wheat", "peanut", "soy", "sesame"],
};

const CEREALS: [RegExp, string][] = [
  [/\b(?:rye|roggen|seigle|segale|centeno)/iu, "rye"],
  [/\b(?:barley|gerste|orge|orzo|cebada|malt|malz|malto|malta)/iu, "barley"],
  [/\b(?:oats?|hafer|avoine|avena)/iu, "oats"],
  [/\b(?:spelt|dinkel|épeautre|farro|espelta)/iu, "spelt"],
  [/\b(?:khorasan|kamut)/iu, "khorasan wheat"],
];

function cerealIn(text: string): string | null {
  for (const [re, name] of CEREALS) if (re.test(text)) return name;
  return null;
}

/** The cereal a span names: its lexicon term first ("spelt" and "Dinkel" are wheat words the statement names as spelt), then wheat, then its text. */
function cerealName(span: Pick<StatementSpan, "group" | "term" | "evidence_text">): string | null {
  const fromTerm = span.term ? cerealIn(span.term) : null;
  if (fromTerm) return fromTerm;
  if (span.group === "wheat") return "wheat";
  return cerealIn(`${span.term ?? ""} ${span.evidence_text}`);
}

function speciesLabel(s: string): string {
  return s.replace(/_/gu, " ");
}

type EntrySpan = Pick<StatementSpan, "group" | "evidence_text" | "term" | "species">;

/** The statement entry a span gets in a market, with its qualifier (cereal or nut species), or why the market's statement leaves it out. */
function entryOf(market: Market, s: EntrySpan): { key: string; name: string; qualifier: string | null } | { excluded: string } {
  if (market === "UK") {
    if (s.group === "wheat" || s.group === "gluten_cereal") {
      const base = displayName("UK", "gluten_cereal");
      return base ? { key: "gluten_cereal", name: base, qualifier: cerealName(s) } : { excluded: "no UK statutory allergen for this group" };
    }
    if (s.group === "tree_nut") {
      if (s.species && !isMajorAllergen("UK", "tree_nut", s.species)) return { excluded: "not an Annex II nut; named in the ingredient list only" };
      return { key: "tree_nut", name: displayName("UK", "tree_nut") ?? "Nuts", qualifier: s.species ? speciesLabel(s.species) : null };
    }
    const name = displayName("UK", s.group);
    return name ? { key: s.group, name, qualifier: null } : { excluded: "no UK statutory allergen for this group" };
  }
  if (s.group === "gluten_cereal") return { excluded: "not a US major food allergen (only wheat is); stays in the ingredient list" };
  if (s.group === "tree_nut") {
    if (s.species && !isMajorAllergen("US", "tree_nut", s.species)) return { excluded: "not on the FDA Table 1 tree-nut list; stays in the ingredient list" };
    return { key: "tree_nut", name: displayName("US", "tree_nut") ?? "Tree nuts", qualifier: s.species ? speciesLabel(s.species) : null };
  }
  const name = isMajorAllergen("US", s.group) ? displayName("US", s.group) : null;
  return name ? { key: s.group, name, qualifier: null } : { excluded: "not a US major food allergen; stays in the ingredient list" };
}

function addEntry(map: Map<string, { name: string; quals: string[]; groups: Set<string>; ev: Set<string> }>, key: string, name: string, qual: string | null, span: StatementSpan): void {
  let e = map.get(key);
  if (!e) {
    e = { name, quals: [], groups: new Set(), ev: new Set() };
    map.set(key, e);
  }
  if (qual && !e.quals.includes(qual)) e.quals.push(qual);
  e.groups.add(span.group);
  for (const id of span.evidenceIds) e.ev.add(id);
}

function entriesFor(market: Market, spans: StatementSpan[], excluded: ExcludedEntry[]): StatementEntry[] {
  const map = new Map<string, { name: string; quals: string[]; groups: Set<string>; ev: Set<string> }>();
  for (const s of spans) {
    const e = entryOf(market, s);
    if ("excluded" in e) {
      excluded.push({
        group: s.group,
        ...(s.group === "tree_nut" && s.species ? { species: s.species } : {}),
        evidence_text: s.evidence_text,
        reason: e.excluded,
        evidenceIds: s.evidenceIds,
      });
      continue;
    }
    addEntry(map, e.key, e.name, e.qualifier, s);
  }
  const order = ORDER[market];
  return [...map.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([, e]) => ({
      name: e.name,
      label: e.quals.length ? `${e.name} (${e.quals.join(", ")})` : e.name,
      groups: [...e.groups],
      evidenceIds: [...e.ev],
    }));
}

function familyKey(group: string): string {
  return group === "wheat" ? "gluten_cereal" : group;
}

const RELATION_RANK = { may_contain: 1, contains: 2 } as const;

/**
 * Whether a statement built from `verified` already says everything `reading` would add, so a
 * span the model and the verifier disagree on changes neither the decision nor the statement:
 * a verified span of the same allergen family at the same or a stronger relation and, unless
 * the market's statement leaves the reading out, the same entry with the reading's qualifier
 * (nut species or cereal) at that relation or stronger.
 */
export function statementCovers(
  market: Market,
  verified: (EntrySpan & { relation: "contains" | "may_contain" })[],
  reading: EntrySpan & { relation: "contains" | "may_contain" },
): boolean {
  const strong = verified.filter((v) => RELATION_RANK[v.relation] >= RELATION_RANK[reading.relation]);
  if (!strong.some((v) => familyKey(v.group) === familyKey(reading.group))) return false;
  const e = entryOf(market, reading);
  if ("excluded" in e) return true;
  return strong.some((v) => {
    const ve = entryOf(market, v);
    return !("excluded" in ve) && ve.key === e.key && (e.qualifier === null || ve.qualifier === e.qualifier);
  });
}

/** Marks every case-insensitive occurrence of each phrase in **bold**, longest phrases first, without overlaps. */
export function markIngredients(text: string, phrases: string[]): string {
  const ranges: [number, number][] = [];
  const lower = text.toLocaleLowerCase("und");
  for (const p of [...new Set(phrases)].sort((a, b) => b.length - a.length)) {
    const needle = p.toLocaleLowerCase("und");
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const i = lower.indexOf(needle, from);
      if (i < 0) break;
      const end = i + needle.length;
      if (!ranges.some(([s, e]) => i < e && s < end)) ranges.push([i, end]);
      from = i + 1;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [s, e] of ranges) {
    out += `${text.slice(at, s)}**${text.slice(s, e)}**`;
    at = e;
  }
  return out + text.slice(at);
}

export const TO_CONFIRM = "(to confirm)";

/**
 * The verifier's contains-level readings that the verified spans do not already state in this
 * market: the entries a draft adds marked "(to confirm)". Model-only readings are left out (the
 * deterministic verifier did not find them); so are readings the verified statement covers.
 */
export function verifierFindsToConfirm(
  market: Market,
  verified: (EntrySpan & { relation: "contains" | "may_contain" })[],
  readings: (EntrySpan & { relation: "contains" | "may_contain"; by?: "model" | "verifier" })[],
  evidenceIds: string[],
): StatementSpan[] {
  const out: StatementSpan[] = [];
  const seen = new Set<string>();
  for (const r of readings) {
    if (r.by !== "verifier" || r.relation !== "contains" || statementCovers(market, verified, r)) continue;
    const k = `${r.group}|${r.species ?? ""}|${r.term ?? r.evidence_text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ group: r.group, relation: "contains", evidence_text: r.evidence_text, ...(r.term ? { term: r.term } : {}), ...(r.species ? { species: r.species } : {}), evidenceIds });
  }
  return out;
}

export function buildStatement(market: Market, spans: StatementSpan[], ingredientsText: string | null, toConfirmSpans: StatementSpan[] = []): Statement {
  const excluded: ExcludedEntry[] = [];
  const containsSpans = spans.filter((s) => s.relation === "contains");
  const containsFamilies = new Set([...containsSpans, ...toConfirmSpans].map((s) => familyKey(s.group)));
  // An allergen the label already contains (or may contain, to confirm) is not repeated under "May contain".
  const maySpans = spans.filter((s) => s.relation === "may_contain" && !containsFamilies.has(familyKey(s.group)));
  const contains = entriesFor(market, containsSpans, excluded);
  const mayContain = entriesFor(market, maySpans, excluded);
  // A to-confirm entry whose label the verified "Contains" already shows adds nothing.
  const shown = new Set(contains.map((e) => e.label));
  const toConfirm = entriesFor(market, toConfirmSpans, excluded).filter((e) => !shown.has(e.label));
  const order = ORDER[market];
  const rank = (e: StatementEntry) => Math.min(...e.groups.map((g) => order.indexOf(familyKey(g)) >= 0 ? order.indexOf(familyKey(g)) : order.indexOf(g)));
  const containsShown = [...contains.map((e) => ({ e, label: e.label })), ...toConfirm.map((e) => ({ e, label: `${e.label} ${TO_CONFIRM}` }))].sort((a, b) => rank(a.e) - rank(b.e));
  const parts: string[] = [];
  if (containsShown.length) parts.push(`Contains: ${containsShown.map((x) => x.label).join(", ")}.`);
  if (mayContain.length) parts.push(`May contain: ${mayContain.map((e) => e.label).join(", ")}.`);
  const text = parts.join(" ") || "No allergens declared.";
  const ingredientsMarked = ingredientsText ? markIngredients(ingredientsText, containsSpans.map((s) => s.evidence_text)) : null;
  return { market, contains, mayContain, toConfirm, excluded, text, ingredientsMarked };
}
