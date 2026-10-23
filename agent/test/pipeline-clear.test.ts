import { describe, expect, it } from "vitest";
import { clearSku, type ClearResult } from "../src/pipeline.ts";
import { DqGate, GatewayClient } from "../src/zetaris/client.ts";
import { EvidenceStore } from "../src/evidence/store.ts";
import { OllamaClient } from "../src/llm/ollama.ts";
import type { ExtractionSpan } from "../src/llm/schemas.ts";
import type { Market } from "../src/policy/decide.ts";

// clearSku end to end on a fake gateway and a stub model. Every label, tag and row below is synthetic.

const GTIN = "0012345678905";
const U = "lightning.metastore.clearshelf.clearance_usl";

interface Sku {
  text: string;
  labels?: string | null;
  /** [market_code, relation, source_tag, display_name] */
  declared?: [string, "contains" | "may_contain", string, string | null][];
}

function body(template_id: string, columns: string[], rows: unknown[][], objects: string[], raw: string[]) {
  return {
    template_id,
    role: "reader",
    columns,
    rows,
    row_count: rows.length,
    truncated: false,
    elapsed_ms: 3,
    sql: `-- synthetic ${template_id}`,
    sql_sha256: "0".repeat(64),
    objects,
    raw_objects: raw,
    executed_at: "2026-10-23T12:00:00+08:00",
    cache_state: "hit",
    cache_detail: {},
    source_cached_at: {},
    error: null,
  };
}

function fakeGateway(sku: Sku, calls: string[]): GatewayClient {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { template_id } = JSON.parse(String(init?.body)) as { template_id: string };
    calls.push(template_id);
    let b;
    switch (template_id) {
      case "product":
        b = body(
          template_id,
          ["gtin", "product_name", "brand", "lang", "ingredients_text", "ingredients_text_en", "labels", "vegan_claim", "last_modified", "source_url"],
          [[GTIN, "Example Bar", "Example Foods", "en", sku.text, null, sku.labels ?? null, null, "2026-10-01", "synthetic"]],
          [`${U}.product`],
          ["clearshelf_off.off_*"],
        );
        break;
      case "declared":
        b = body(
          template_id,
          ["declared_key", "market_code", "relation", "source_tag", "display_name"],
          (sku.declared ?? []).map(([code, rel, tag, name], i) => [`${GTIN}:${i}`, code, rel, tag, name]),
          [`${U}.declared_allergen`, `${U}.market_allergen`],
          ["clearshelf_off.off_*", "clearshelf_ops.market_allergens"],
        );
        break;
      case "recalls_by_gtin":
        b = body(template_id, ["link_key", "recall_number"], [], [`${U}.recall_product_link`, `${U}.fda_recall`], ["clearshelf_ops.recall_links", "clearshelf_fda.enforcement_undeclared"]);
        break;
      case "recalls_by_name":
        b = body(template_id, ["source", "notice_id", "notice_date", "business", "title"], [], [`${U}.fda_recall`, `${U}.fsa_alert`], ["clearshelf_fda.enforcement_undeclared", "clearshelf_fsa.allergy_alerts"]);
        break;
      case "prior_decisions":
        b = body(template_id, ["decision_id", "gtin"], [], [`${U}.decision`], ["clearshelf_ops.decisions"]);
        break;
      default:
        if (template_id.startsWith("dq_invalid_")) {
          b = body(template_id, ["gtin", "market_code"], [], [`${U}.product`], ["clearshelf_off.off_*"]);
          break;
        }
        return new Response(JSON.stringify({ error: `unexpected template ${template_id}` }), { status: 400 });
    }
    return new Response(JSON.stringify(b), { status: 200 });
  }) as typeof fetch;
  return new GatewayClient({ fetchImpl });
}

