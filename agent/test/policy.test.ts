import { describe, expect, it } from "vitest";
import { decide, distributionCoversUk, monthsBetween, type PolicyInput } from "../src/policy/decide.ts";
import { buildStatement, markIngredients, statementCovers, type StatementSpan } from "../src/policy/statement.ts";
import { notChecked } from "../src/policy/notChecked.ts";

// All inputs below are synthetic.
function base(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    gtin: "0000000000000",
    market: "UK",
    asOf: "2026-10-23",
    product: { found: true, evidenceIds: ["ev-p"] },
    extraction: { ok: true, hasText: true, unparsedFragments: 0, evidenceIds: ["ev-x", "ev-v"] },
    dqComplete: true,
    recalls: [],
    nameMatches: [],
    dq: [],
    contradictions: [],
    verified: [],
    ...over,
  };
}

const recall = (status: string, report_date: string, distribution: string | null = "Nationwide in the USA") => ({
  recall_number: "H-0001-2026",
  report_date,
  status,
  classification: "Class I",
  distribution,
  evidenceIds: ["ev-r"],
});

describe("decide: R1 exact-GTIN recalls", () => {
  it("blocks an ongoing recall in the US market", () => {
    const r = decide(base({ market: "US", recalls: [recall("Ongoing", "2026-09-01")] }));
    expect(r.status).toBe("BLOCK");
    expect(r.firings[0]).toMatchObject({ rule: "R1", effect: "BLOCK", evidenceIds: ["ev-r"] });
    expect(r.autoExecutable).toBe(true);
  });

  it("holds an ongoing US-only recall for the UK market, and blocks when distribution reaches the UK or is unknown", () => {
    expect(decide(base({ recalls: [recall("Ongoing", "2026-09-01")] })).status).toBe("HOLD");
    expect(decide(base({ recalls: [recall("Ongoing", "2026-09-01", "US and the United Kingdom")] })).status).toBe("BLOCK");
    expect(decide(base({ recalls: [recall("Ongoing", "2026-09-01", "Distributed internationally")] })).status).toBe("BLOCK");
    expect(decide(base({ recalls: [recall("Ongoing", "2026-09-01", null)] })).status).toBe("BLOCK");
  });

  it("treats Pending like Ongoing", () => {
    expect(decide(base({ market: "US", recalls: [recall("Pending", "2026-09-01")] })).status).toBe("BLOCK");
  });

  it("holds a terminated or completed recall inside 24 months of report_date and notes it outside", () => {
    expect(decide(base({ recalls: [recall("Terminated", "2024-10-30")] })).status).toBe("HOLD");
    const old = decide(base({ recalls: [recall("Completed", "2024-08-21")] }));
    expect(old.firings.some((f) => f.rule === "R1")).toBe(false);
    expect(old.notes[0]).toMatchObject({ rule: "R1", effect: "INFO" });
    expect(old.status).toBe("CLEAR");
  });

  it("holds a recall with an unrecognised status", () => {
    expect(decide(base({ recalls: [recall("Whatever", "2026-01-01")] })).status).toBe("HOLD");
  });
});

