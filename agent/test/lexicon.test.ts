import { describe, expect, it } from "vitest";
import { keywordBaseline, lexiconScan, verifySpans } from "../src/verify/lexicon.ts";
import type { ExtractionSpan } from "../src/llm/schemas.ts";

function groups(text: string, relation?: string) {
  return lexiconScan(text)
    .filter((h) => (relation ? h.relation === relation : true))
    .map((h) => h.group);
}

function relations(text: string, group: string) {
  return lexiconScan(text).filter((h) => h.group === group).map((h) => h.relation);
}

describe("traps", () => {
  it("does not treat cocoa butter / coconut milk as milk (EN and DE)", () => {
    for (const t of ["cocoa butter", "coconut milk", "Kakaobutter", "Kokosmilch"]) {
      expect(relations(t, "milk")).toEqual(["not_allergen"]);
      expect(groups(t, "contains")).not.toContain("milk");
    }
  });

  it("does not treat buckwheat as wheat or gluten", () => {
    for (const t of ["buckwheat", "Buchweizen", "grano saraceno"]) {
      expect(groups(t, "contains")).not.toContain("wheat");
      expect(groups(t, "contains")).not.toContain("gluten_cereal");
    }
  });

  it("does not treat nutmeg / butternut as tree nuts", () => {
    for (const t of ["nutmeg", "Muskatnuss", "noix de muscade", "nuez moscada", "butternut squash"]) {
      expect(groups(t, "contains")).not.toContain("tree_nut");
    }
  });

  it("does not treat cream of tartar or lactic acid as milk", () => {
    for (const t of ["cream of tartar", "lactic acid", "Milchsäure"]) {
      expect(groups(t, "contains")).not.toContain("milk");
    }
  });

  it("reads Erdnuss as peanut and Milcheiweiß as milk not egg", () => {
    expect(groups("Erdnuss", "contains")).toEqual(["peanut"]);
    expect(groups("Milcheiweiß", "contains")).toEqual(["milk"]);
    expect(groups("Milcheiweiß", "contains")).not.toContain("egg");
  });

  it("does not match egg inside Weizen or eggplant", () => {
    // eggplant is reported as an egg trap (not_allergen); only allergen relations count here.
    expect(groups("Weizen", "contains")).not.toContain("egg");
    expect(groups("eggplant", "contains")).not.toContain("egg");
  });

  it("reads peanut butter as peanut with no milk", () => {
    const hits = lexiconScan("peanut butter");
    expect(hits.some((h) => h.group === "peanut" && h.relation === "contains")).toBe(true);
    expect(hits.some((h) => h.group === "milk" && h.relation === "contains")).toBe(false);
  });

  it("reads nut-free as a free-from claim with no tree_nut contains", () => {
    const hits = lexiconScan("nut-free");
    expect(hits.some((h) => h.relation === "free_from_claim" && h.claim === "nut_free")).toBe(true);
    expect(hits.some((h) => h.group === "tree_nut" && h.relation === "contains")).toBe(false);
  });

  it("still finds milk in lactose-free milk", () => {
    expect(groups("lactose-free milk", "contains")).toContain("milk");
  });

  it("keyword baseline flags cocoa butter and coconut milk as milk contains", () => {
    expect(keywordBaseline("cocoa butter").some((h) => h.group === "milk")).toBe(true);
    expect(keywordBaseline("coconut milk").some((h) => h.group === "milk")).toBe(true);
    expect(keywordBaseline("may contain milk").some((h) => h.group === "milk")).toBe(true);
  });
});

describe("coconut rule term", () => {
  it("reports coconut as not_allergen tree_nut with rule conflict, never contains", () => {
    for (const t of ["noix de coco", "Kokosnuss", "noce di cocco"]) {
      const hits = lexiconScan(t);
      expect(hits.some((h) => h.group === "tree_nut" && h.relation === "contains")).toBe(false);
      expect(
        hits.some(
          (h) =>
            h.group === "tree_nut" &&
            h.relation === "not_allergen" &&
            h.ruleConflict === "coconut-tree-nut",
        ),
      ).toBe(true);
    }
  });
});

