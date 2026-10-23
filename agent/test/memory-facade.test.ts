import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HMEM as ReferenceHMEM } from "../../engines/hmem/reference/src/index.ts";
import { EvidenceStore, missingFields } from "../src/evidence/store.ts";
import { OllamaClient } from "../src/llm/ollama.ts";
import {
  HMEM,
  OFFICER,
  groundedShare,
  groundingProblems,
  makeMinerFn,
  makeWordingFn,
  memoryPort,
  openMemory,
  readEvidenceRecord,
  type FactInput,
  type ModelCallRecord,
} from "../src/memory/hmemFacade.ts";
import { seedMemory, SOURCE_FINDINGS } from "../src/memory/seed.ts";
import { clearSku } from "../src/pipeline.ts";
import { decide, type PolicyInput } from "../src/policy/decide.ts";
import { DqGate, GatewayClient } from "../src/zetaris/client.ts";

// H-MEM facade: facts with provenance, allergen-polarity conflicts that always queue,
// officer resolution, dreaming behind approval, "why was this held?", persistence and
// seeding. Every fact, name, notice and reason below is synthetic.

const T0 = Date.parse("2026-10-25T02:00:00Z");
const G = "0012345678905";
const OTHER = "0012345678912";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "clearshelf-hmem-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function mem(opts: { persistDir?: string; minerFn?: (p: string) => Promise<string>; clock?: () => number } = {}): HMEM {
  let t = T0;
  return new HMEM({ actor: "clearshelf-agent", clock: opts.clock ?? (() => (t += 1000)), persistDir: opts.persistDir, minerFn: opts.minerFn });
}

const fdaMilk = (gtin: string | null, ev = "ev-r1-04"): FactInput => ({
  content: `FDA F-0001-2026 reports undeclared milk in GTIN ${gtin ?? "(none)"}`,
  source: "zetaris:clearance_usl.fda_recall",
  origin: "document",
  refs: [ev, "sha-fda"],
  label: "openFDA enforcement report, read through Zetaris",
  gtin,
  brands: ["example-foods"],
  allergen: "milk",
  polarity: "contains",
  notice: "F-0001-2026",
  srcclass: "regulator",
  srcdate: "2026-10-14",
  confidence: 0.9,
});
const veganMilk = (gtin: string | null): FactInput => ({
  content: `Open Food Facts labels claim vegan for GTIN ${gtin}, i.e. free from milk`,
  source: "zetaris:clearance_usl.product",
  origin: "document",
  refs: ["ev-r1-01", "sha-off"],
  label: "Open Food Facts label tags, read through Zetaris",
  gtin,
  brands: ["example-foods"],
  allergen: "milk",
  polarity: "free_from",
  srcclass: "off_labels",
  srcdate: "2026-04-01",
  confidence: 0.5,
});

function stubOllama(reply: (body: { messages: { role: string; content: string }[] }) => string, calls: string[] = []): OllamaClient {
  return new OllamaClient({
    baseUrl: "http://127.0.0.1:11434",
    model: "stub-model",
    ramGuard: false,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
      calls.push(body.messages.map((m) => m.content).join("\n"));
      return new Response(JSON.stringify({ message: { content: reply(body) }, eval_count: 40, eval_duration: 2e8, prompt_eval_count: 500, done_reason: "stop" }), { status: 200 });
    }) as typeof fetch,
  });
}

describe("the facade keeps the reference contract", () => {
  it("is the reference HMEM, constructible with only a clock (as the conformance suite does)", () => {
    const h = new HMEM({ clock: () => T0 });
    expect(h).toBeInstanceOf(ReferenceHMEM);
    const m = h.add({ content: "plain record", source: "test" });
    expect(h.ledger.history(m.id).map((e) => e.action)).toEqual(["create"]);
    expect(() => h.add({ content: "no source", source: "" })).toThrow();
  });
});