function stubModel(spans: ExtractionSpan[]): OllamaClient {
  const content = JSON.stringify({ spans, label_language: "en", unparsed_fragments: [] });
  return new OllamaClient({
    baseUrl: "http://127.0.0.1:11434",
    model: "stub",
    ramGuard: false,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ message: { content }, eval_count: 20, eval_duration: 1e8, prompt_eval_count: 300, done_reason: "stop" }), { status: 200 })) as typeof fetch,
  });
}

async function run(sku: Sku, spans: ExtractionSpan[], market: Market): Promise<{ r: ClearResult; store: EvidenceStore; calls: string[] }> {
  const calls: string[] = [];
  const gateway = fakeGateway(sku, calls);
  const store = new EvidenceStore("rtest", null);
  const r = await clearSku(GTIN, market, { gateway, dq: new DqGate(gateway), ollama: stubModel(spans), evidence: store }, "2026-10-23");
  return { r, store, calls };
}

const s = (evidence_text: string, allergen_group: ExtractionSpan["allergen_group"], relation: ExtractionSpan["relation"]): ExtractionSpan => ({ evidence_text, allergen_group, relation, lang: "en" });
const r4 = (r: ClearResult) => r.decision.firings.filter((f) => f.rule === "R4").map((f) => f.reason);
const rules = (r: ClearResult) => [...new Set(r.decision.firings.map((f) => f.rule))].sort();

function expectFullyCited(r: ClearResult, store: EvidenceStore): void {
  expect(r.quality.e_cov).toBe(1);
  expect(r.quality.e_complete).toBe(1);
  const ids = new Set(store.all().map((e) => e.id));
  for (const f of [...r.decision.firings, ...r.decision.review]) {
    expect(f.evidenceIds.length).toBeGreaterThan(0);
    for (const id of f.evidenceIds) expect(ids.has(id)).toBe(true);
  }
}

