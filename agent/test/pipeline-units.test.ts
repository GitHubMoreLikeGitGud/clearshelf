import { describe, expect, it } from "vitest";
import {
  BadParams,
  brandToken,
  DqGate,
  GatewayClient,
  GatewayError,
  rowsAsObjects,
  validateParam,
  validateTemplateParams,
} from "../src/zetaris/client.ts";
import { EvidenceStore, missingFields, sourceFor } from "../src/evidence/store.ts";
import { checkUpc, extractNotice, undeclaredGroups, reasonGroups, type NoticeRow } from "../src/extract/notice.ts";
import { allergenDisagreements, verifiedAllergens } from "../src/extract/ingredients.ts";
import { OllamaClient } from "../src/llm/ollama.ts";
import type { ExtractionSpan } from "../src/llm/schemas.ts";
import { verifySpans, type AgreementRow } from "../src/verify/lexicon.ts";

// Every text and row below is synthetic.

function templateBody(over: Record<string, unknown> = {}) {
  return {
    template_id: "product",
    role: "reader",
    columns: ["gtin", "market_code"],
    rows: [],
    row_count: 0,
    truncated: false,
    elapsed_ms: 5,
    sql: "SELECT 1",
    sql_sha256: "abc",
    objects: ["lightning.metastore.clearshelf.clearance_usl.product"],
    raw_objects: ["clearshelf_off.off_*"],
    executed_at: "2026-10-23T10:00:00+0800",
    cache_state: "hit",
    cache_detail: {},
    source_cached_at: {},
    error: null,
    ...over,
  };
}

function gatewayFetch(handler: (body: { template_id: string; params: Record<string, string> }) => { status: number; body: unknown }, calls: string[] = []): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { template_id: string; params: Record<string, string> };
    calls.push(body.template_id);
    const r = handler(body);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
}

describe("gateway client parameters", () => {
  it("accepts H- and F- recall numbers and refuses other prefixes", () => {
    expect(validateParam("fda_notice", "H-1328-2026")).toBe("H-1328-2026");
    expect(validateParam("fda_notice", "F-0636-2025")).toBe("F-0636-2025");
    expect(() => validateParam("fda_notice", "Z-0636-2025")).toThrow(BadParams);
  });

  it("checks GTIN length and check digit before any request", () => {
    expect(validateParam("gtin", "0816929000119")).toBe("0816929000119");
    expect(() => validateParam("gtin", "0816929000118")).toThrow(/check digit/u);
    expect(() => validateParam("gtin", "816929000119")).toThrow(BadParams);
  });

  it("checks template parameter names", () => {
    expect(() => validateTemplateParams("product", {})).toThrow(/missing/u);
    expect(() => validateTemplateParams("product", { gtin: "0816929000119", x: "1" })).toThrow(/unexpected/u);
    expect(() => validateTemplateParams("nope", {})).toThrow(/unknown template/u);
  });

  it("turns a brand into a template-safe token", () => {
    expect(brandToken("Häagen-Dazs")).toBe("haagen dazs");
    expect(brandToken("Ülker")).toBe("ulker");
    expect(brandToken("Co Op")).toBe("co op");
    expect(brandToken("A1")).toBeNull();
    expect(brandToken(null)).toBeNull();
  });

  it("refuses a non-loopback gateway", () => {
    expect(() => new GatewayClient({ baseUrl: "http://10.1.2.3:8791" })).toThrow(GatewayError);
  });

  it("waits out a warm-up 503, then raises on other errors", async () => {
    let n = 0;
    const client = new GatewayClient({
      warmDelayMs: 1,
      fetchImpl: gatewayFetch(() => (n++ === 0 ? { status: 503, body: templateBody({ error: "warming: 1 table" }) } : { status: 200, body: templateBody({ rows: [["0816929000119", null]], row_count: 1 }) })),
    });
    const res = await client.template("product", { gtin: "0816929000119" });
    expect(res.warm_retries).toBe(1);
    expect(rowsAsObjects(res)).toEqual([{ gtin: "0816929000119", market_code: null }]);
    const bad = new GatewayClient({ fetchImpl: gatewayFetch(() => ({ status: 502, body: templateBody({ error: "boom" }) })) });
    await expect(bad.template("product", { gtin: "0816929000119" })).rejects.toBeInstanceOf(GatewayError);
  });
});

