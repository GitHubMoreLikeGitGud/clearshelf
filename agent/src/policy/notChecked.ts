// The "Not checked" list on every card: what this decision did not or could not verify.
// Deterministic; each item is attached only when it applies.

import type { Market } from "./decide.ts";

export interface NotCheckedInput {
  market: Market;
  /** False when the source has no ingredient list (OFF ingredients_text empty). */
  hasIngredientText: boolean;
  /** Recalls linked to this GTIN, of any status or age. */
  linkedRecalls: number;
  /** Name-only recall or alert matches found for the brand. */
  nameMatches: number;
  /** A sulphite span, declared tag or recall group was seen for this SKU. */
  sulphiteSeen: boolean;
  /** The brand name search ran (FDA firm and description, FSA title and business). */
  brandSearched: boolean;
}

export interface NotCheckedItem {
  id: string;
  text: string;
}

export function notChecked(input: NotCheckedInput): NotCheckedItem[] {
  const out: NotCheckedItem[] = [];
  if (!input.hasIngredientText) {
    out.push({ id: "no_ingredient_list", text: "no ingredient list in the source (Open Food Facts has no ingredients_text for this GTIN)" });
  }
  if (input.linkedRecalls > 0 || input.nameMatches > 0) {
    out.push({ id: "lots", text: "lot or batch codes in the recall notices not matched against the catalogue's stock" });
  }
  out.push({ id: "supplier_spec", text: "no supplier specification on file" });
  out.push({ id: "physical_label", text: "physical label not inspected (Open Food Facts is crowd-sourced)" });
  out.push({
    id: "fsa_no_gtin",
    text: input.brandSearched
      ? "FSA alerts carry no GTIN: checked by brand name only"
      : "FSA alerts carry no GTIN, and no usable brand name was on the product row, so FSA alerts were not matched",
  });
  out.push({ id: "fda_coverage", text: "openFDA coverage is the latest 1,000 reports matching \"undeclared\" (one page of the enforcement API)" });
  if (input.sulphiteSeen) out.push({ id: "sulphite_level", text: "sulphite concentration not measurable from label data" });
  out.push({ id: "rasff", text: "EU RASFF notifications not federated" });
  return out;
}