describe("decide: R2-R6", () => {
  const nm = (similarity: number) => ({
    source: "fsa" as const,
    notice_id: "FSA-AA-01-2026",
    notice_date: "2026-01-01",
    business: "x",
    title: "x",
    brand_token: "brand",
    similarity,
    evidenceIds: ["ev-n"],
  });

  it("puts a brand-only match in review with no status change, and holds at similarity 0.85", () => {
    const r = decide(base({ nameMatches: [nm(0.4)] }));
    expect(r.status).toBe("CLEAR");
    expect(r.review).toHaveLength(1);
    expect(decide(base({ nameMatches: [nm(0.85)] })).status).toBe("HOLD");
  });

  it("holds on any DQ invalid record, quoting the rule, and on an incomplete gate", () => {
    const r = decide(base({ dq: [{ rule: "english_label", table: "product", invalidRows: 1, source: "zetaris_dq", evidenceIds: ["ev-d"] }] }));
    expect(r.status).toBe("HOLD");
    expect(r.firings[0]!.reason).toContain("english_label");
    expect(decide(base({ dqComplete: false })).status).toBe("HOLD");
  });

  it("keeps review notes out of the status", () => {
    const r = decide(base({ verified: [{ group: "milk", relation: "contains", evidenceIds: ["ev-v"] }], reviewNotes: [{ text: "span-level miss on milk", evidenceIds: ["ev-v"] }] }));
    expect(r.status).toBe("CLEAR_WITH_STATEMENT");
    expect(r.review[0]).toMatchObject({ rule: "R4", effect: "REVIEW" });
  });

  it("holds on any contradiction", () => {
    const r = decide(base({ contradictions: [{ kind: "claim_not_supported", text: "vegan", evidenceIds: ["ev-c"] }] }));
    expect(r.status).toBe("HOLD");
    expect(r.firings[0]).toMatchObject({ rule: "R4" });
  });

  it("proposes CLEAR_WITH_STATEMENT with a verified allergen and CLEAR without, both pending signature", () => {
    const r5 = decide(base({ verified: [{ group: "milk", relation: "may_contain", evidenceIds: ["ev-v"] }] }));
    expect(r5.status).toBe("CLEAR_WITH_STATEMENT");
    expect(r5.pendingSignature).toBe(true);
    expect(r5.autoExecutable).toBe(false);
    const r6 = decide(base());
    expect(r6.status).toBe("CLEAR");
    expect(r6.firings.at(-1)!.rule).toBe("R6");
  });

  it("never clears without a product row, a valid extraction or a full parse", () => {
    expect(decide(base({ product: { found: false, evidenceIds: [] }, extraction: null })).status).toBe("HOLD");
    expect(decide(base({ extraction: { ok: false, hasText: true, unparsedFragments: 0, evidenceIds: [] } })).status).toBe("HOLD");
    expect(decide(base({ extraction: { ok: true, hasText: true, unparsedFragments: 2, evidenceIds: [] } })).status).toBe("HOLD");
    expect(decide(base({ incompleteSteps: [{ step: "declared", error: "HTTP 502", evidenceIds: [] }] })).status).toBe("HOLD");
  });

  it("lets an escalation make the result stricter, never laxer", () => {
    const up = decide(base({ escalations: [{ to: "BLOCK", source: "brief", reason: "r", evidenceIds: [] }] }));
    expect(up.status).toBe("BLOCK");
    const held = decide(base({ market: "US", recalls: [recall("Ongoing", "2026-09-01")], escalations: [{ to: "HOLD", source: "invariant", reason: "r", evidenceIds: [] }] }));
    expect(held.status).toBe("BLOCK");
    expect(held.notes.some((n) => n.rule === "ESC")).toBe(true);
  });

  it("takes the strictest firing", () => {
    const r = decide(base({ market: "US", recalls: [recall("Ongoing", "2026-09-01")], dq: [{ rule: "has_ingredients", table: "product", invalidRows: 1, source: "dq_equivalent_sql", evidenceIds: [] }] }));
    expect(r.status).toBe("BLOCK");
    expect(new Set(r.firings.map((f) => f.rule))).toEqual(new Set(["R1", "R3"]));
  });
});

describe("decide helpers", () => {
  it("reads distribution text", () => {
    expect(distributionCoversUk("Nationwide via online sales")).toBe("no");
    expect(distributionCoversUk("CA, NY and the UK")).toBe("yes");
    expect(distributionCoversUk("")).toBe("unknown");
  });

  it("counts whole months", () => {
    expect(monthsBetween("2024-10-30", "2026-10-23")).toBe(23);
    expect(monthsBetween("2024-10-23", "2026-10-23")).toBe(24);
    expect(monthsBetween("2026-09-09", "2026-10-23")).toBe(1);
  });
});

const sp = (group: string, relation: "contains" | "may_contain", evidence_text: string, extra: Partial<StatementSpan> = {}): StatementSpan => ({
  group,
  relation,
  evidence_text,
  evidenceIds: ["ev-v"],
  ...extra,
});