describe("facts with provenance", () => {
  it("stores source, origin, refs and tags, and reconfirms a repeated fact instead of duplicating it", () => {
    const h = mem();
    const a = h.addFact(fdaMilk(G));
    expect(a.created).toBe(true);
    expect(a.memory.source).toBe("zetaris:clearance_usl.fda_recall");
    expect(a.memory.provenance).toMatchObject({ origin: "document", refs: ["ev-r1-04", "sha-fda"] });
    expect(a.memory.tags).toEqual(expect.arrayContaining([`gtin:${G}`, "brand:example-foods", "allergen:milk", "polarity:contains", "notice:F-0001-2026", "srcclass:regulator", "srcdate:2026-10-14"]));
    const again = h.addFact(fdaMilk(G, "ev-r2-04"));
    expect(again.created).toBe(false);
    expect(again.memory.id).toBe(a.memory.id);
    expect(h.store.get(a.memory.id)?.provenance.refs).toEqual(["ev-r2-04", "sha-fda", "ev-r1-04"]);
    expect(h.ledger.history(a.memory.id).map((e) => e.action)).toEqual(["create", "update"]);
    expect(h.addFact(fdaMilk(G, "ev-r2-04")).created).toBe(false);
    expect(h.ledger.history(a.memory.id)).toHaveLength(2);
  });
});

describe("allergen-polarity conflicts", () => {
  it("detects contains against free-from on the same GTIN, logs it on both memories and queues it", () => {
    const h = mem();
    const fda = h.addFact(fdaMilk(G)).memory;
    const r = h.addFact(veganMilk(G));
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0]!;
    expect(c).toMatchObject({ allergen: "milk", scope: "gtin", gtin: G, a: fda.id, b: r.memory.id, status: "queued", classA: "regulator", classB: "off_labels" });
    expect(c.score.suggested).toBe(fda.id);
    expect(c.score.a.total).toBeGreaterThan(c.score.b.total);
    for (const id of [fda.id, r.memory.id]) {
      expect(h.ledger.history(id).find((e) => e.action === "conflict_detected")?.details).toMatchObject({ conflictId: c.id, queued: true });
    }
    // Never auto-resolved: the reference scan and its auto-resolve leave it alone.
    h.nativeScan();
    expect(h.allergenConflicts.get(c.id)?.status).toBe("queued");
    expect(h.store.get(fda.id)?.supersededBy).toBeUndefined();
    expect(h.store.get(r.memory.id)?.supersededBy).toBeUndefined();
    // The same pair is not queued twice.
    expect(h.allergenConflicts.scanAll()).toHaveLength(0);
  });

  it("does not compare different GTINs, and does not treat contains against may-contain as a conflict", () => {
    const h = mem();
    h.addFact(fdaMilk(G));
    expect(h.addFact(veganMilk(OTHER)).conflicts).toHaveLength(0);
    expect(h.addFact({ ...veganMilk(G), allergen: "milk", polarity: "may_contain", srcclass: "off_tag", content: "traces tag milk" }).conflicts).toHaveLength(0);
  });

  it("matches by brand when one side has no GTIN (an FSA alert), and wheat against gluten-free", () => {
    const h = mem();
    h.addFact(veganMilk(G));
    const fsa = h.addFact({ ...fdaMilk(null), source: "zetaris:clearance_usl.fsa_alert", notice: "FSA-AA-90-2026", content: "FSA-AA-90-2026 reports undeclared milk for brand Example Foods" });
    expect(fsa.conflicts.map((c) => [c.scope, c.brand])).toEqual([["brand", "example-foods"]]);
    const gf = h.addFact({ ...veganMilk(G), allergen: "gluten_cereal", content: "label claims gluten-free" });
    expect(gf.conflicts).toHaveLength(0);
    const wheat = h.addFact({ ...fdaMilk(G), allergen: "wheat", content: "recall reports undeclared wheat" });
    expect(wheat.conflicts.map((c) => c.allergen)).toEqual(["wheat"]);
  });

  it("resolution is the officer's: loser superseded through store.update, conflict_resolved by officer, nothing deleted", async () => {
    const h = mem();
    const fda = h.addFact(fdaMilk(G)).memory;
    const c = h.addFact(veganMilk(G)).conflicts[0]!;
    const before = h.store.all().length;
    await expect(h.resolveAllergenConflict(c.id, { winner: fda.id, rule: "Not A Label", reason: "x" })).rejects.toThrow(/lower_snake_case/u);
    const done = await h.resolveAllergenConflict(c.id, { winner: fda.id, rule: "regulator_over_crowd_source", reason: "The FDA laboratory finding outranks the crowd-sourced vegan label." });
    expect(done.status).toBe("resolved");
    expect(done.resolution).toMatchObject({ outcome: "keep_a", winner: fda.id, loser: c.b, by: OFFICER, followedSuggestion: true });
    expect(h.store.get(c.b)?.supersededBy).toBe(fda.id);
    const hist = h.ledger.history(c.b);
    expect(hist.slice(-2).map((e) => [e.action, e.actor])).toEqual([
      ["update", OFFICER],
      ["conflict_resolved", OFFICER],
    ]);
    expect(hist.at(-1)?.details).toMatchObject({ rule: "regulator_over_crowd_source" });
    // The reason became an officer memory; nothing was deleted.
    expect(h.store.all().length).toBe(before + done.resolution!.reasonMemoryIds.length);
    expect(h.ledger.all().some((e) => e.action === "delete")).toBe(false);
    const reasonMem = h.store.get(done.resolution!.reasonMemoryIds[0]!)!;
    expect(reasonMem.provenance.origin).toBe("user_correction");
    expect(h.ledger.history(reasonMem.id)[0]).toMatchObject({ action: "create", actor: OFFICER });
    // Writes after the officer block are attributed to the agent again.
    const later = h.add({ content: "later agent note", source: "test" });
    expect(h.ledger.history(later.id)[0]?.actor).toBe("clearshelf-agent");
    await expect(h.resolveAllergenConflict(c.id, { winner: fda.id, rule: "again", reason: "again" })).rejects.toThrow(/already resolved/u);
  });

  it("keep_both leaves both facts standing", async () => {
    const h = mem();
    h.addFact(fdaMilk(G));
    const c = h.addFact(veganMilk(G)).conflicts[0]!;
    await h.resolveAllergenConflict(c.id, { winner: "both", rule: "both_stand_by_lot", reason: "Recall covers lot 1 only; the label applies to later lots." });
    expect(h.store.get(c.a)?.supersededBy).toBeUndefined();
    expect(h.store.get(c.b)?.supersededBy).toBeUndefined();
    expect(h.ledger.history(c.a).at(-1)).toMatchObject({ action: "conflict_resolved", actor: OFFICER });
  });
});