describe("precautionary", () => {
  it("scopes may_contain to the sentence", () => {
    expect(relations("may contain milk", "milk")).toEqual(["may_contain"]);
    const multi = lexiconScan("May contain milk, peanuts and nuts. Salt.");
    const may = multi.filter((h) => h.relation === "may_contain");
    expect(may.map((h) => h.group).sort()).toEqual(["milk", "peanut", "tree_nut"]);
    expect(multi.some((h) => h.term.toLowerCase().includes("salt"))).toBe(false);
  });

  it("reads multilingual precautionary milk patterns", () => {
    for (const t of [
      "Kann Spuren von Milch und Haselnüssen enthalten",
      "Peut contenir des traces de lait",
      "Traces éventuelles de lait",
      "Puede contener trazas de leche",
      "Può contenere tracce di latte",
    ]) {
      expect(relations(t, "milk")).toContain("may_contain");
    }
  });

  it("keeps an ingredient before the precautionary sentence as contains", () => {
    const hits = lexiconScan("wheat flour. May contain milk.");
    expect(hits.some((h) => h.group === "wheat" && h.relation === "contains")).toBe(true);
    expect(hits.some((h) => h.group === "milk" && h.relation === "may_contain")).toBe(true);
  });
});

describe("multilingual allergen terms", () => {
  it("finds wheat compounds and phrases", () => {
    for (const t of ["Weizenmehl", "farine de blé", "harina de trigo", "farina di grano tenero"]) {
      expect(groups(t, "contains")).toContain("wheat");
    }
  });

  it("finds hazelnut with species", () => {
    for (const t of ["Haselnüsse", "noisettes", "avellanas", "nocciole"]) {
      const hit = lexiconScan(t).find((h) => h.group === "tree_nut" && h.relation === "contains");
      expect(hit?.species).toBe("hazelnut");
    }
  });

  it("finds soy lecithin", () => {
    for (const t of ["Sojalecithin", "lécithine de soja"]) {
      expect(groups(t, "contains")).toContain("soy");
    }
  });
});

describe("verifySpans grounding and agreement", () => {
  it("drops ungrounded spans and counts them", () => {
    const spans: ExtractionSpan[] = [
      { evidence_text: "phantom milk", allergen_group: "milk", relation: "contains", lang: "en" },
    ];
    const r = verifySpans("whole milk powder", spans);
    expect(r.dropped).toHaveLength(1);
    expect(r.droppedCount).toBe(1);
  });

  it("grounds despite case and whitespace differences", () => {
    const spans: ExtractionSpan[] = [
      { evidence_text: "Whole  Milk", allergen_group: "milk", relation: "contains", lang: "en" },
    ];
    const r = verifySpans("Ingredients: whole milk powder.", spans);
    expect(r.droppedCount).toBe(0);
    expect(r.rows.some((row) => row.group === "milk" && row.agree)).toBe(true);
  });

  it("treats model gluten_cereal on wheat flour as agreeing with lexicon wheat", () => {
    const spans: ExtractionSpan[] = [
      {
        evidence_text: "wheat flour",
        allergen_group: "gluten_cereal",
        relation: "contains",
        lang: "en",
      },
    ];
    const r = verifySpans("wheat flour", spans);
    expect(r.rows.some((row) => row.agree && row.lexicon)).toBe(true);
  });

  it("disagrees when the model says milk on cocoa butter", () => {
    const spans: ExtractionSpan[] = [
      { evidence_text: "cocoa butter", allergen_group: "milk", relation: "contains", lang: "en" },
    ];
    const r = verifySpans("cocoa butter", spans);
    expect(r.rows.some((row) => row.group === "milk" && row.model && !row.agree)).toBe(true);
  });

  it("adds a model:false row when the lexicon finds milk and the model missed it", () => {
    const r = verifySpans("whole milk powder", []);
    expect(r.rows.some((row) => row.group === "milk" && row.model === false && !row.agree)).toBe(
      true,
    );
  });
});