describe("statement builder", () => {
  it("UK: Annex II names, cereals and nut species qualified, May contain not repeating Contains", () => {
    const s = buildStatement(
      "UK",
      [
        sp("wheat", "contains", "wheat flour"),
        sp("gluten_cereal", "contains", "barley malt", { term: "barley" }),
        sp("tree_nut", "contains", "almonds", { species: "almond" }),
        sp("milk", "may_contain", "milk"),
        sp("wheat", "may_contain", "wheat"),
      ],
      "wheat flour, barley malt, almonds. May contain milk.",
    );
    expect(s.text).toBe("Contains: Cereals containing gluten (wheat, barley), Nuts (almond). May contain: Milk.");
    expect(s.ingredientsMarked).toBe("**wheat flour**, **barley malt**, **almonds**. May contain milk.");
  });

  it("UK: pine nut is not an Annex II nut", () => {
    const s = buildStatement("UK", [sp("tree_nut", "contains", "pine nuts", { species: "pine_nut" })], null);
    expect(s.contains).toHaveLength(0);
    expect(s.excluded[0]).toMatchObject({ group: "tree_nut", species: "pine_nut" });
    expect(s.text).toBe("No allergens declared.");
  });

  it("US: wheat not gluten, other cereals and non-US groups left out, tree-nut species named", () => {
    const s = buildStatement(
      "US",
      [
        sp("wheat", "contains", "wheat"),
        sp("gluten_cereal", "contains", "barley", { term: "barley" }),
        sp("celery", "contains", "celery"),
        sp("tree_nut", "contains", "pecans", { species: "pecan" }),
        sp("soy", "contains", "soy lecithin"),
      ],
      null,
    );
    expect(s.text).toBe("Contains: Tree nuts (pecan), Wheat, Soybeans.");
    expect(s.excluded.map((x) => x.group).sort()).toEqual(["celery", "gluten_cereal"]);
    expect(s.text).not.toMatch(/gluten/iu);
  });

  it("US: coconut stays out of Contains", () => {
    const s = buildStatement("US", [sp("tree_nut", "contains", "coconut", { species: "coconut" })], null);
    expect(s.contains).toHaveLength(0);
    expect(s.excluded[0]!.reason).toMatch(/Table 1/u);
  });

  it("names spelt and other wheat words by their own cereal", () => {
    const s = buildStatement("UK", [sp("wheat", "contains", "wheat flour", { term: "wheat" }), sp("wheat", "contains", "Dinkelmehl", { term: "Dinkel" })], null);
    expect(s.text).toBe("Contains: Cereals containing gluten (wheat, spelt).");
    expect(buildStatement("US", [sp("wheat", "contains", "spelt flour", { term: "spelt" })], null).text).toBe("Contains: Wheat.");
  });

  it("covers a reading only when the statement already names its entry and qualifier at that relation or stronger", () => {
    const verified = [sp("wheat", "contains", "wheat flour", { term: "wheat" }), sp("tree_nut", "contains", "hazelnuts", { species: "hazelnut" }), sp("peanut", "may_contain", "peanuts")];
    const r = (group: string, relation: "contains" | "may_contain", evidence_text: string, extra: Partial<StatementSpan> = {}) => ({ group, relation, evidence_text, ...extra });
    // Same entry, no qualifier, or the same qualifier.
    expect(statementCovers("UK", verified, r("tree_nut", "contains", "nuts"))).toBe(true);
    expect(statementCovers("UK", verified, r("tree_nut", "may_contain", "hazelnut", { species: "hazelnut" }))).toBe(true);
    expect(statementCovers("UK", verified, r("gluten_cereal", "contains", "gluten", { term: "gluten" }))).toBe(true);
    // A nut species or cereal the statement does not name.
    expect(statementCovers("UK", verified, r("tree_nut", "contains", "almonds", { species: "almond" }))).toBe(false);
    expect(statementCovers("UK", verified, r("tree_nut", "may_contain", "almonds", { species: "almond" }))).toBe(false);
    expect(statementCovers("UK", verified, r("wheat", "contains", "spelt", { term: "spelt" }))).toBe(false);
    expect(statementCovers("UK", verified, r("gluten_cereal", "contains", "barley", { term: "barley" }))).toBe(false);
    // US: spelt is wheat, and barley is not a US allergen once the gluten family is verified.
    expect(statementCovers("US", verified, r("wheat", "contains", "spelt", { term: "spelt" }))).toBe(true);
    expect(statementCovers("US", verified, r("gluten_cereal", "contains", "barley", { term: "barley" }))).toBe(true);
    // A stronger relation than the verified one, or a family with nothing verified.
    expect(statementCovers("UK", verified, r("peanut", "contains", "peanuts"))).toBe(false);
    expect(statementCovers("UK", verified, r("milk", "may_contain", "milk"))).toBe(false);
    expect(statementCovers("US", [], r("gluten_cereal", "contains", "barley", { term: "barley" }))).toBe(false);
  });

  it("marks overlapping phrases once, longest first", () => {
    expect(markIngredients("milk powder, milk", ["milk", "milk powder"])).toBe("**milk powder**, **milk**");
  });
});

describe("not checked", () => {
  it("attaches conditional items only when they apply", () => {
    const none = notChecked({ market: "UK", hasIngredientText: true, linkedRecalls: 0, nameMatches: 0, sulphiteSeen: false, brandSearched: true }).map((i) => i.id);
    expect(none).toEqual(["supplier_spec", "physical_label", "fsa_no_gtin", "fda_coverage", "rasff"]);
    const all = notChecked({ market: "UK", hasIngredientText: false, linkedRecalls: 1, nameMatches: 0, sulphiteSeen: true, brandSearched: false });
    expect(all.map((i) => i.id)).toEqual(["no_ingredient_list", "lots", "supplier_spec", "physical_label", "fsa_no_gtin", "fda_coverage", "sulphite_level", "rasff"]);
    expect(all.find((i) => i.id === "fsa_no_gtin")!.text).toMatch(/not matched/u);
  });
});