describe("dreaming behind the officer's approval", () => {
  async function twoHolds(h: HMEM, brand = "Northfield Bakery") {
    await h.officerAction({ action: "hold", ruling: "HOLD", gtin: G, brand, market: "UK", reason: "German-only label; hold until an English label is on file." });
    await h.officerAction({ action: "hold", ruling: "HOLD", gtin: OTHER, brand, market: "UK", reason: "Second German-only label from this brand; hold it." });
  }

  it("queues an invariant from two officer rulings, worded by the model, and materialises nothing", async () => {
    const h = mem();
    await twoHolds(h);
    const count = h.store.all().length;
    const calls: ModelCallRecord[] = [];
    const word = makeWordingFn(stubOllama(() => JSON.stringify({ sentence: "Hold Northfield Bakery listings until an English label is on file." })), calls);
    const r = await h.dream(word);
    expect(r.queued).toHaveLength(1);
    const p = r.queued[0]!;
    expect(p).toMatchObject({ status: "proposed", officerActions: 2, predicate: { scope: "brand", value: "northfield-bakery", to: "HOLD" } });
    expect(p.wording).toMatchObject({ by: "stub-model", label: "wording by Nemotron, derived from 2 memories" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ job: "wording", ok: true, label: "measured" });
    expect(h.store.all().length).toBe(count);
    expect(h.escalationsFor({ gtin: "0099999999999", brand: "Northfield Bakery" }).escalations).toHaveLength(0);
    // Re-dreaming the same rulings does not queue the proposal again.
    expect((await h.dream()).queued).toHaveLength(0);
  });

  it("approval materialises a long-term memory with lineage; the invariant can only escalate", async () => {
    const h = mem();
    await twoHolds(h);
    const p = (await h.dream()).queued[0]!;
    const m = h.approveDream(p.id, { reason: "Agreed." });
    expect(m).toMatchObject({ layer: "long_term", derivedFrom: p.derivedFrom });
    expect(m.tags).toEqual(expect.arrayContaining(["dream:invariant", "brand:northfield-bakery", "escalate:HOLD"]));
    expect(h.ledger.history(p.id).map((e) => [e.action, e.actor])).toEqual([["dream_approved", OFFICER]]);
    const { escalations } = h.escalationsFor({ gtin: "0099999999999", brand: "Northfield Bakery" });
    expect(escalations).toEqual([expect.objectContaining({ to: "HOLD", source: "invariant" })]);

    const base: PolicyInput = {
      gtin: "0099999999999",
      market: "UK",
      asOf: "2026-10-25",
      product: { found: true, evidenceIds: ["ev-p"] },
      extraction: { ok: true, hasText: true, unparsedFragments: 0, evidenceIds: ["ev-x"] },
      dqComplete: true,
      recalls: [],
      nameMatches: [],
      dq: [],
      contradictions: [],
      verified: [{ group: "milk", relation: "contains", evidenceIds: ["ev-x"] }],
    };
    expect(decide(base).status).toBe("CLEAR_WITH_STATEMENT");
    expect(decide({ ...base, escalations }).status).toBe("HOLD");
    const blocked = decide({
      ...base,
      market: "US",
      escalations,
      recalls: [{ recall_number: "F-0001-2026", report_date: "2026-10-14", status: "Ongoing", classification: "Class I", distribution: "Nationwide", evidenceIds: ["ev-r"] }],
    });
    expect(blocked.status).toBe("BLOCK");
    expect(() => h.approveDream(p.id)).toThrow(/no pending/u);
  });

  it("rejection materialises nothing; mixed rulings give an advisory proposal; one action is not enough", async () => {
    const h = mem();
    await h.officerAction({ action: "approve", ruling: "CLEAR", gtin: G, brand: "Crackerco", reason: "Label checked, fine." });
    expect((await h.dream()).skipped.length + (await h.dream()).queued.length).toBe(0);
    await h.officerAction({ action: "hold", ruling: "HOLD", gtin: OTHER, brand: "Crackerco", reason: "Hold pending supplier spec." });
    const p = (await h.dream()).queued[0]!;
    expect(p.predicate).toBeNull();
    const n = h.store.all().length;
    h.rejectDream(p.id, { reason: "Not a pattern." });
    expect(h.store.all().length).toBe(n);
    expect(h.dreams("rejected").map((x) => x.id)).toEqual([p.id]);
  });

  it("does not queue a proposal that rests on a single officer action", async () => {
    const h = mem({ minerFn: async () => JSON.stringify(["Hold Crackerco listings pending the supplier spec.", "Crackerco labels must be checked by hand."]) });
    await h.officerAction({ action: "hold", ruling: "HOLD", gtin: G, brand: "Crackerco", reason: "Hold Crackerco listings pending the supplier spec; labels must be checked by hand." });
    const r = await h.dream();
    expect(r.queued).toHaveLength(0);
    expect(r.skipped.map((s) => s.why)).toContain("fewer than two officer actions");
  });
});

