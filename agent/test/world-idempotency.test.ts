import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CatalogueWorld,
  RETRACTED,
  allergenId,
  marketId,
  noticeId,
  productId,
  toIsoUtc,
  type CatalogueBatch,
  type DeclaredRow,
  type ProductBundle,
} from "../src/world/world.ts";

// Re-ingesting the same Zetaris rows must leave the world unchanged: no new event and the
// same canonical state. Every row below is synthetic, shaped like the gateway templates
// product, declared, recalls_by_gtin, fsa_recent and fsa_allergens.

const U = "clearance_usl";
const meta = (object: string) => ({ object: `${U}.${object}`, sqlSha256: `sha-${object}` });
const G1 = "0012345678905";
const G2 = "0012345678912";
const G3 = "0012345678929";

const recall = (gtin: string, status = "Ongoing") => ({
  link_key: `F-0001-2026|${gtin}`,
  raw_code: gtin.slice(1),
  transform: "upc12_pad13",
  extracted_by: "manifest",
  recall_number: "F-0001-2026",
  report_date: "2026-10-14",
  classification: "Class I",
  status,
  firm: "Example Bakes Inc.",
  distribution: "Nationwide (synthetic)",
  product_description: "Example Oat Biscuits and Multi Brand Crackers (synthetic)",
  reason: "Undeclared milk",
  code_info: "Lot 1 (synthetic)",
});

const decl = (code: string, relation: string): DeclaredRow => ({ declared_key: `${code}|${relation}`, market_code: code, relation, source_tag: `en:${code.split(":")[1]}`, display_name: "x" });

function product(gtin: string, name: string, brand: string | null, lastModified: string, declared: DeclaredRow[], recalls: ReturnType<typeof recall>[], markets: ("UK" | "US")[] = ["UK"]): ProductBundle {
  return {
    product: {
      gtin,
      product_name: name,
      brand,
      lang: "en",
      ingredients_text: "synthetic ingredient list",
      ingredients_text_en: null,
      labels: "en:vegan",
      vegan_claim: "yes",
      last_modified: lastModified,
      source_url: `https://example.invalid/${gtin}`,
    },
    markets,
    declared,
    recalls,
    src: { product: meta("product"), declared: meta("declared_allergen"), recalls: meta("fda_recall") },
  };
}

