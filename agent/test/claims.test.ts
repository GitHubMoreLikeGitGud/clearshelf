import { describe, expect, it } from "vitest";
import { claimsFromLabels, claimsFromText, testClaim } from "../src/verify/claims.ts";

describe("claimsFromLabels", () => {
  it("maps vegan tags once and ignores vegetarian", () => {
    expect(claimsFromLabels("en:vegetarian,en:vegan,en:vegan-action")).toEqual(["vegan"]);
    expect(claimsFromLabels("en:the-vegan-society")).toEqual(["vegan"]);
    expect(claimsFromLabels("en:no-gluten")).toEqual(["gluten_free"]);
    expect(claimsFromLabels(null)).toEqual([]);
  });
});

describe("claimsFromText", () => {
  it("returns free-from claims but not lactose_free as dairy_free", () => {
    expect(claimsFromText("gluten-free oat drink")).toContain("gluten_free");
    expect(claimsFromText("dairy-free")).toContain("dairy_free");
    expect(claimsFromText("nut-free")).toContain("nut_free");
    expect(claimsFromText("vegan")).toContain("vegan");
    expect(claimsFromText("lactose-free")).not.toContain("dairy_free");
    expect(claimsFromText("lactose-free")).not.toContain("lactose_free");
  });
});

describe("testClaim", () => {
  const milkContains = {
    evidenceId: "ev-milk",
    group: "milk" as const,
    relation: "contains" as const,
    verified: true,
  };
  const milkMay = {
    evidenceId: "ev-may-milk",
    group: "milk" as const,
    relation: "may_contain" as const,
    verified: true,
  };
  const milkUnverified = {
    evidenceId: "ev-unv",
    group: "milk" as const,
    relation: "contains" as const,
    verified: false,
  };
  const wheatMay = {
    evidenceId: "ev-wheat",
    group: "wheat" as const,
    relation: "may_contain" as const,
    verified: true,
  };

  it("marks vegan NOT_SUPPORTED on verified milk contains", () => {
    const r = testClaim("vegan", {
      ingredientText: "full",
      spans: [milkContains],
      recalls: [],
    });
    expect(r).toMatchObject({
      claim: "vegan",
      verdict: "NOT_SUPPORTED",
      contradicting: ["milk"],
      evidenceIds: ["ev-milk"],
    });
  });

  it("marks vegan PARTLY_SUPPORTED on verified may_contain milk", () => {
    const r = testClaim("vegan", {
      ingredientText: "full",
      spans: [milkMay],
      recalls: [],
    });
    expect(r.verdict).toBe("PARTLY_SUPPORTED");
    expect(r.evidenceIds).toEqual(["ev-may-milk"]);
  });

  it("is UNTESTED with no ingredient text and no recall", () => {
    expect(
      testClaim("vegan", { ingredientText: "none", spans: [], recalls: [] }).verdict,
    ).toBe("UNTESTED");
    expect(
      testClaim("vegan", { ingredientText: "partial", spans: [], recalls: [] }).verdict,
    ).toBe("UNTESTED");
  });

  it("is NOT_SUPPORTED from recall undeclared milk with H- or F- numbers", () => {
    const h = testClaim("vegan", {
      ingredientText: "none",
      spans: [],
      recalls: [{ evidenceId: "ev-h", recallNumber: "H-1328-2026", undeclared: ["milk"] }],
    });
    expect(h.verdict).toBe("NOT_SUPPORTED");
    expect(h.evidenceIds).toEqual(["ev-h"]);
    const f = testClaim("vegan", {
      ingredientText: "none",
      spans: [],
      recalls: [{ evidenceId: "ev-f", recallNumber: "F-0636-2025", undeclared: ["milk"] }],
    });
    expect(f.verdict).toBe("NOT_SUPPORTED");
  });

  it("marks gluten_free PARTLY_SUPPORTED on may_contain wheat", () => {
    const r = testClaim("gluten_free", {
      ingredientText: "full",
      spans: [wheatMay],
      recalls: [],
    });
    expect(r.verdict).toBe("PARTLY_SUPPORTED");
  });

  it("supports nut_free when only coconut is present", () => {
    const r = testClaim("nut_free", {
      ingredientText: "full",
      spans: [
        {
          evidenceId: "ev-coco",
          group: "tree_nut",
          relation: "not_allergen",
          verified: true,
        },
      ],
      recalls: [],
    });
    expect(r.verdict).toBe("SUPPORTED");
    expect(r.contradicting).toEqual([]);
  });

  it("ignores unverified spans", () => {
    const r = testClaim("vegan", {
      ingredientText: "full",
      spans: [milkUnverified],
      recalls: [],
    });
    expect(r.verdict).toBe("SUPPORTED");
  });

  it("throws on a malformed recall number", () => {
    expect(() =>
      testClaim("vegan", {
        ingredientText: "none",
        spans: [],
        recalls: [{ evidenceId: "ev-bad", recallNumber: "X-1234-2026", undeclared: ["milk"] }],
      }),
    ).toThrow();
  });
});
