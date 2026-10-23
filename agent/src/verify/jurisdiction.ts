/** UK/US major-allergen jurisdiction from data/reference/market_allergens.json only. */

import { readFileSync } from "node:fs";
import type { AllergenGroup } from "../llm/schemas.ts";

type Market = "UK" | "US";

interface RefRow {
  market_code: string;
  market: Market;
  allergen: string;
  display_name: string;
  includes?: string[];
  excludes?: string[];
}

interface RuleConflictRef {
  id: string;
  summary: string;
  handling: string;
  US?: string;
  UK?: string;
}

interface ReferenceFile {
  data: RefRow[];
  rule_conflicts: RuleConflictRef[];
}

const REF: ReferenceFile = JSON.parse(
  readFileSync(new URL("../../../data/reference/market_allergens.json", import.meta.url), "utf8"),
);

/** Species id → reference include/exclude name fragments used for membership checks. */
const SPECIES_TO_REF_NAMES: Record<string, string[]> = {
  almond: ["almonds", "Almond"],
  hazelnut: ["hazelnuts", "Filbert/Hazelnut"],
  walnut: ["walnuts", "Walnut (English, Persian)", "Black walnut", "California walnut", "Heartnut/Japanese walnut"],
  cashew: ["cashews", "Cashew"],
  pecan: ["pecans", "Pecan"],
  brazil_nut: ["brazil nuts", "Brazil nut"],
  pistachio: ["pistachios", "Pistachio"],
  macadamia: ["macadamia nuts", "Macadamia nut/Bush nut"],
  pine_nut: ["Pine nut/Pinon nut", "pine nut"],
  chestnut: ["chestnut"],
  coconut: ["coconut"],
  black_walnut: ["Black walnut"],
  heartnut: ["Heartnut/Japanese walnut"],
  beech_nut: ["beech nut"],
  butternut: ["butternut"],
  shea: ["shea nut"],
};

function rowFor(market: Market, group: AllergenGroup | string): RefRow | undefined {
  // UK wheat is filed under gluten_cereal.
  if (market === "UK" && (group === "wheat" || group === "gluten_cereal")) {
    return REF.data.find((r) => r.market_code === "UK:gluten_cereal");
  }
  return REF.data.find((r) => r.market === market && r.allergen === group);
}

function speciesInList(list: string[] | undefined, species: string): boolean {
  if (!list) return false;
  const names = SPECIES_TO_REF_NAMES[species];
  if (!names) return false;
  const lower = list.map((x) => x.toLowerCase());
  return names.some((n) => lower.some((l) => l === n.toLowerCase() || l.includes(n.toLowerCase())));
}

export function marketCodes(market: Market): string[] {
  return REF.data.filter((r) => r.market === market).map((r) => r.market_code);
}

export function marketCode(market: Market, group: AllergenGroup | string, species?: string): string | null {
  if (market === "US" && group === "gluten_cereal") return null;
  const row = rowFor(market, group);
  if (!row) return null;
  if (group === "tree_nut" && species) {
    if (!isMajorAllergen(market, group, species)) return null;
  }
  return row.market_code;
}

export function isMajorAllergen(market: Market, group: AllergenGroup | string, species?: string): boolean {
  if (marketCodeBare(market, group) === null) return false;
  if (group === "tree_nut" && species) {
    const row = rowFor(market, "tree_nut");
    if (!row) return false;
    if (speciesInList(row.excludes, species)) return false;
    return speciesInList(row.includes, species);
  }
  return true;
}

function marketCodeBare(market: Market, group: AllergenGroup | string): string | null {
  if (market === "US" && group === "gluten_cereal") return null;
  const row = rowFor(market, group);
  return row?.market_code ?? null;
}

export function displayName(market: Market, group: AllergenGroup | string, species?: string): string | null {
  const row = rowFor(market, group);
  if (!row) return null;
  if (market === "UK" && group === "wheat") {
    return `${row.display_name} (wheat)`;
  }
  if (species && group === "tree_nut") {
    const label = species.replace(/_/g, " ");
    return `${row.display_name} (${label})`;
  }
  if (species && (group === "wheat" || group === "gluten_cereal")) {
    return `${row.display_name} (${species.replace(/_/g, " ")})`;
  }
  return row.display_name;
}

export interface RuleConflict {
  id: string;
  market: Market;
  evidence_text: string;
  summary: string;
  handling: string;
}

const COCONUT_AS_TREE_NUT: RegExp[] = [
  /tree\s*nuts?\s*[:(\[]\s*coconut/iu,
  /tree\s*nut\s*\(\s*coconut\s*\)/iu,
  /coconut\s*\(\s*tree\s*nuts?\s*\)/iu,
  /Schalenfrüchte\s*\(\s*Kokos(?:nuss)?\s*\)/iu,
  /fruits?\s*à\s*coque\s*\(\s*noix\s*de\s*coco\s*\)/iu,
  /frutos\s*secos\s*\(\s*coco\s*\)/iu,
  /frutta\s*a\s*guscio\s*\(\s*(?:noce\s*di\s*)?cocco\s*\)/iu,
];

const PINE_NUT: RegExp[] = [
  /\bpine\s*nuts?\b/iu,
  /\bPinienkerne\b/iu,
  /\bpignons?\b/iu,
  /\bpiñones\b/iu,
  /\bpinoli\b/iu,
];

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

export function ruleConflicts(market: Market, text: string): RuleConflict[] {
  const out: RuleConflict[] = [];
  const nfc = text.normalize("NFC");

  const coco = firstMatch(nfc, COCONUT_AS_TREE_NUT);
  if (coco) {
    const ref = REF.rule_conflicts.find((c) => c.id === "coconut-tree-nut");
    if (ref) {
      out.push({
        id: ref.id,
        market,
        evidence_text: coco,
        summary: ref.summary,
        handling: ref.handling,
      });
    }
  }

  if (market === "UK") {
    const pine = firstMatch(nfc, PINE_NUT);
    if (pine) {
      const ref = REF.rule_conflicts.find((c) => c.id === "pine-nut-scope");
      if (ref) {
        out.push({
          id: ref.id,
          market,
          evidence_text: pine,
          summary: ref.summary,
          handling: ref.handling,
        });
      }
    }
  }

  return out;
}

/** Exported for the species-mapping completeness test. */
export const SPECIES_REF_NAMES = SPECIES_TO_REF_NAMES;