function batch(opts: { status?: string; p1Declared?: DeclaredRow[]; p1Modified?: string } = {}): CatalogueBatch {
  return {
    products: [
      product(
        G1,
        "Example Oat Biscuits",
        "Example Bakes",
        opts.p1Modified ?? "1790000000",
        opts.p1Declared ?? [decl("UK:milk", "contains"), decl("UK:egg", "contains"), decl("UK:egg", "may_contain"), decl("US:milk", "contains")],
        [recall(G1, opts.status)],
        ["UK", "US"],
      ),
      product(G2, "Skinny Crunch Choc Bar", "Skinny Crunch", "1789000000", [decl("UK:milk", "may_contain")], []),
      product(G3, "Multi Brand Crackers", "Example Bakes, Crackerco", "1788000000", [], [recall(G3, opts.status)]),
    ],
    fsa: [
      {
        alert: { notation: "FSA-AA-90-2026", created: "2026-10-13", title: "Skinny Crunch recalls Choc Bar because of undeclared milk", business: "Skinny Crunch Ltd", alert_url: "https://example.invalid/90" },
        allergens: ["Milk"],
        src: { alert: meta("fsa_alert"), allergens: meta("fsa_alert_allergen") },
      },
      {
        alert: { notation: "FSA-AA-91-2026", created: "2026-10-15", title: "Exampel Bakes recalls oat biscuits because of undeclared egg", business: "Exampel Bakes", alert_url: "https://example.invalid/91" },
        allergens: ["Egg", "Crustaceans"],
        src: { alert: meta("fsa_alert"), allergens: meta("fsa_alert_allergen") },
      },
      {
        alert: { notation: "FSA-AA-92-2026-update-1", created: "2026-10-16", title: "Unrelated Dairy updates its alert", business: null, alert_url: null },
        allergens: null,
        src: { alert: meta("fsa_alert") },
      },
    ],
  };
}

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "clearshelf-world-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("World Model ingest is idempotent", () => {
  it("re-ingesting the same rows appends no event and leaves the canonical state unchanged", async () => {
    const w = new CatalogueWorld({ directory: null });
    const first = await w.ingest(batch());
    expect(first.changed).toBe(true);
    expect(first.appended).toBeGreaterThan(20);
    const second = await w.ingest(batch());
    expect(second.appended).toBe(0);
    expect(second.changed).toBe(false);
    expect(second.stateAfter).toBe(first.stateAfter);
    expect(second.writes).toMatchObject({ entities: 0, edges: 0, retractions: 0 });
  });

  it("stays idempotent across a reload from disk (event log replayed, then the same rows again)", async () => {
    const dir = tempDir();
    const a = new CatalogueWorld({ directory: dir });
    const first = await a.ingest(batch());
    const b = new CatalogueWorld({ directory: dir });
    expect(b.stateHash()).toBe(first.stateAfter);
    expect(b.eventCount()).toBe(first.eventsAfter);
    const again = await b.ingest(batch());
    expect(again.appended).toBe(0);
    expect(again.stateAfter).toBe(first.stateAfter);
  });

  it("negative control: a changed source row does change the state", async () => {
    const w = new CatalogueWorld({ directory: null });
    const first = await w.ingest(batch());
    const changed = await w.ingest(batch({ status: "Terminated" }));
    expect(changed.changed).toBe(true);
    expect(changed.stateAfter).not.toBe(first.stateAfter);
    expect(w.entity(noticeId("fda", "F-0001-2026"))?.attrs.status).toBe("Terminated");
  });

  it("keeps every target of a multi-valued relation open (per-target contexts)", async () => {
    const w = new CatalogueWorld({ directory: null });
    await w.ingest(batch());
    const declares = w.edges({ from: productId(G1), type: "declares" });
    expect(declares.map((r) => `${r.attrs?.market}:${r.to}:${r.attrs?.relation}`).sort()).toEqual([
      `UK:${allergenId("egg")}:contains`,
      `UK:${allergenId("egg")}:may_contain`,
      `UK:${allergenId("milk")}:contains`,
      `US:${allergenId("milk")}:contains`,
    ]);
    expect(w.edges({ to: productId(G1), type: "concerns" })).toHaveLength(1);
    expect(w.edges({ to: productId(G3), type: "concerns" })).toHaveLength(1);
    expect(w.edges({ from: productId(G3), type: "made_by" })).toHaveLength(2);
    expect(w.edges({ from: noticeId("fsa", "FSA-AA-91-2026"), type: "reports" }).map((r) => r.to).sort()).toEqual([allergenId("crustacean"), allergenId("egg")]);
    expect(w.entity(noticeId("fsa", "FSA-AA-92-2026-update-1"))?.attrs.allergens_read).toBe(false);
  });

  it("closes an edge the source no longer lists, at the new source time, and keeps its history", async () => {
    const w = new CatalogueWorld({ directory: null });
    await w.ingest(batch());
    const newer = "1792000000";
    const d = await w.ingest(batch({ p1Modified: newer, p1Declared: [decl("UK:milk", "contains"), decl("UK:egg", "contains"), decl("US:milk", "contains")] }));
    expect(d.writes.retractions).toBe(1);
    const open = w.edges({ from: productId(G1), type: "declares" }).map((r) => r.attrs?.relation);
    expect(open).not.toContain("may_contain");
    const closed = w.edges({ from: productId(G1), type: "declares", includeClosed: true }).find((r) => r.attrs?.relation === "may_contain");
    expect(closed?.validTo).toBe(toIsoUtc(newer));
    expect(w.asOf(G1, "2026-09-25").edges.some((r) => r.type === "declares" && r.attrs?.relation === "may_contain")).toBe(true);
    expect(w.asOf(G1, toIsoUtc(newer)!).edges.some((r) => r.type === "declares" && r.attrs?.relation === "may_contain")).toBe(false);
    expect(w.shape().relationships.some((r) => r.to === RETRACTED)).toBe(true);
    const again = await w.ingest(batch({ p1Modified: newer, p1Declared: [decl("UK:milk", "contains"), decl("UK:egg", "contains"), decl("US:milk", "contains")] }));
    expect(again.appended).toBe(0);
  });

  it("dates every write from the source record, never from the clock", async () => {
    const w = new CatalogueWorld({ directory: null, clock: () => new Date("2030-01-01T00:00:00Z") });
    await w.ingest(batch());
    const ats = new Set(w.wm.events().map((e) => e.at));
    expect([...ats].some((a) => a.startsWith("2030"))).toBe(false);
    expect(ats.has("2026-10-14T00:00:00.000Z")).toBe(true);
    expect(w.edges({ to: productId(G1), type: "concerns" })[0]?.validFrom).toBe("2026-10-14T00:00:00.000Z");
  });
});