describe("clearSku: a missed allergen never reaches a clearance", () => {
  const darkChoc: Sku = { text: "Sugar, cocoa mass, cocoa butter, vanilla extract. May contain milk and nuts.", labels: "en:vegan" };

  it.each(["UK", "US"] as const)("holds when the model misses every may-contain allergen (%s)", async (market) => {
    const { r, store } = await run(darkChoc, [], market);
    expect(r.decision.status).toBe("HOLD");
    expect(rules(r)).toEqual(["R4"]);
    expect(r4(r).join(" | ")).toMatch(/"milk" as milk may_contain and the model missed it/u);
    expect(r4(r).join(" | ")).toMatch(/"nuts" as tree_nut may_contain and the model missed it/u);
    expect(r.claim_tests).toEqual([expect.objectContaining({ claim: "vegan", verdict: "PARTLY_SUPPORTED", contradicting: ["milk"] })]);
    expectFullyCited(r, store);
  });

  it("holds when the model misses one may-contain allergen among agreed ones", async () => {
    const sku: Sku = { text: "Sugar, cocoa mass, soya lecithin. May contain peanuts, milk and nuts." };
    const { r, store } = await run(sku, [s("soya lecithin", "soy", "contains"), s("peanuts", "peanut", "may_contain"), s("milk", "milk", "may_contain")], "UK");
    expect(r.decision.status).toBe("HOLD");
    expect(r4(r)).toEqual([expect.stringMatching(/"nuts" as tree_nut may_contain and the model missed it/u)]);
    expect(r.statement?.text).toBe("Contains: Soybeans. May contain: Peanuts, Milk.");
    expectFullyCited(r, store);
  });

  const nuts: Sku = { text: "Wheat flour, sugar, hazelnuts, almonds, salt. May contain peanuts." };

  it.each(["UK", "US"] as const)("holds when a missed nut species or may-contain allergen is in a group already verified (%s)", async (market) => {
    const { r } = await run(nuts, [s("Wheat flour", "gluten_cereal", "contains"), s("hazelnuts", "tree_nut", "contains")], market);
    expect(r.decision.status).toBe("HOLD");
    const why = r4(r).join(" | ");
    expect(why).toMatch(/"almonds" as tree_nut \(almond\) contains/u);
    expect(why).toMatch(/"peanuts" as peanut may_contain/u);
  });

  it("proposes the full statement when every allergen is agreed, with matching Open Food Facts tags", async () => {
    const sku: Sku = {
      ...nuts,
      declared: [
        ["UK:gluten_cereal", "contains", "en:gluten", "Cereals containing gluten"],
        ["UK:tree_nut", "contains", "en:nuts", "Nuts"],
        ["UK:peanut", "may_contain", "en:peanuts", "Peanuts"],
      ],
    };
    const spans = [s("Wheat flour", "gluten_cereal", "contains"), s("hazelnuts", "tree_nut", "contains"), s("almonds", "tree_nut", "contains"), s("peanuts", "peanut", "may_contain")];
    const uk = await run(sku, spans, "UK");
    expect(uk.r.decision.status).toBe("CLEAR_WITH_STATEMENT");
    expect(uk.r.statement?.text).toBe("Contains: Cereals containing gluten (wheat), Nuts (hazelnut, almond). May contain: Peanuts.");
    expect(uk.r.contradictions).toEqual([]);
    expectFullyCited(uk.r, uk.store);
    const us = await run(sku, spans, "US");
    expect(us.r.decision.status).toBe("CLEAR_WITH_STATEMENT");
    expect(us.r.statement?.text).toBe("Contains: Tree nuts (hazelnut, almond), Wheat. May contain: Peanuts.");
  });

  it("names spelt in the UK and holds while it is missed; in the US spelt is wheat and only a review note", async () => {
    const sku: Sku = { text: "Wheat flour, spelt flour, sugar." };
    const spans = [s("Wheat flour", "gluten_cereal", "contains")];
    const uk = await run(sku, spans, "UK");
    expect(uk.r.decision.status).toBe("HOLD");
    expect(r4(uk.r)).toEqual([expect.stringMatching(/"spelt" as wheat contains and the model missed it/u)]);
    const us = await run(sku, spans, "US");
    expect(us.r.decision.status).toBe("CLEAR_WITH_STATEMENT");
    expect(us.r.statement?.text).toBe("Contains: Wheat.");
    expect(us.r.decision.review.map((f) => f.reason)).toEqual([expect.stringMatching(/already state in US: .*"spelt"/u)]);
    const agreed = await run(sku, [...spans, s("spelt flour", "gluten_cereal", "contains")], "UK");
    expect(agreed.r.decision.status).toBe("CLEAR_WITH_STATEMENT");
    expect(agreed.r.statement?.text).toBe("Contains: Cereals containing gluten (wheat, spelt).");
  });

  it("holds on a traces tag the label text does not support, and clears without it", async () => {
    const plain: Sku = { text: "Sugar, cocoa mass, vanilla extract." };
    const clear = await run(plain, [], "UK");
    expect(clear.r.decision.status).toBe("CLEAR");
    expect(rules(clear.r)).toEqual(["R6"]);
    const tagged = await run({ ...plain, declared: [["UK:tree_nut", "may_contain", "en:nuts", "Nuts"]] }, [], "UK");
    expect(tagged.r.decision.status).toBe("HOLD");
    expect(r4(tagged.r)).toEqual([expect.stringMatching(/declared_vs_extraction.*tree_nut \(may contain, traces tag en:nuts\)/u)]);
  });

  it("queries the gateway only through named templates", async () => {
    const { calls } = await run(darkChoc, [], "UK");
    expect(new Set(calls)).toEqual(
      new Set(["product", "declared", "recalls_by_gtin", "recalls_by_name", "dq_invalid_has_ingredients", "dq_invalid_english_label", "dq_invalid_declared_market_code", "dq_invalid_extracted_market_code", "prior_decisions"]),
    );
  });
});
