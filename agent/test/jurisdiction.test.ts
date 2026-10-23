import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  displayName,
  isMajorAllergen,
  marketCode,
  marketCodes,
  ruleConflicts,
} from "../src/verify/jurisdiction.ts";

const ref = JSON.parse(
  readFileSync(new URL("../../data/reference/market_allergens.json", import.meta.url), "utf8"),
) as {
  data: { market: string; market_code: string; includes?: string[] }[];
  rule_conflicts: { id: string; summary: string; handling: string }[];
};

describe("market lists from reference", () => {
  it("reads 14 UK and 9 US market codes from the file", () => {
    expect(marketCodes("UK")).toHaveLength(14);
    expect(marketCodes("US")).toHaveLength(9);
    expect(marketCodes("UK")).toEqual(
      ref.data.filter((r) => r.market === "UK").map((r) => r.market_code),
    );
    expect(marketCodes("US")).toEqual(
      ref.data.filter((r) => r.market === "US").map((r) => r.market_code),
    );
  });

  it("maps wheat and gluten_cereal per market", () => {
    expect(marketCode("UK", "wheat")).toBe("UK:gluten_cereal");
    expect(marketCode("UK", "gluten_cereal")).toBe("UK:gluten_cereal");
    expect(marketCode("US", "wheat")).toBe("US:wheat");
    expect(marketCode("US", "gluten_cereal")).toBeNull();
    expect(marketCode("US", "mollusc")).toBeNull();
    expect(isMajorAllergen("US", "gluten_cereal")).toBe(false);
    expect(isMajorAllergen("US", "mollusc")).toBe(false);
  });

  it("treats pine nut as US-only tree nut; chestnut as neither", () => {
    expect(isMajorAllergen("US", "tree_nut", "pine_nut")).toBe(true);
    expect(isMajorAllergen("UK", "tree_nut", "pine_nut")).toBe(false);
    expect(isMajorAllergen("US", "tree_nut", "chestnut")).toBe(false);
    expect(isMajorAllergen("UK", "tree_nut", "chestnut")).toBe(false);
  });

  it("maps every species id to a name that occurs in the reference file", () => {
    const allIncludes = ref.data.flatMap((r) => r.includes ?? []);
    const allText = JSON.stringify(ref);
    const speciesNames: Record<string, string[]> = {
      almond: ["almonds", "Almond"],
      hazelnut: ["hazelnuts", "Filbert/Hazelnut"],
      walnut: ["walnuts", "Walnut (English, Persian)", "Black walnut", "California walnut"],
      cashew: ["cashews", "Cashew"],
      pecan: ["pecans", "Pecan"],
      brazil_nut: ["brazil nuts", "Brazil nut"],
      pistachio: ["pistachios", "Pistachio"],
      macadamia: ["macadamia nuts", "Macadamia nut/Bush nut"],
      pine_nut: ["Pine nut/Pinon nut", "pine nut"],
      chestnut: ["chestnut"],
      coconut: ["coconut"],
    };
    for (const names of Object.values(speciesNames)) {
      for (const name of names) {
        expect(allIncludes.includes(name) || allText.includes(name)).toBe(true);
      }
    }
  });

  it("formats display names with cereal or nut in parentheses when known", () => {
    expect(displayName("UK", "wheat")).toBe("Cereals containing gluten (wheat)");
    expect(displayName("UK", "tree_nut", "almond")).toBe("Nuts (almond)");
    expect(displayName("US", "wheat")).toBe("Wheat");
    expect(displayName("US", "wheat")?.toLowerCase()).not.toContain("gluten");
  });
});

describe("ruleConflicts", () => {
  const coconutConflict = ref.rule_conflicts.find((c) => c.id === "coconut-tree-nut")!;
  const pineConflict = ref.rule_conflicts.find((c) => c.id === "pine-nut-scope")!;

  it("reports coconut-tree-nut when coconut is described as a tree nut", () => {
    for (const market of ["US", "UK"] as const) {
      const hits = ruleConflicts(market, "undeclared tree nut (coconut)");
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        id: "coconut-tree-nut",
        market,
        summary: coconutConflict.summary,
        handling: coconutConflict.handling,
      });
      expect("undeclared tree nut (coconut)".includes(hits[0]!.evidence_text)).toBe(true);
    }
  });

  it("does not flag a plain coconut mention", () => {
    expect(ruleConflicts("US", "coconut oil")).toEqual([]);
    expect(ruleConflicts("UK", "coconut")).toEqual([]);
  });

  it("reports pine-nut-scope for UK only", () => {
    expect(ruleConflicts("UK", "contains pine nuts")).toEqual([
      expect.objectContaining({
        id: "pine-nut-scope",
        market: "UK",
        summary: pineConflict.summary,
        handling: pineConflict.handling,
      }),
    ]);
    expect(ruleConflicts("US", "contains pine nuts")).toEqual([]);
  });
});
