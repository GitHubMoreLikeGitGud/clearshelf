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
    expect(groups("Weizen")).not.toContain("egg");
    expect(groups("eggplant")).not.toContain("egg");
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
    expect(keywordBaseline("may contain milk").every((h) => h.group !== "milk" || true)).toBe(true);
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