describe("DQ gate", () => {
  const g = "0816929000119";
  it("filters table-wide SHOW DQ rows to the GTIN and market, and reuses them within the TTL when asked", async () => {
    const calls: string[] = [];
    const client = new GatewayClient({
      fetchImpl: gatewayFetch(({ template_id }) => {
        if (template_id === "dq_invalid_declared_market_code") {
          return { status: 200, body: templateBody({ template_id, rows: [[g, "UK:blé"], [g, "US:gluten_cereal"], ["4056489125846", "UK:x"]], row_count: 3 }) };
        }
        return { status: 200, body: templateBody({ template_id, rows: [[g, null]], row_count: 1 }) };
      }, calls),
    });
    const gate = new DqGate(client, 300_000);
    const uk = await gate.run(g, "UK");
    const declared = uk.find((r) => r.spec.rule === "declared_market_code")!;
    expect(declared.invalid.map((r) => r.market_code)).toEqual(["UK:blé"]);
    expect(declared.otherMarket.map((r) => r.market_code)).toEqual(["US:gluten_cereal"]);
    expect(uk.every((r) => r.source === "zetaris_dq")).toBe(true);
    const before = calls.length;
    const us = await gate.run(g, "US");
    expect(calls.length).toBe(before);
    expect(us.every((r) => r.reused)).toBe(true);
    expect(us.find((r) => r.spec.rule === "declared_market_code")!.invalid.map((r) => r.market_code)).toEqual(["US:gluten_cereal"]);
  });

  it("falls back to the DQ-equivalent SQL when SHOW DQ fails", async () => {
    const client = new GatewayClient({
      fetchImpl: gatewayFetch(({ template_id }) =>
        template_id.startsWith("dq_invalid_") ? { status: 504, body: templateBody({ template_id, error: "timeout: 60 s" }) } : { status: 200, body: templateBody({ template_id, rows: [], row_count: 0 }) },
      ),
    });
    const res = await new DqGate(client).run(g, "UK");
    expect(res.every((r) => r.source === "dq_equivalent_sql" && r.nativeError && r.fallbackReason?.startsWith("SHOW DQ failed"))).toBe(true);
    expect(res.map((r) => r.result.template_id)).toEqual(["dqsql_has_ingredients", "dqsql_english_label", "dqsql_declared_market_code", "dqsql_extracted_market_code"]);
  });

  it("does not trust a truncated SHOW DQ reply: the GTIN's own DQ-equivalent SQL decides", async () => {
    const calls: string[] = [];
    // 200 rows of other GTINs shown, 450 in all: this GTIN's invalid row is past the cap.
    const others = Array.from({ length: 200 }, () => ["5000169566558", null]);
    const client = new GatewayClient({
      fetchImpl: gatewayFetch(({ template_id }) => {
        if (template_id === "dq_invalid_english_label") return { status: 200, body: templateBody({ template_id, rows: others, row_count: 450, truncated: true }) };
        if (template_id === "dqsql_english_label") return { status: 200, body: templateBody({ template_id, columns: ["gtin"], rows: [[g]], row_count: 1 }) };
        return { status: 200, body: templateBody({ template_id, rows: [], row_count: 0 }) };
      }, calls),
    });
    const res = await new DqGate(client).run(g, "UK");
    const english = res.find((r) => r.spec.rule === "english_label")!;
    expect(english.source).toBe("dq_equivalent_sql");
    expect(english.invalid).toHaveLength(1);
    expect(english.fallbackReason).toMatch(/200 of 450 rows \(truncated/u);
    expect(english.nativeError).toBeNull();
    expect(res.filter((r) => r.spec.rule !== "english_label").every((r) => r.source === "zetaris_dq" && r.fallbackReason === null)).toBe(true);
    expect(calls).toContain("dqsql_english_label");
  });

  it("queries afresh on every run by default, so a GTIN onboarded later is not judged by an older result", async () => {
    const calls: string[] = [];
    let onboarded = false;
    const client = new GatewayClient({
      fetchImpl: gatewayFetch(({ template_id }) => {
        if (template_id === "dq_invalid_english_label" && onboarded) return { status: 200, body: templateBody({ template_id, rows: [[g, null]], row_count: 1 }) };
        return { status: 200, body: templateBody({ template_id, rows: [], row_count: 0 }) };
      }, calls),
    });
    const gate = new DqGate(client);
    expect((await gate.run(g, "UK")).find((r) => r.spec.rule === "english_label")!.invalid).toHaveLength(0);
    onboarded = true;
    const second = await gate.run(g, "UK");
    expect(second.every((r) => !r.reused)).toBe(true);
    expect(second.find((r) => r.spec.rule === "english_label")!.invalid).toHaveLength(1);
    expect(calls.filter((c) => c === "dq_invalid_english_label")).toHaveLength(2);
  });
});

describe("evidence store", () => {
  it("builds a complete Zetaris record, resolving a wildcard OFF source for one GTIN", async () => {
    const store = new EvidenceStore("rtest", null);
    const client = new GatewayClient({
      fetchImpl: gatewayFetch(() => ({ status: 200, body: templateBody({ template_id: "dq_invalid_has_ingredients", rows: [["0816929000119", null], ["5059319005492", null]], row_count: 2 }) })),
    });
    const res = await client.template("dq_invalid_has_ingredients", {});
    const rec = store.fromTemplate(res, "claim", { kind: "dq", dqSource: "zetaris_dq", gtin: "0816929000119", filter: (r) => r.gtin === "0816929000119" });
    expect(rec.id).toBe("ev-rtest-01");
    expect(rec.row_count).toBe(1);
    expect(rec.details?.table_row_count).toBe(2);
    expect(rec.raw_objects).toEqual(["clearshelf_off.off_0816929000119"]);
    expect(rec.source_url).toContain("/api/v2/product/0816929000119.json");
    expect(rec.licence).toBe("Open Food Facts, ODbL 1.0");
    expect(missingFields(rec)).toEqual([]);
  });

  it("names missing fields", () => {
    const store = new EvidenceStore("rtest", null);
    const rec = store.add({ kind: "model_extraction", claim: "x" });
    expect(missingFields(rec)).toEqual(["model", "derived_from"]);
  });

  it("maps every raw source to a URL and licence", () => {
    expect(sourceFor("clearshelf_fda.enforcement_undeclared").licence).toMatch(/CC0/u);
    expect(sourceFor("clearshelf_fsa.allergy_alerts").licence).toMatch(/Open Government Licence v3\.0/u);
    expect(sourceFor("clearshelf_ops.recall_links").url).toBe("http://clearshelf-ops/recall_links.json");
  });
});

describe("notice checks", () => {
  const text = "Crackers 8 oz, UPC 0 12345 67890 5; Lot 24A17. Undeclared milk.";
  it("keeps a UPC only if it is literal in the notice and passes the check digit", () => {
    expect(checkUpc("012345678905", text)).toMatchObject({ literal: true, check_digit: true, kept: true, gtin13: "0012345678905" });
    expect(checkUpc("012345678906", text)).toMatchObject({ literal: false, kept: false });
    expect(checkUpc("4006381333931", "EAN 4006381333931")).toMatchObject({ kept: true, transform: "ean13_exact" });
  });

  it("does not count a generic tree nut that the notice says is coconut", () => {
    expect(undeclaredGroups("Undeclared wheat, milk, tree nut (coconut).").groups.sort()).toEqual(["milk", "wheat"]);
    expect(undeclaredGroups("Undeclared tree nuts (almond, coconut).").groups).toEqual(["tree_nut"]);
    expect(undeclaredGroups("Undeclared pecans.").groups).toEqual(["tree_nut"]);
    expect(reasonGroups("Undeclared wheat, milk, tree nut (coconut).").sort()).toEqual(["milk", "tree_nut", "wheat"]);
  });

  it("checks the model's notice extraction against the record", async () => {
    const row: NoticeRow = {
      recall_number: "F-0001-2025",
      report_date: "2025-01-01",
      classification: "Class I",
      status: "Ongoing",
      firm: "Example Foods",
      distribution: "US",
      product_description: "Crackers 8 oz, UPC 0 12345 67890 5",
      reason: "Undeclared milk and wheat.",
      code_info: "Lot 24A17",
    };
    const content = JSON.stringify({ product_names: ["Crackers"], brands: ["Example"], upcs: ["012345678905", "999999999999"], lots: ["24A17", "ZZZ"], allergens: ["milk", "soy"], reason_type: "undeclared_allergen" });
    const ollama = new OllamaClient({
      baseUrl: "http://127.0.0.1:11434",
      model: "m",
      ramGuard: false,
      fetchImpl: (async () => new Response(JSON.stringify({ message: { content }, eval_count: 10, eval_duration: 1e8, prompt_eval_count: 50, done_reason: "stop" }), { status: 200 })) as typeof fetch,
    });
    const res = await extractNotice(row, ollama);
    expect(res.ok).toBe(true);
    expect(res.upcs.filter((u) => u.kept).map((u) => u.gtin13)).toEqual(["0012345678905"]);
    expect(res.lots_literal).toEqual(["24A17"]);
    expect(res.lots_not_found).toEqual(["ZZZ"]);
    expect(res.allergens_agreed).toEqual(["milk"]);
    expect(res.allergens_model_only).toEqual(["soy"]);
    expect(res.allergens_reason_only).toEqual(["wheat"]);
    expect(res.model).toMatchObject({ name: "m", tokens_in: 50, tokens_out: 10, label: "measured", attempts: 1 });
  });
});

describe("ingredient agreement helpers", () => {
  const row = (r: Partial<AgreementRow>): AgreementRow => ({
    group: "milk",
    relation: "contains",
    model: true,
    lexicon: true,
    agree: true,
    evidence_text: "milk",
    grounded: true,
    ...r,
  });

  it("reports a gluten_cereal span on a wheat word as wheat, and keeps nut species", () => {
    const v = verifiedAllergens([
      row({ group: "gluten_cereal", evidence_text: "wheat flour", term: "wheat" }),
      row({ group: "tree_nut", evidence_text: "almonds", term: "almonds" }),
      row({ group: "milk", agree: false }),
    ]);
    expect(v.map((x) => [x.group, x.species ?? null])).toEqual([
      ["wheat", null],
      ["tree_nut", "almond"],
    ]);
  });

  const readingsOf = (text: string, spans: ExtractionSpan[]) => {
    const { rows } = verifySpans(text, spans);
    return allergenDisagreements(rows, text).map((d) => [d.source, d.model ? `${d.model.group}/${d.model.relation}` : null, d.readings.map((r) => `${r.group}/${r.relation}${r.species ? `/${r.species}` : ""}`).join(";")]);
  };
  const span = (evidence_text: string, allergen_group: ExtractionSpan["allergen_group"], relation: ExtractionSpan["relation"]): ExtractionSpan => ({ evidence_text, allergen_group, relation, lang: "en" });

  it("finds missed may-contain allergens, not only contains", () => {
    expect(readingsOf("Sugar, cocoa mass, cocoa butter, vanilla extract. May contain milk and nuts.", [])).toEqual([
      ["row", null, "milk/may_contain"],
      ["row", null, "tree_nut/may_contain"],
    ]);
  });

  it("reads both sides of a relation disagreement, and a model may-contain span the verifier rejects", () => {
    expect(readingsOf("Sugar, cocoa mass. May contain nuts.", [span("nuts", "tree_nut", "contains")])).toEqual([["row", "tree_nut/contains", "tree_nut/contains;tree_nut/may_contain"]]);
    expect(readingsOf("Sugar, cocoa butter.", [span("cocoa butter", "milk", "may_contain")])).toEqual([["row", "milk/may_contain", "milk/may_contain"]]);
  });

  it("finds an allergen hidden under a span the model calls no allergen", () => {
    expect(readingsOf("Sugar, whey powder, salt.", [span("whey powder", "none", "not_allergen")])).toEqual([["row", "none/not_allergen", "milk/contains"]]);
  });

  it("scans the label for a second nut inside an agreed span", () => {
    expect(readingsOf("Sugar, hazelnuts and almonds, salt.", [span("hazelnuts and almonds", "tree_nut", "contains")])).toEqual([["label_scan", null, "tree_nut/contains/almond"]]);
  });

  it("returns nothing when every allergen is agreed", () => {
    expect(readingsOf("Wheat flour, milk. May contain peanuts.", [span("Wheat flour", "gluten_cereal", "contains"), span("milk", "milk", "contains"), span("peanuts", "peanut", "may_contain")])).toEqual([]);
  });
});

describe("name similarity for R2", () => {
  it("scores the product name against the best part of a long notice title", async () => {
    const { bestNameSimilarity } = await import("../src/pipeline.ts");
    expect(bestNameSimilarity("Chocolate Chip Cookies", "Example Bakery, Chocolate Chip Cookies, 12 oz, UPC 012345678905")).toBe(1);
    expect(bestNameSimilarity("Chocolate Chip Cookies", "Frozen shrimp, 2 lb bag")).toBeLessThan(0.5);
  });
});
