import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adjudicate,
  extractUpcs,
  gs1Valid,
  labelFromTags,
  labelFromText,
  parseRecallReason,
  whyDrift,
} from "../../scripts/curate-manifest.ts";

// Synthetic label texts written for these tests; none is copied from Open Food Facts.

describe("gs1Valid", () => {
  it("accepts valid GTIN-12/13/14 check digits and rejects the rest", () => {
    expect(gs1Valid("0816929000119")).toBe(true);
    expect(gs1Valid("816929000119")).toBe(true);
    expect(gs1Valid("00816929000119")).toBe(true);
    expect(gs1Valid("4056489125846")).toBe(true);
    expect(gs1Valid("0816929000118")).toBe(false);
    expect(gs1Valid("12345")).toBe(false);
    expect(gs1Valid("08169290001a9")).toBe(false);
  });
});

describe("extractUpcs", () => {
  it("pads a spaced UPC-A after a keyword to GTIN-13", () => {
    expect(extractUpcs("Plant-based puffs, 4 oz bag, UPC 8 16929 00011 9")).toEqual([
      { raw: "8 16929 00011 9", gtin: "0816929000119", transform: "upc12_pad13" },
    ]);
  });
  it("keeps EAN-13 and strips a leading zero from GTIN-14", () => {
    expect(extractUpcs("EAN: 4056489125846")).toEqual([{ raw: "4056489125846", gtin: "4056489125846", transform: "ean13" }]);
    expect(extractUpcs("GTIN 00816929000119")[0]).toMatchObject({ gtin: "0816929000119", transform: "gtin14_strip0" });
  });
  it("ignores numbers without a barcode keyword or with a bad check digit", () => {
    expect(extractUpcs("Lot 816929000119, best by 2026-12-01")).toEqual([]);
    expect(extractUpcs("UPC 816929000118")).toEqual([]);
  });
});

describe("parseRecallReason", () => {
  it("reads the allergen after 'undeclared', not the product name before it", () => {
    const r = parseRecallReason("Almond milk may contain undeclared cashews.");
    expect(r.reason_type).toBe("undeclared_allergen");
    expect(r.groups).toEqual(["tree_nut"]);
  });
  it("maps wheat to both wheat and gluten_cereal", () => {
    expect(parseRecallReason("Product contains undeclared wheat.").groups.sort()).toEqual(["gluten_cereal", "wheat"]);
  });
  it("flags a coconut-only tree-nut recall (R-RECALL-COCONUT)", () => {
    expect(parseRecallReason("Undeclared tree nut (coconut).").tree_nut_is_coconut_only).toBe(true);
    expect(parseRecallReason("Undeclared coconut and almonds.").tree_nut_is_coconut_only).toBe(false);
  });
  it("classifies non-allergen reasons as other", () => {
    expect(parseRecallReason("Product contains undeclared sildenafil.")).toMatchObject({ reason_type: "other", groups: [] });
  });
});

describe("labelFromText", () => {
  it("R-PREC: cocoa butter is a trap and precautionary milk is may_contain", () => {
    const { groups, traps } = labelFromText("Cocoa mass, sugar, cocoa butter, vanilla. May contain milk.");
    expect(groups.milk).toMatchObject({ rel: "may_contain", rules: ["R-PREC"] });
    expect(traps).toContain("cocoa_butter");
  });
  it("R-NAME in German compounds", () => {
    const { groups } = labelFromText("Weizenmehl, Zucker, Butter, Vollmilchpulver, Haselnüsse.");
    for (const g of ["wheat", "gluten_cereal", "milk", "tree_nut"] as const) expect(groups[g].rel).toBe("contains");
    expect(groups.egg.rel).toBe("none");
  });
  it("R-EMPH and R-CONTAINS", () => {
    expect(labelFromText("Sugar, _milk_ powder, emulsifier (_soya_ lecithin).").groups.soy.rules).toEqual(["R-EMPH"]);
    const c = labelFromText("Water, sugar. Contains: milk, eggs.").groups;
    expect(c.milk.rules).toEqual(["R-CONTAINS"]);
    expect(c.egg.rules).toEqual(["R-CONTAINS"]);
  });
  it("trap words do not set a group", () => {
    const { groups, traps } = labelFromText("Rice, coconut milk, buckwheat, nutmeg, cream of tartar.");
    for (const g of ["milk", "tree_nut", "gluten_cereal", "wheat"] as const) expect(groups[g].rel).toBe("none");
    expect(traps).toEqual(expect.arrayContaining(["coconut_milk", "buckwheat", "nutmeg", "cream_of_tartar"]));
  });
  it("masks free-from claims and bold-allergen boilerplate", () => {
    expect(labelFromText("Rice flour, salt. Gluten free.").groups.gluten_cereal.rel).toBe("none");
    expect(labelFromText("Sugar, salt. For allergens, see ingredients in bold.").groups.tree_nut.rel).toBe("none");
  });
});