// ---------------------------------------------------------------- clearSku integration

const U = "lightning.metastore.clearshelf.clearance_usl";
function body(template_id: string, columns: string[], rows: unknown[][], objects: string[], raw: string[]) {
  return { template_id, role: "reader", columns, rows, row_count: rows.length, truncated: false, elapsed_ms: 3, sql: `-- synthetic ${template_id}`, sql_sha256: `${template_id}`.padEnd(64, "0").slice(0, 64), objects, raw_objects: raw, executed_at: "2026-10-25T10:00:00+08:00", cache_state: "hit", cache_detail: {}, source_cached_at: {}, error: null };
}
function e1Gateway(): GatewayClient {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { template_id } = JSON.parse(String(init?.body)) as { template_id: string };
    let b;
    if (template_id === "product") {
      b = body(template_id, ["gtin", "product_name", "brand", "lang", "ingredients_text", "ingredients_text_en", "labels", "vegan_claim", "last_modified", "source_url"], [[G, "Synthetic Puffs", "Example Foods", "fr", null, null, "en:vegetarian,en:vegan", "yes", "1775064123", "synthetic"]], [`${U}.product`], ["clearshelf_off.off_*"]);
    } else if (template_id === "declared") {
      b = body(template_id, ["declared_key", "market_code", "relation", "source_tag", "display_name"], [], [`${U}.declared_allergen`, `${U}.market_allergen`], ["clearshelf_off.off_*", "clearshelf_ops.market_allergens"]);
    } else if (template_id === "recalls_by_gtin") {
      b = body(
        template_id,
        ["link_key", "raw_code", "transform", "extracted_by", "recall_number", "report_date", "classification", "status", "firm", "distribution", "product_description", "reason", "code_info"],
        [[`F-0001-2026|${G}`, G.slice(1), "upc12_pad13", "manifest", "F-0001-2026", "2026-03-01", "Class I", "Terminated", "Example Foods Inc.", "CA", `Synthetic Puffs UPC ${G.slice(1)}`, "Undeclared milk", "all lots"]],
        [`${U}.recall_product_link`, `${U}.fda_recall`],
        ["clearshelf_ops.recall_links", "clearshelf_fda.enforcement_undeclared"],
      );
    } else if (template_id === "recalls_by_name") {
      b = body(template_id, ["source", "notice_id", "notice_date", "business", "title"], [], [`${U}.fda_recall`, `${U}.fsa_alert`], ["clearshelf_fda.enforcement_undeclared", "clearshelf_fsa.allergy_alerts"]);
    } else if (template_id === "prior_decisions") {
      b = body(template_id, ["decision_id", "gtin"], [], [`${U}.decision`], ["clearshelf_ops.decisions"]);
    } else if (template_id.startsWith("dq_invalid_")) {
      b = body(template_id, ["gtin", "market_code"], [], [`${U}.product`], ["clearshelf_off.off_*"]);
    } else {
      return new Response(JSON.stringify({ error: `unexpected template ${template_id}` }), { status: 400 });
    }
    return new Response(JSON.stringify(b), { status: 200 });
  }) as typeof fetch;
  return new GatewayClient({ fetchImpl });
}