describe("decisions, snapshots and what we knew when", () => {
  it("records each decision once, with the clearance fact, listing status and a snapshot", async () => {
    const w = new CatalogueWorld({ directory: tempDir() });
    await w.ingest(batch());
    const hold = { decisionId: "d1", gtin: G1, market: "UK" as const, status: "HOLD", rules: ["R1", "R4"], decidedAt: "2026-10-23T12:00:00+08:00", actor: "clearshelf-policy", runId: "r1", evidenceId: "ev-r1-20" };
    const s1 = await w.recordDecision(hold);
    const events = w.eventCount();
    const s1again = await w.recordDecision(hold);
    expect(w.eventCount()).toBe(events);
    expect(s1again.id).toBe(s1.id);
    expect(s1.product?.attrs["clearance:UK"]).toBe("HOLD");
    expect(s1.notices.map((n) => n.id)).toEqual([noticeId("fda", "F-0001-2026"), noticeId("fsa", "FSA-AA-91-2026")]);
    expect(s1.edges.find((e) => e.type === "name_match")?.attrs).toMatchObject({ band: "review" });

    const s2 = await w.recordDecision({ ...hold, decisionId: "d2", status: "BLOCK", decidedAt: "2026-10-24T09:00:00Z", runId: "r2" });
    expect(w.entity(productId(G1))?.attrs["clearance:UK"]).toBe("BLOCK");
    const facts = w.shape().facts.filter((f) => f.about === productId(G1));
    expect(facts.map((f) => [f.value, !!f.supersededBy])).toEqual(
      expect.arrayContaining([
        ["HOLD", true],
        ["BLOCK", false],
      ]),
    );
    const listing = w.edges({ from: productId(G1), type: "listed_in", to: marketId("UK") });
    expect(listing).toHaveLength(1);
    expect(listing[0]?.attrs).toMatchObject({ status: "BLOCK", decision: "d2" });

    expect(w.knewWhen(G1, "2026-10-23T23:00:00Z")?.id).toBe(s1.id);
    expect(w.knewWhen(G1, "2026-10-24T10:00:00Z")?.id).toBe(s2.id);
    expect(w.knewWhen(G1, "2026-10-01T00:00:00Z")).toBeNull();

    const reloaded = new CatalogueWorld({ directory: w.directory });
    expect(reloaded.snapshotsFor(G1).map((s) => s.id)).toEqual([s1.id, s2.id]);
  });

  it("answers source-time questions: a notice reported on 14 Oct is absent as of 12 Oct", async () => {
    const w = new CatalogueWorld({ directory: null });
    await w.ingest(batch());
    expect(w.asOf(G1, "2026-10-12").edges.some((r) => r.type === "concerns")).toBe(false);
    expect(w.asOf(G1, "2026-10-14").edges.some((r) => r.type === "concerns")).toBe(true);
    const tl = w.timeline(G1);
    expect(tl.length).toBeGreaterThan(3);
    expect(tl.map((l) => l.at)).toEqual([...tl.map((l) => l.at)].sort());
  });
});