describe("adjudicate", () => {
  const run = (text: string, allergens: string[] = [], traces: string[] = []) => {
    const a = labelFromText(text);
    return adjudicate(a.groups, labelFromTags(allergens, traces).groups, a.traps);
  };
  it("agrees, and wheat is text-only", () => {
    const r = run("Wheat flour, sugar.", ["en:gluten"]);
    expect(r.gluten_cereal).toMatchObject({ label: "contains", basis: "ADJ-AGREE" });
    expect(r.wheat).toMatchObject({ label: "contains", basis: "ADJ-TEXT-ONLY" });
    expect(r.milk).toMatchObject({ label: "none", basis: "ADJ-AGREE" });
  });
  it("label text governs when the tags disagree", () => {
    expect(run("Sugar, almonds.").tree_nut).toMatchObject({ label: "contains", basis: "ADJ-TEXT-NAME" });
    expect(run("Sugar, _milk_ powder.").milk).toMatchObject({ label: "contains", basis: "ADJ-TEXT-DECLARED" });
    expect(run("Sugar. May contain peanuts.").peanut).toMatchObject({ label: "may_contain", basis: "ADJ-TEXT-PRECAUTION" });
  });
  it("a trap explains a contains tag; anything else is unscored", () => {
    expect(run("Cocoa mass, cocoa butter, sugar.", ["en:milk"]).milk).toMatchObject({ label: "none", basis: "ADJ-TRAP" });
    expect(run("Sugar, cocoa mass.", [], ["en:nuts"]).tree_nut).toMatchObject({ label: "unscored", basis: "ADJ-DISPUTED" });
  });
});

describe("whyDrift", () => {
  const recalls = [{ recall_number: "H-0903-2026", report_date: "2026-06-10", status: "Terminated", classification: "Class I" }];
  const sku = (why: string) => ({ gtin: "0810001560768", why, recalls });
  it("passes a why that matches the recall row", () => {
    expect(whyDrift([sku("FDA H-0903-2026: undeclared egg, Class I, Terminated, reported 2026-06-10.")])).toEqual([]);
  });
  it("flags a report date written as a termination date, and wrong class, date or recall", () => {
    expect(whyDrift([sku("FDA H-0903-2026: undeclared egg, Class I, Terminated 2026-06-10.")])).toHaveLength(1);
    expect(whyDrift([sku("FDA H-0903-2026: Class II, Terminated.")])).toHaveLength(1);
    expect(whyDrift([sku("FDA H-0903-2026: Terminated, reported 2026-06-11.")])).toHaveLength(1);
    expect(whyDrift([sku("FDA F-0636-2025: Terminated.")])).toHaveLength(1);
  });
  it("finds no drift in the committed manifest", () => {
    const m = JSON.parse(readFileSync(new URL("../../data/manifest/skus.json", import.meta.url), "utf8"));
    expect(m.counts).toMatchObject({ total: 40, demo: 30, eval_only: 10 });
    expect(whyDrift(m.skus)).toEqual([]);
  });
});