describe("one clearance run into memory (synthetic E1 shape)", () => {
  it("queues the recall-vs-vegan conflict, logs the decision, feeds R4 and answers why", async () => {
    const gateway = e1Gateway();
    const store = new EvidenceStore("rmem", null);
    const ollama = stubOllama(() => JSON.stringify({ product_names: ["Synthetic Puffs"], brands: [], upcs: [G.slice(1)], lots: [], allergens: ["milk"], reason_type: "undeclared_allergen" }));
    const r = await clearSku(G, "UK", { gateway, dq: new DqGate(gateway), ollama, evidence: store }, "2026-10-25");
    expect(r.decision.status).toBe("HOLD");

    const h = mem();
    const ing = h.ingestClearResult(r, store);
    expect(ing.conflicts.map((c) => [c.allergen, c.classA, c.classB])).toEqual([["milk", "regulator", "off_labels"]]);
    expect(ing.added).toBe(6); // FDA milk + vegan free-from milk, egg, fish, crustacean, mollusc
    expect(ing.decision).toMatchObject({ gtin: G, market: "UK", status: "HOLD" });

    const again = h.ingestClearResult(r, store);
    expect(again).toMatchObject({ added: 0, reconfirmed: 6, conflicts: [] });
    expect(h.decisionLog(G, "UK")).toHaveLength(1);

    const check = h.checkMemory(store, { gtin: G, brand: "Example Foods", market: "UK" });
    expect(check.contradictions).toEqual([expect.objectContaining({ kind: "memory_conflict", evidenceIds: [check.evidenceId] })]);
    const ev = store.get(check.evidenceId)!;
    expect(ev.kind).toBe("memory");
    expect(missingFields(ev)).toEqual([]);
    expect(check.context).toContain("[QUEUED ALLERGEN CONFLICTS]");

    const why = h.why(G, "UK");
    expect(why.lines[0]).toMatch(/^HOLD for 0012345678905 in UK/u);
    expect(why.lines.some((l) => /^R1 → HOLD: .*memory mem-\d+ \(zetaris:clearance_usl\.fda_recall, document\)/u.test(l))).toBe(true);
    expect(why.lines.some((l) => /^Allergen conflict ac-[0-9a-f]{12} \(milk\): regulator contains .* queued for the officer/u.test(l))).toBe(true);
    expect(why.lines.at(-1)).toMatch(/^Ledger: mem-\d+: create \(clearshelf-agent/u);
    expect(why.lines.length).toBeLessThanOrEqual(7);

    // The loop's memory port: conflicts and their evidence record, in the same store.
    const port = memoryPort(h, store);
    const rec = await port.recall("rulings and allergen conflicts", { gtin: G, market: "UK", brand: "Example Foods" });
    expect(rec.conflicts).toEqual([expect.objectContaining({ memoryIds: [ing.conflicts[0]!.a, ing.conflicts[0]!.b] })]);
    expect(rec.evidenceIds).toHaveLength(1);
    expect(store.get(rec.evidenceIds![0]!)?.kind).toBe("memory");
    expect(await port.context({ gtin: G, market: "UK" })).toContain(ing.conflicts[0]!.id);
    const bare = await memoryPort(h).recall("x", { gtin: G, market: "UK", brand: null });
    expect(bare.conflicts).toHaveLength(1);
    expect(bare.evidenceIds).toBeUndefined();
  });
});

describe("persistence under data/hmem", () => {
  it("reloads memories, ledger, conflicts, dream queue and decision log", async () => {
    const dir = tempDir();
    const a = mem({ persistDir: dir });
    const fda = a.addFact(fdaMilk(G)).memory;
    const c = a.addFact(veganMilk(G)).conflicts[0]!;
    await a.officerAction({ action: "hold", ruling: "HOLD", gtin: G, brand: "Northfield Bakery", reason: "Hold one." });
    await a.officerAction({ action: "hold", ruling: "HOLD", gtin: OTHER, brand: "Northfield Bakery", reason: "Hold two." });
    const p = (await a.dream()).queued[0]!;
    a.recordDecision({ gtin: G, market: "UK", status: "HOLD", firings: [{ rule: "R1", effect: "HOLD", reason: "recall", evidenceIds: ["ev-r1-04"] }], decidedAt: "2026-10-25T10:00:00+08:00", runId: "r1" });

    const b = mem({ persistDir: dir });
    expect(b.store.get(fda.id)?.content).toBe(fda.content);
    expect(b.ledger.history(fda.id).map((e) => e.action)).toEqual(a.ledger.history(fda.id).map((e) => e.action));
    expect(b.allergenConflicts.get(c.id)?.status).toBe("queued");
    expect(b.dreams("proposed").map((x) => x.id)).toEqual([p.id]);
    expect(b.decisionLog(G)).toHaveLength(1);
    // An approval after a restart works from the persisted queue.
    expect(b.approveDream(p.id).layer).toBe("long_term");
    await b.resolveAllergenConflict(c.id, { winner: fda.id, rule: "regulator_over_crowd_source", reason: "Regulator finding." });
    const c2 = mem({ persistDir: dir });
    expect(c2.allergenConflicts.get(c.id)?.status).toBe("resolved");
    expect(c2.store.get(c.b)?.supersededBy).toBe(fda.id);
  });
});

describe("mining with the Nemotron miner hook", () => {
  it("parses the model's JSON array, drops ungrounded statements and keeps document provenance", async () => {
    const calls: ModelCallRecord[] = [];
    const prompts: string[] = [];
    const miner = makeMinerFn(
      stubOllama(() => JSON.stringify(["The REST table returned HTTP 502 on CREATE.", "Bananas are an excellent source of potassium every day."]), prompts),
      calls,
    );
    const h = mem({ minerFn: miner });
    const doc = "Summary: running CREATE LIGHTNING REST TABLE returned HTTP 502. The REST table create statement returned the 502 badge.";
    const r = await h.mineSourceDocument("known_to_fail/ISSUE-x.md", doc);
    expect(r.via).toBe("model");
    expect(r.memories.map((m) => m.content)).toEqual(["The REST table returned HTTP 502 on CREATE."]);
    expect(r.dropped).toHaveLength(1);
    expect(r.memories[0]!.provenance).toMatchObject({ origin: "document" });
    expect(r.memories[0]!.provenance.refs?.[0]).toBe("known_to_fail/ISSUE-x.md");
    expect(calls[0]).toMatchObject({ job: "miner", ok: true, items: 2, label: "measured" });
    expect(prompts[0]).toContain("<source_text>");
    expect(groundedShare("The REST table returned HTTP 502 on CREATE.", doc)).toBeGreaterThanOrEqual(0.6);
  });

  it("drops a statement whose URL, number or unit the document does not contain verbatim, and authorship lines", () => {
    const doc = "The docs state a limit of 5 requests/minute. Endpoint: https://api.example.invalid/v2/real-time/api/pm25?date=2026-09-18. Reported by: A. Person. Recovery took a 30-second pause.";
    expect(groundingProblems("The endpoint https://api.example.invalid/v2/real-time/api/pm25?date=2026-09-18 is documented at 5 requests/minute.", doc)).toEqual([]);
    expect(groundingProblems("Endpoint https://api.example.invalid/v2/real-true/pm25?date=2026-09-18 is rate limited.", doc)).toEqual([
      "URL not in source: https://api.example.invalid/v2/real-true/pm25?date=2026-09-18",
    ]);
    expect(groundingProblems("The limit is 5 requests/second, recovering after a 30-second pause.", doc)).toContain("term not in source: requests/second");
    expect(groundingProblems("The limit is 6 requests/minute.", doc)).toContain("number not in source: 6");
    expect(groundingProblems("Reported by: A. Person", doc)).toContain("authorship or status line");
  });

  it("falls back to the reference model-free path when the model gives no valid array", async () => {
    const h = mem({ minerFn: makeMinerFn(stubOllama(() => "not json")) });
    const r = await h.mineSourceDocument("doc.md", "Short line.\nAlways send a User-Agent because the API rejects requests without one.");
    expect(r.via).toBe("model-free");
    expect(r.memories.map((m) => m.content)).toEqual(["Always send a User-Agent because the API rejects requests without one."]);
  });
});

describe("seeding at first boot", () => {
  it("parses the manifest, mines the issue files, lists our findings, and skips them all the second time", async () => {
    const gs = tempDir();
    mkdirSync(path.join(gs, "open_data", "rest_apis", "sql", "known_to_fail"), { recursive: true });
    writeFileSync(
      path.join(gs, "open_data", "manifest.json"),
      JSON.stringify({ sources: [{ id: "alpha", kind: "rest", status: "verified", summary: "Synthetic source A" }, { id: "beta", kind: "rest", status: "known_to_fail", summary: "Synthetic source B" }] }),
    );
    writeFileSync(path.join(gs, "open_data", "rest_apis", "sql", "known_to_fail", "ISSUE-09-beta.md"), "# Beta\nThe create statement must use method get because the endpoint rejects HEAD requests.\n");
    writeFileSync(path.join(gs, "open_data", "rest_apis", "sql", "known_to_fail", "README.md"), "not an issue file");
    const dir = tempDir();
    const h = mem({ persistDir: dir });
    const r1 = await seedMemory(h, { gettingStartedDir: gs, repoRoot: tempDir() });
    expect(r1.documents.map((d) => [d.file, d.via, d.memories, d.skipped])).toEqual([
      ["zetaris-getting-started/open_data/manifest.json", "parsed", 2, false],
      ["zetaris-getting-started/open_data/rest_apis/sql/known_to_fail/ISSUE-09-beta.md", "model-free", 1, false],
      ["clearshelf/source-findings", "listed", SOURCE_FINDINGS.length, false],
    ]);
    expect(r1.missing).toEqual(["docs/source-notes.md (the built-in findings below stand in for it)"]);
    const all = h.store.all();
    expect(all.every((m) => m.provenance.origin === "document")).toBe(true);
    expect(all.find((m) => m.tags.includes("zetaris-source:beta"))?.content).toMatch(/is known_to_fail/u);

    const h2 = mem({ persistDir: dir });
    const r2 = await seedMemory(h2, { gettingStartedDir: gs, repoRoot: tempDir() });
    expect(r2.documents.every((d) => d.skipped)).toBe(true);
    expect(h2.store.all().length).toBe(all.length);
    expect(h2.query("rest endpoint HEAD requests", { topN: 3 }).memories.length).toBeGreaterThan(0);

    // The notes a tool depends on come back cited, and the read is in the ledger.
    const notes = h2.notesForTool("zetaris.fsa_allergens");
    expect(notes.memories.length).toBeGreaterThan(0);
    expect(notes.memories.slice(0, 3).map((m) => m.tags.find((t) => t.startsWith("finding:")))).toEqual(["finding:fsa-no-gtin", "finding:fsa-counts", "finding:fsa-update-notations"]);
    expect(notes.context).toMatch(/^\[SOURCE NOTES\]\n- UK FSA allergy alerts carry no GTIN.*<mem-\d+; source note/u);
    expect(h2.ledger.history(notes.memories[0]!.id).at(-1)).toMatchObject({ action: "read", details: { tool: "zetaris.fsa_allergens" } });
  });
});

describe("verified-extraction memories", () => {
  it("are keyed by GTIN, label hash and model, and cite the earlier evidence", () => {
    const h = mem();
    const m = h.rememberExtraction({ gtin: G, textSha12: "abcdef012345", model: "nemotron-3-nano:4b", verified: [{ group: "milk", relation: "contains" }], extractionEvidenceId: "ev-r1-03", verifierEvidenceId: "ev-r1-04", evidenceFile: "data/evidence/r1.jsonl" });
    expect(h.findExtraction(G, "abcdef012345", "nemotron-3-nano:4b")?.id).toBe(m.id);
    expect(h.findExtraction(G, "000000000000", "nemotron-3-nano:4b")).toBeUndefined();
    expect(m.provenance.refs).toEqual(["ev-r1-03", "ev-r1-04", "data/evidence/r1.jsonl"]);
    const dir = tempDir();
    const file = path.join(dir, "r1.jsonl");
    writeFileSync(file, `${JSON.stringify({ id: "ev-r1-03", run_id: "r1", kind: "model_extraction", claim: "x", queried_at: "t" })}\n`);
    expect(readEvidenceRecord(file, "ev-r1-03")?.kind).toBe("model_extraction");
  });

  it("openMemory wires the miner and collects measured call telemetry", async () => {
    const h = openMemory({ persistDir: null, ollama: stubOllama(() => JSON.stringify(["Keep the label hash."])) });
    await h.officerAction({ action: "edit", reason: "Keep the label hash as the reuse key.", gtin: G });
    expect(h.modelCalls).toEqual([expect.objectContaining({ job: "miner", ok: true })]);
    expect(h.actor).toBe("clearshelf-agent");
  });
});