describe("review fixes", () => {
  it("reads German Eiweiß compounds as protein, not egg", () => {
    expect(groups("Weizeneiweiß", "contains")).toEqual(["wheat"]);
    expect(groups("Erbseneiweiß", "contains")).not.toContain("egg");
    expect(groups("Hühnereiweiß", "contains")).toContain("egg");
  });

  it("does not read the allergen word inside a free-from claim as an ingredient", () => {
    for (const t of ["glutenfrei", "gluten-free", "sans gluten", "milchfrei", "lactose-free", "senza latte"]) {
      expect(groups(t, "contains")).toEqual([]);
    }
    expect(groups("gluten-free oats", "contains")).toEqual(["gluten_cereal"]);
  });

  it("reads Tintenfisch as mollusc, not fish", () => {
    expect(groups("Tintenfisch", "contains")).toEqual(["mollusc"]);
  });

  it("reads nut butters in DE, FR, ES and IT as nuts, not milk", () => {
    for (const t of ["Erdnussbutter", "beurre de cacahuète", "mantequilla de cacahuete", "burro di arachidi"]) {
      expect(groups(t, "contains")).toContain("peanut");
      expect(groups(t, "contains")).not.toContain("milk");
    }
  });

  it("reads nuez de coco as coconut, not walnut", () => {
    expect(groups("nuez de coco", "contains")).toEqual([]);
    expect(lexiconScan("nuez de coco").some((h) => h.ruleConflict === "coconut-tree-nut")).toBe(true);
  });

  it("reads generic German nuts in a precautionary clause", () => {
    expect(relations("Kann Spuren von Nüssen enthalten.", "tree_nut")).toEqual(["may_contain"]);
  });

  it("reads US shared-equipment wording as precautionary", () => {
    expect(relations("Produced on equipment also handling peanuts.", "peanut")).toEqual(["may_contain"]);
    expect(relations("Made in a facility that processes tree nuts.", "tree_nut")).toEqual(["may_contain"]);
  });

  it("does not read corn semolina as wheat", () => {
    expect(groups("Maisgrieß", "contains")).not.toContain("wheat");
  });

  it("ends a German precautionary clause at the sentence end when enthalten comes later", () => {
    const hits = lexiconScan("Kann Spuren von Milch. Zutaten: Haselnüsse, Soja. Kann Sesam enthalten.");
    expect(hits.find((h) => h.group === "milk")?.relation).toBe("may_contain");
    expect(hits.find((h) => h.group === "tree_nut")?.relation).toBe("contains");
    expect(hits.find((h) => h.group === "soy")?.relation).toBe("contains");
    expect(hits.find((h) => h.group === "sesame")?.relation).toBe("may_contain");
  });

  it("counts every lexicon hit under a model span as covered", () => {
    const spans: ExtractionSpan[] = [
      { evidence_text: "milk powder, cream", allergen_group: "milk", relation: "contains", lang: "en" },
    ];
    const r = verifySpans("sugar, milk powder, cream, butter", spans);
    const missed = r.rows.filter((row) => !row.model);
    expect(missed.map((row) => row.term)).toEqual(["butter"]);
  });

  it("records a relation disagreement once, on the model row", () => {
    const spans: ExtractionSpan[] = [
      { evidence_text: "may contain milk", allergen_group: "milk", relation: "contains", lang: "en" },
    ];
    const r = verifySpans("Sugar. May contain milk.", spans);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ model: true, agree: false, lexicon_relation: "may_contain" });
  });

  it("agrees on a real milk hit even when a trap sits in the same span", () => {
    const spans: ExtractionSpan[] = [
      { evidence_text: "cocoa butter, milk powder", allergen_group: "milk", relation: "contains", lang: "en" },
    ];
    const r = verifySpans("sugar, cocoa butter, milk powder", spans);
    expect(r.rows.some((row) => row.model && row.agree)).toBe(true);
  });
});
