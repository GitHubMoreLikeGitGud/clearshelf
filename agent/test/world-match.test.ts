import { describe, expect, it } from "vitest";
import { decide } from "../../engines/world-model/reference/src/index.ts";
import { bandOf, brandKey, brandTokens, matchNotice, scoreBrand, titleSimilarity } from "../src/world/match.ts";
import { CatalogueWorld, productId, worldPort, type CatalogueBatch } from "../src/world/world.ts";

// Alias-aware name matching for notices without a GTIN. All names below are synthetic.

describe("brand tokens and the pre-filter", () => {
  it("drops legal forms and short words, keeps distinctive tokens", () => {
    expect(brandTokens("Skinny Crunch Ltd")).toEqual(["skinny", "crunch"]);
    expect(brandTokens("Lidl GB (Lidl UK)")).toEqual(["lidl"]);
    expect(brandTokens("Ülker Gıda A.Ş.")).toContain("ulker");
    expect(brandKey("Skinny crunch")).toBe("skinny-crunch");
    expect(brandTokens("Whole Foods Market")).toEqual(["whole", "market"]);
    expect(scoreBrand("Halo Foods Limited recalls snack bars", { names: ["Whole Foods Market"] })).toBeNull();
  });

  it("never compares a brand with a text that shares no distinctive token", () => {
    expect(scoreBrand("Northfeld Bakry recalls biscuits", { names: ["Northfield Bakery"] })).toBeNull();
    expect(scoreBrand("The Company Ltd recalls biscuits", { names: ["Company Ltd"] })).toBeNull();
  });

  it("uses the reference bands: 0.85 auto-links, [0.82, 0.85) queues, below is token-only", () => {
    expect(bandOf(0.85)).toBe("auto-link");
    expect(bandOf(0.849)).toBe("review");
    expect(bandOf(0.82)).toBe("review");
    expect(bandOf(0.819)).toBe("token-only");
    expect(decide(0.85)).toBe("auto-merge");
    expect(scoreBrand("Skinny Crunch recalls Choc Bar", { names: ["Skinny crunch"] })).toMatchObject({ band: "auto-link", similarity: 1 });
    expect(scoreBrand("Exampel Bakes recalls oat biscuits", { names: ["Example Bakes"] })).toMatchObject({ band: "review", window: "exampel bakes" });
    expect(scoreBrand("Bakes from the farm recalled", { names: ["Example Bakes"] })?.band).toBe("token-only");
  });

  it("scores against every alias and ranks matches by band", () => {
    const m = matchNotice({ source: "fsa", id: "FSA-AA-1-2026", title: "Exampel Bakes recalls oat biscuits", business: null }, [
      { gtin: "1", name: "Oat Biscuits", brand: { names: ["Example Bakes", "Exampel Bakes"] } },
      { gtin: "2", name: "Crackers", brand: { names: ["Example Bakes"] } },
      { gtin: "3", name: "No brand", brand: null },
    ]);
    expect(m.map((x) => [x.gtin, x.brand.band])).toEqual([
      ["1", "auto-link"],
      ["2", "review"],
    ]);
    expect(m[0]!.nameSimilarity).toBe(titleSimilarity("Oat Biscuits", "Exampel Bakes recalls oat biscuits"));
  });
});

const meta = (o: string) => ({ object: `clearance_usl.${o}`, sqlSha256: `sha-${o}` });
function batch(): CatalogueBatch {
  const p = (gtin: string, name: string, brand: string) => ({
    product: { gtin, product_name: name, brand, lang: "en", ingredients_text: null, ingredients_text_en: null, labels: null, vegan_claim: null, last_modified: "1790000000", source_url: null },
    markets: ["UK" as const],
    declared: [],
    recalls: [],
    src: { product: meta("product"), declared: meta("declared_allergen"), recalls: meta("fda_recall") },
  });
  return {
    products: [p("0000000000017", "Oat Biscuits", "Example Bakes"), p("0000000000024", "Choc Bar", "Skinny Crunch")],
    fsa: [
      {
        alert: { notation: "FSA-AA-91-2026", created: "2026-10-15", title: "Exampel Bakes recalls oat biscuits because of undeclared egg", business: "Exampel Bakes", alert_url: null },
        allergens: ["Egg"],
        src: { alert: meta("fsa_alert"), allergens: meta("fsa_alert_allergen") },
      },
    ],
  };
}

describe("merge queue through the reference resolver", () => {
  it("queues a review-band spelling for the officer; an approved merge makes it an alias", async () => {
    const w = new CatalogueWorld({ directory: null, clock: () => new Date("2026-10-25T00:00:00Z") });
    const d = await w.ingest(batch());
    expect(d.nameMatches.map((m) => [m.gtin, m.brand.band])).toEqual([["0000000000017", "review"]]);
    const queue = w.mergeQueue().filter((q) => q.status === "pending");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ leftName: "exampel bakes", rightName: "Example Bakes" });
    expect(queue[0]!.similarity).toBeGreaterThanOrEqual(0.82);
    expect(queue[0]!.similarity).toBeLessThan(0.85);
    // A name match is a review item: no clearance status anywhere.
    expect(Object.keys(w.entity(productId("0000000000017"))!.attrs).some((k) => k.startsWith("clearance:"))).toBe(false);

    await w.approveMerge(queue[0]!.id, "officer");
    expect(w.catalogue().find((c) => c.gtin === "0000000000017")?.brand?.names).toEqual(["Example Bakes", "exampel bakes"]);
    const after = await w.linkNameMatches();
    expect(after.map((m) => [m.gtin, m.brand.band, m.brand.alias])).toEqual([["0000000000017", "auto-link", "exampel bakes"]]);
    expect(w.wm.audit().some((a) => a.kind === "merge-approved" && a.actor === "officer")).toBe(true);
  });

  it("a rejected proposal keeps the spelling separate", async () => {
    const w = new CatalogueWorld({ directory: null });
    await w.ingest(batch());
    const q = w.mergeQueue()[0]!;
    await w.rejectMerge(q.id, "officer");
    expect(w.mergeQueue()[0]?.status).toBe("rejected");
    expect(w.catalogue().find((c) => c.gtin === "0000000000017")?.brand?.names).toEqual(["Example Bakes"]);
  });

  it("looks up by GTIN or by name", async () => {
    const w = new CatalogueWorld({ directory: null });
    await w.ingest(batch());
    const byGtin = w.lookup("0000000000017");
    expect(byGtin.kind).toBe("gtin");
    expect(byGtin.edges?.some((e) => e.type === "name_match" && e.dir === "in")).toBe(true);
    const byName = w.lookup("skinny crunch choc bar");
    expect(byName.matches?.[0]).toMatchObject({ gtin: "0000000000024" });
    const port = worldPort(w);
    expect((await port.lookup("0000000000017")).candidates).toEqual([{ key: productId("0000000000017"), name: "Oat Biscuits", score: 1 }]);
    expect((await port.lookup("Skinny Crunch")).candidates[0]).toMatchObject({ key: productId("0000000000024"), name: "Choc Bar (Skinny Crunch)" });
  });
});
