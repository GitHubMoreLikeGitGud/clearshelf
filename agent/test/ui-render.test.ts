// Render tests for the officer UI (ui/): the view modules are plain ES modules whose render
// functions are pure, so they load in Node. Every fixture is synthetic: made-up GTINs, product
// names and label text, nothing from data/ and no Open Food Facts text.

import { describe, expect, it } from "vitest";

type Fn = (...args: any[]) => any;
type Mod = Record<string, Fn>;
const load = async (p: string): Promise<Mod> => (await import(new URL(`../../ui/${p}`, import.meta.url).href)) as Mod;

const lib = await load("lib.js");
const card = await load("views/card.js");
const watch = await load("views/watch.js");
const intake = await load("views/intake.js");
const memory = await load("views/memory.js");
const stream = await load("views/stream.js");

const G = "0012345678905";
const RUN = "r20261001T100000abcd";
const ev = (n: number) => `ev-${RUN}-${String(n).padStart(2, "0")}`;
const EVIL = `Bar <script>alert(1)</script> "quoted"`;
const TEXT = "Oat flakes, sugar, milk powder, cocoa butter. May contain hazelnuts.";

function records() {
  return [
    { id: ev(1), run_id: RUN, kind: "zetaris_sql", claim: "product row", template_id: "product", raw_objects: ["clearshelf_off.off_0012345678905"], sources: [{ object: "clearshelf_off.off_0012345678905", url: "https://example.org/p", licence: "Open Food Facts, ODbL 1.0", cached_at: "2026-10-01T09:00:00+0800" }], columns: ["gtin", "product_name", "ingredients_text"], rows: [[G, EVIL, TEXT]], queried_at: "2026-10-01T10:00:00+0800" },
    { id: ev(2), run_id: RUN, kind: "zetaris_sql", claim: "recall", template_id: "recalls_by_gtin", raw_objects: ["clearshelf_ops.recall_links", "clearshelf_fda.enforcement_undeclared"], queried_at: "2026-10-01T10:00:01+0800" },
    { id: ev(3), run_id: RUN, kind: "model_extraction", claim: "spans", derived_from: [ev(1)], details: { text_field: "ingredients_text" }, queried_at: "2026-10-01T10:00:02+0800" },
    {
      id: ev(4),
      run_id: RUN,
      kind: "verifier",
      claim: "agreement",
      derived_from: [ev(3), ev(1)],
      details: {
        agreement: [
          { group: "milk", relation: "contains", model: true, lexicon: true, agree: true, evidence_text: "milk powder" },
          { group: "none", relation: "not_allergen", model: true, lexicon: true, agree: true, evidence_text: "cocoa butter" },
          { group: "tree_nut", relation: "may_contain", model: false, lexicon: true, agree: false, evidence_text: "hazelnuts" },
        ],
      },
      queried_at: "2026-10-01T10:00:03+0800",
    },
    { id: ev(5), run_id: RUN, kind: "dq", claim: "DQ english_label on product (Zetaris DQ): no invalid record for this GTIN", template_id: "dq_invalid_english_label", raw_objects: ["clearshelf_off.off_0012345678905"], dq_source: "zetaris_dq", queried_at: "2026-10-01T10:00:04+0800" },
    { id: ev(6), run_id: RUN, kind: "memory", claim: "Memory: 2 hits", details: { hits: [{ id: "mem-9", text: "synthetic note" }] }, queried_at: "2026-10-01T10:00:05+0800" },
    { id: ev(7), run_id: RUN, kind: "policy", claim: "Decision HOLD (R1, R4)", derived_from: [ev(2), ev(4)], queried_at: "2026-10-01T10:00:06+0800" },
  ];
}

function run(over: Record<string, unknown> = {}) {
  return {
    run_id: RUN,
    gtin: G,
    market: "UK",
    as_of: "2026-10-01",
    product: { found: true, name: EVIL, brand: "Example", lang: "en", has_text: true, text_field: "ingredients_text", labels: "en:vegan" },
    decision: {
      status: "HOLD",
      firings: [
        { rule: "R1", effect: "HOLD", reason: "synthetic recall of this GTIN", evidenceIds: [ev(2)] },
        { rule: "R4", effect: "HOLD", reason: "model and verifier disagree on hazelnuts", evidenceIds: [ev(4), ev(3)] },
      ],
      review: [],
      notes: [],
      autoExecutable: true,
      pendingSignature: false,
      policyVersion: "test",
    },
    statement: { market: "UK", contains: [{ name: "Milk", label: "Milk", groups: ["milk"], evidenceIds: [ev(4)] }], mayContain: [], toConfirm: [{ name: "Nuts", label: "Nuts (hazelnut)", groups: ["tree_nut"], evidenceIds: [ev(4)] }], excluded: [], text: "Contains: Milk, Nuts (hazelnut) (to confirm)." },
    claim_tests: [{ claim: "vegan", verdict: "NOT_SUPPORTED", contradicting: ["milk"], evidenceIds: [ev(4)] }],
    contradictions: [{ kind: "model_vs_verifier", text: "the verifier reads hazelnuts and the model missed it", evidenceIds: [ev(4), ev(3)] }],
    not_checked: [{ id: "lots", text: "lot codes not matched" }],
    card: [
      { text: "Product row: synthetic", evidenceIds: [ev(1)] },
      { text: "FDA synthetic recall names this GTIN", evidenceIds: [ev(2)] },
      { text: "Extraction: 2 spans", evidenceIds: [ev(3), ev(1)] },
      { text: "DQ english_label on product (Zetaris DQ): no invalid record for this GTIN", evidenceIds: [ev(5)] },
      { text: "Memory: 2 hits", evidenceIds: [ev(6)] },
      { text: "Decision HOLD (R1, R4)", evidenceIds: [ev(7)] },
      { text: "Contradiction (model_vs_verifier): synthetic", evidenceIds: [ev(4)] },
    ],
    extraction: { ran: true, reused: false, spans: 2, agreed: 2, disagreed: 1, keyword_contains: ["milk"], unparsed_fragments: [] },
    name_matches: [],
    dq: [{ rule: "english_label", table: "product", source: "zetaris_dq", invalid: 0 }],
    gaps: [],
    loop: { chunks: 1, status: "completed", timeline: [{ chunk: 1, seq: 1, source: "model", tool: "zetaris.product", thought: "synthetic", ok: true, fact: `product read [${ev(1)}]`, evidence_ids: [ev(1)] }], chart: [{ chunk: 1, markovian_prompt_tokens_measured: 1000, naive_prompt_tokens_estimated: 900 }], chunk_telemetry: [], summary: {}, checklist: [] },
    saved: { source: "server", applied: true, decision_id: "d-x", note: "HOLD applied automatically", at: "2026-10-01T02:00:00.000Z", replay: null },
    ...over,
  };
}

function cardModel(over: { run?: Record<string, unknown>; banner?: string | null; pending?: unknown[]; decision?: unknown } = {}) {
  return {
    gtin: G,
    market: "UK",
    records: records(),
    data: {
      gtin: G,
      banner: over.banner ?? null,
      sku: { gtin: G, markets: ["UK"], name: "Test Bar", brand: "Example" },
      markets: { UK: { decision: over.decision ?? null, run: run(over.run), pending: over.pending ?? [] } },
    },
  };
}

/** The HTML of every <li> whose opening tag carries the class. */
function items(html: string, cls: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<li class="${cls}[" ]`, "gu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const end = html.indexOf("</li>", m.index);
    out.push(html.slice(m.index, end));
  }
  return out;
}

describe("ui: escaping", () => {
  it("escapes a product name and a notice title that carry <script> and quotes", () => {
    const html = card.renderCard!(cardModel());
    expect(html).not.toContain("<script>");
    expect(html).toContain("Bar &lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot;");
    const sweep = watch.renderSweep!({ sweep_id: "w20261001T100000abcd", kind: "poll", window: { after: "2026-10-01", up_to: "2026-10-02" }, model: { calls: 1, tokens_in: 1, tokens_out: 1, label: "measured" }, notices: [{ source: "fda", notice_id: "H-0001-2026", date: "2026-10-02", title: EVIL, allergens: ["milk"], exact_gtins: [], name_candidates: [], evidence_ids: [] }], exact_matches: [], name_matches: [], actions: [], recheck: { rows: [] }, gaps: [] });
    expect(sweep).not.toContain("<script>");
    expect(sweep).toContain("&lt;script&gt;");
    expect(lib.escapeHtml!(`<a href="x" onclick='y'>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;");
  });

  it("escapes the planner's thought in the live stream", () => {
    const line = stream.renderStreamEvent!("loop.planner", { valid: true, tool: "zetaris.product", thought: EVIL, prompt_tokens: 10, eval_tokens: 2 });
    expect(line).not.toContain("<script>");
    expect(line).toContain("measured");
  });
});

describe("ui: the SKU card", () => {
  it("gives every claim and every firing at least one evidence chip", () => {
    const html = card.renderCard!(cardModel());
    const firings = items(html, "firing");
    expect(firings).toHaveLength(2);
    for (const f of firings) expect(f).toMatch(/class="ev" data-ev="ev-/u);
    const claims = [...html.matchAll(/<li><span class="claims__text">[\s\S]*?<\/li>/gu)].map((m) => m[0]);
    expect(claims.length).toBeGreaterThanOrEqual(3);
    for (const c of claims) expect(c).toMatch(/class="ev" data-ev="ev-/u);
    for (const c of items(html, "dq--ok")) expect(c).toMatch(/class="ev" data-ev="ev-/u);
  });

  it("puts every card claim somewhere: a source, the DQ gate, memory, the band or the contradictions", () => {
    const g = card.groupClaims!(run().card, records());
    expect(g.off.map((c: { text: string }) => c.text)).toEqual(["Product row: synthetic", "Extraction: 2 spans"]);
    expect(g.fda).toHaveLength(1);
    expect(g.dq).toHaveLength(1);
    expect(g.memory).toHaveLength(1);
    expect(g.band).toHaveLength(1);
    expect(g.contradiction).toHaveLength(1);
    const total = Object.values(g).reduce((n: number, list) => n + (list as unknown[]).length, 0);
    expect(total).toBe(run().card.length);
  });

  it("highlights each span, with a tick when model and verifier agree and a cross when they do not", () => {
    const html = card.highlightSpans!(TEXT, records()[3]!.details!.agreement);
    expect(html).toMatch(/<mark class="sp sp--contains sp--ok"[^>]*>milk powder<span class="sp__v" aria-hidden="true">✓<\/span>/u);
    expect(html).toMatch(/<mark class="sp sp--not_allergen sp--ok"[^>]*>cocoa butter<span class="sp__v" aria-hidden="true">✓<\/span>/u);
    expect(html).toMatch(/<mark class="sp sp--may_contain sp--bad"[^>]*>hazelnuts<span class="sp__v" aria-hidden="true">✗<\/span>/u);
    expect(html).toContain("Oat flakes, sugar, ");
    expect(card.highlightSpans!(`a <b> milk`, [{ evidence_text: "milk", agree: true, relation: "contains" }])).toContain("a &lt;b&gt; ");
  });

  it("gives an overlapping span to the longer one", () => {
    const html = card.highlightSpans!("nut oil, nut", [
      { evidence_text: "nut", agree: false, relation: "contains", group: "tree_nut" },
      { evidence_text: "nut oil", agree: true, relation: "not_allergen", group: "none" },
    ]);
    expect(html.match(/<mark /gu)).toHaveLength(2);
    expect(html).toMatch(/>nut oil<span class="sp__v"/u);
  });

  it("shows the replay banner only when the data has one, with the server's text exactly", () => {
    expect(lib.replayBanner!("Replay as of 10 Oct 2026")).toContain('<div class="replay"><strong class="replay__text">Replay as of 10 Oct 2026</strong>');
    expect(lib.replayBanner!(null)).toBe("");
    expect(lib.replayBanner!("")).toBe("");
  });

  it("labels a replayed run as a replay, and a live run as live while the watch is replaying", () => {
    const replayed = card.renderCard!(cardModel({ banner: "Replay from 10 Oct 2026, polled to 23 Oct 2026", run: { saved: { source: "watch", applied: true, decision_id: "rp-1", note: "HOLD applied", at: "2026-10-01T02:00:00.000Z", replay: "Replay from 10 Oct 2026, polled to 23 Oct 2026" } }, decision: { decision_id: "rp-0012345678905-UK-x", status: "HOLD", actor: "clearshelf-agent", decided_at: "2026-10-01T10:00:00+0800", contract_id: "c-1" } }));
    expect(replayed).toContain('<span class="tag tag--replay">Replay from 10 Oct 2026, polled to 23 Oct 2026</span>');
    expect(replayed).toContain('<span class="tag tag--replay">replay row</span>');
    expect(replayed).not.toContain("live run");
    const live = card.renderCard!(cardModel({ banner: "Replay as of 10 Oct 2026" }));
    expect(live).toContain("live run, not part of the replay");
    expect(live).not.toContain('class="replay"');
    expect(card.renderCard!(cardModel())).not.toContain("live run");
  });

  it("keeps every officer button disabled until a reason is typed, and marks statement entries still to confirm", () => {
    const pending = [{ id: "q-test-1", kind: "proposal", state: "pending", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk (to confirm).", reasons: ["R5 synthetic"], created_at: "2026-10-01T02:00:00.000Z", replay: null }];
    const html = card.actionPanel!(G, "UK", { decision: null, pending }, run());
    expect(html).toContain('data-act="approve" disabled');
    expect(html).toContain('data-act="reject" disabled');
    expect(html).toContain('data-act="HOLD" disabled');
    expect(html).toContain('data-act="BLOCK" disabled');
    expect(html).toContain("Confirm or remove them before approving");
    const held = card.actionPanel!(G, "UK", { decision: { status: "HOLD" }, pending: [] }, run());
    expect(held).toContain('data-act="release" disabled');
    const st = card.renderCard!(cardModel());
    expect(st).toContain('<span class="to-confirm">(to confirm)</span>');
  });

  it("says when a run applied nothing, and not when it queued a proposal", () => {
    const evalRun = card.renderCard!(cardModel({ run: { saved: { source: "eval", applied: false, note: "investigation only", at: "2026-10-01T02:00:00.000Z" } } }));
    expect(evalRun).toContain("This run applied nothing");
    const queued = card.renderCard!(cardModel({ run: { saved: { source: "server", applied: false, queue_id: "q-1", note: "queued", at: "2026-10-01T02:00:00.000Z" } } }));
    expect(queued).not.toContain("This run applied nothing");
  });

  it("drops the raw [ev-…] list from timeline facts, since the chips carry the ids", () => {
    const html = card.renderCard!(cardModel());
    expect(html).toContain("product read ");
    expect(html).not.toContain(`[${ev(1)}]`);
  });
});

describe("ui: the recall watch", () => {
  const sweep = {
    sweep_id: "w20261001T100000abcd",
    kind: "poll",
    banner: "Replay from 10 Oct 2026, polled to 23 Oct 2026",
    window: { after: "2026-10-10", up_to: "2026-10-23" },
    model: { calls: 2, tokens_in: 100, tokens_out: 20, label: "measured" },
    notices: [],
    exact_matches: [{ notice_id: "H-0002-2026", gtin: G, by: ["recall_product_link"], evidence_ids: [ev(2)] }],
    name_matches: [{ notice_id: "FSA-AA-1-2026", source: "fsa", gtin: "0012345678912", market: "UK", similarity: 0.4, confirmed_in_zetaris: true, queue_id: "q-nm-1", evidence_ids: [ev(3)] }],
    actions: [
      { gtin: G, market: "UK", trigger: "synthetic notice", status: "HOLD", rules: ["R1"], applied: true, decision_id: "rp-1", visible_in_zetaris: true, run_id: "w20261001T100000abcd", reason: "synthetic", evidence_ids: [ev(2)] },
      { gtin: G, market: "US", trigger: "synthetic notice", status: "BLOCK", rules: ["R1"], applied: true, decision_id: "rp-2", visible_in_zetaris: false, run_id: "w20261001T100000abcd", reason: "synthetic", evidence_ids: [ev(2)] },
    ],
    recheck: { rows: [], evidence_id: null },
    gaps: [],
  };

  it("renders exact-match actions with HOLD and BLOCK chips, the decision and Zetaris visibility", () => {
    const html = watch.renderSweep!(sweep, []);
    expect(html).toContain('data-status="HOLD"');
    expect(html).toContain('data-status="BLOCK"');
    expect(html).toContain("rp-<wbr>1");
    expect(html).toMatch(/Visible in Zetaris<\/dt><dd><span class="cross">no<\/span>/u);
    expect(html).toContain('data-mount="token-chart" data-run="w20261001T100000abcd"');
  });

  it("offers Confirm and Dismiss on a pending name-only match, disabled until a reason is typed", () => {
    const item = { id: "q-nm-1", kind: "name_match", state: "pending", gtin: "0012345678912", market: "UK", notice_id: "FSA-AA-1-2026", similarity: 0.4, summary: "synthetic", run_id: "w20261001T100000abcd", evidence_ids: [], replay: null };
    const html = watch.renderSweep!(sweep, [item]);
    expect(html).toContain('data-act="confirm" disabled');
    expect(html).toContain('data-act="dismiss" disabled');
    expect(watch.renderQueue!([item])).toContain('data-act="confirm" disabled');
  });

  it("computes orphans in the join map as links minus in catalogue", () => {
    const html = watch.renderJoinMap!({ rows: [{ transform: "upc12_pad13", links: "11", in_catalogue: "9" }, { transform: "ean13", links: 3, in_catalogue: 3 }], sql: "SELECT 1", elapsed_ms: 12, cache_state: "hit" });
    expect(html).toMatch(/upc12_pad13<\/code><\/th><td>11<\/td><td>9<\/td><td>2<\/td>/u);
    expect(html).toMatch(/ean13<\/code><\/th><td>3<\/td><td>3<\/td><td>0<\/td>/u);
  });
});

describe("ui: intake and catalogue", () => {
  it("parses pasted barcodes and flags lengths and check digits", () => {
    const list = intake.parseGtins!(`${G}, 0012345678904\n12345 abc ${G}`);
    expect(list.map((x: { value: string; ok: boolean }) => [x.value, x.ok])).toEqual([
      [G, true],
      ["0012345678904", false],
      ["12345", false],
      ["abc", false],
    ]);
    expect(list[1].why).toBe("check digit does not match");
  });

  it("lists what needs the officer: signatures, then name matches, then contradictions; not recall holds", () => {
    const auto = (rules: string) => `auto HOLD (policy p1): ${rules}`;
    const sku = (gtin: string, decision: unknown, pending: unknown[] = []) => ({ gtin, name: gtin, brand: "", markets: ["UK"], decisions: { UK: decision }, pending, latest_runs: {} });
    const cat = {
      skus: [
        sku("0000000000017", { status: "HOLD", actor: "clearshelf-agent", reason: auto("R4 the model and the verifier disagree") }),
        sku("0000000000024", { status: "HOLD", actor: "clearshelf-agent", reason: auto("R1 recall of this barcode; R4 the model and the verifier disagree") }),
        sku("0000000000031", null, [{ id: "q1", kind: "proposal", market: "UK", status: "CLEAR" }]),
        sku("0000000000048", { status: "HOLD", actor: "clearshelf-agent", reason: auto("R3 no ingredient list") }, [{ id: "n1", kind: "name_match", market: "UK" }]),
        sku("0000000000055", { status: "HOLD", actor: "officer", reason: "officer HOLD: supplier spec missing" }),
        sku("0000000000062", { status: "BLOCK", actor: "clearshelf-agent", reason: "auto BLOCK (policy p1): R1 recall of this barcode" }),
      ],
    };
    const html = intake.renderCatalogue!(cat, "you");
    expect(html).toMatch(/data-filter="you" aria-pressed="true">Needs you <span class="filter__n">3<\/span>/u);
    const order = [...html.matchAll(/#\/sku\/(\d{13})\/UK/gu)].map((m) => m[1]);
    expect(order).toEqual(["0000000000031", "0000000000048", "0000000000017"]);
  });

  it("normalises UPC-A, EAN-8 and GTIN-14 to the GTIN-13 and refuses case codes", () => {
    const list = intake.parseGtins!(`816929000119 0816929000119 96385074 00816929000119 10816929000116 81692900011`);
    expect(list.map((x: { value: string; ok: boolean; input?: string }) => [x.value, x.ok, x.input ?? null])).toEqual([
      ["0816929000119", true, "816929000119"],
      ["0000096385074", true, "96385074"],
      ["10816929000116", false, null],
      ["81692900011", false, null],
    ]);
    expect(list[0].kind).toBe("UPC-A");
    expect(list[2].why).toMatch(/case code/u);
    expect(list[3].why).toMatch(/11 digits/u);
  });

  it("counts listings per filter and shows pending proposals next to the decision", () => {
    const cat = {
      skus: [
        { gtin: G, name: EVIL, brand: "", markets: ["UK", "US"], decisions: { UK: { status: "HOLD" }, US: null }, pending: [{ id: "q", kind: "proposal", market: "US", status: "CLEAR" }], latest_runs: {} },
        { gtin: "0012345678912", name: "Seed Bar", brand: "", markets: ["UK"], decisions: { UK: null }, pending: [], latest_runs: {} },
      ],
    };
    const html = intake.renderCatalogue!(cat, "all");
    expect(html).toMatch(/data-filter="all" aria-pressed="true">All listings <span class="filter__n">3<\/span>/u);
    expect(html).toMatch(/data-filter="HOLD"[^>]*>HOLD <span class="filter__n">1<\/span>/u);
    expect(html).toMatch(/data-filter="pending"[^>]*>Waiting for signature <span class="filter__n">1<\/span>/u);
    expect(html).toMatch(/data-filter="none"[^>]*>Not cleared <span class="filter__n">1<\/span>/u);
    expect(html).toMatch(/data-status="CLEAR" data-proposed="yes">CLEAR<span class="chip__prop">proposed<\/span>/u);
    expect(html).toContain("waiting for your signature");
    expect(html).not.toContain("<script>");
    expect(intake.renderCatalogue!(cat, "BLOCK")).toContain("No listing matches this filter.");
  });

  it("maps tools to the five intake stages", () => {
    expect(lib.STAGES).toEqual(["registering in Zetaris", "fetching", "reading", "verifying", "deciding"]);
    expect(lib.stageOfTool!("registrar.register_off")).toBe(0);
    expect(lib.stageOfTool!("zetaris.recalls_by_gtin")).toBe(1);
    expect(lib.stageOfTool!("extract.ingredients")).toBe(2);
    expect(lib.stageOfTool!("memory.recall")).toBe(3);
    expect(lib.stageOfTool!("policy.propose")).toBe(4);
    expect(lib.stageOfTool!("zetaris.prior_decisions")).toBeNull();
  });
});

describe("ui: memory", () => {
  it("renders a queued conflict with a resolve form whose button waits for a reason", () => {
    const c = { id: "ac-1", allergen: "milk", scope: "gtin", gtin: G, a: "mem-1", b: "mem-2", polarityA: "contains", polarityB: "free_from", classA: "regulator", classB: "off_labels", detectedAt: "2026-10-01T02:00:00.000Z", status: "queued", score: { a: { total: 0.9 }, b: { total: 0.3 }, suggested: "mem-1", margin: 0.6, suggestedRule: "regulator_over_off_labels" } };
    const html = memory.renderConflict!(c);
    expect(html).toContain('data-act="resolve" disabled');
    expect(html).toContain("<code>regulator_over_off_labels</code>");
    expect(html).toMatch(/value="presence" checked/u);
    expect(html).toContain("data-free-warn hidden");
  });

  it("labels a dream proposal's wording exactly as stored and counts what it was derived from", () => {
    const html = memory.renderDream!({ id: "dp-1", content: "reference text", wording: { text: `Hold ${EVIL}`, by: "nemotron-3-nano:4b", label: "worded by Nemotron (synthetic label)" }, derivedFrom: ["mem-1", "mem-2"], officerActions: 2, predicate: { scope: "brand", value: "example", to: "HOLD" }, status: "proposed" });
    expect(html).toContain("worded by Nemotron (synthetic label)");
    expect(html).toContain("derived from 2 memories");
    expect(html).toContain('data-act="approve" disabled');
    expect(html).not.toContain("<script>");
  });
});

const whyView = await load("views/why.js");
const evalView = await load("views/eval.js");

describe("ui: legibility fixes", () => {
  it("names every rule in plain English, as a tooltip and for screen readers", () => {
    const badge = lib.ruleBadge!("R3");
    expect(badge).toContain('title="R3: Data-quality rule failed.');
    expect(badge).toContain('<span class="sr-only">R3, Data-quality rule failed</span>');
    expect(lib.ruleLegend!(["R1", "R0"])).toContain("Investigation incomplete");
  });

  it("turns policy reasons into one plain line each, and the decision into one sentence", () => {
    expect(lib.plainReason!("R3", "DQ has_ingredients on product: 1 invalid record(s) for this GTIN (Zetaris DQ)")).toBe("No ingredient list");
    expect(lib.plainReason!("R3", "DQ english_label on product: 1 invalid record(s) for this GTIN (Zetaris DQ)")).toBe("Label not in English");
    expect(lib.plainReason!("R4", "unresolved contradiction (memory_conflict): H-MEM allergen conflict ac-add70e2928a8 queued for the officer: milk contains (regulator, mem-76) vs free from (off_labels, mem-77)")).toBe("FDA says milk; the label says milk-free: you decide");
    expect(lib.plainReason!("R4", 'unresolved contradiction (model_vs_verifier): the verifier reads "noix" as tree_nut (walnut) contains and the model missed it')).toBe('The model missed "noix" (walnut); the verifier found it');
    expect(lib.plainReason!("R1", "H-1328-2026 (Class I, Terminated, reported 2026-09-09): recall of this GTIN within 24 months; lot codes not matched")).toBe("Recalled by the FDA (H-1328-2026, terminated) within 24 months; lot codes not checked");
    const s = lib.decisionSentence!("HOLD", [
      { rule: "R1", effect: "HOLD", reason: "H-1328-2026 (Class I, Terminated, reported 2026-09-09): recall of this GTIN within 24 months; lot codes not matched" },
      { rule: "R3", effect: "HOLD", reason: "DQ has_ingredients on product: 1 invalid record(s) for this GTIN (Zetaris DQ)" },
      { rule: "R4", effect: "HOLD", reason: "unresolved contradiction (claim_not_supported): x" },
      { rule: "R4", effect: "HOLD", reason: "unresolved contradiction (claim_not_supported): y" },
    ]);
    expect(s).toBe("Held: recalled by the FDA (H-1328-2026, terminated) within 24 months; lot codes not checked; no ingredient list and 2 contradictions for you to settle.");
  });

  it("labels an applied hold as applied, groups firings by rule and replaces the band's chip pile with one sentence", () => {
    const html = card.renderCard!(cardModel());
    expect(html).toContain('<h2 class="band__k" id="h-band">Decision, applied automatically</h2>');
    expect(html).toContain('class="band__sentence"');
    expect(html.match(/<div class="rulegroup">/gu)).toHaveLength(2);
  });

  it("never shows a pending proposal with the applied tick, and says when it was later signed", () => {
    expect(lib.statusChip!("CLEAR", { proposed: true })).not.toContain("chip__glyph");
    const queued = { saved: { source: "server", applied: false, queue_id: "q-1", note: "queued", at: "2026-10-01T02:00:00.000Z" }, decision: { ...run().decision, status: "CLEAR_WITH_STATEMENT", autoExecutable: false, pendingSignature: true, firings: [{ rule: "R5", effect: "CLEAR_WITH_STATEMENT", reason: "1 verified allergen span(s); none of R1-R4", evidenceIds: [ev(7)] }] } };
    const pending = card.renderCard!({ ...cardModel({ run: queued }), queue: [{ id: "q-1", state: "pending" }] });
    expect(pending).toContain("waiting for your signature");
    expect(pending).toContain('data-proposed="yes"');
    const signed = card.renderCard!({
      ...cardModel({ run: queued, decision: { decision_id: "d-1", status: "CLEAR_WITH_STATEMENT", actor: "officer", decided_at: "2026-10-01T11:00:00+0800", contract_id: "c-1", reason: "label checked" } }),
      queue: [{ id: "q-1", state: "executed", resolution: { by: "officer", at: "2026-10-01T03:00:00.000Z", decision_id: "d-1", contract_id: "c-1" } }],
    });
    expect(signed).toContain("Proposed by the policy, approved and signed");
    expect(signed).not.toContain("waiting for your signature");
    expect(signed).toContain("Since then: proposal executed");
  });

  it("says when a conflict named by the run was resolved after it", () => {
    const r = { contradictions: [{ kind: "memory_conflict", text: "H-MEM allergen conflict ac-0123abcd queued for the officer: milk contains (regulator, mem-1) vs free from (off_labels, mem-2)", evidenceIds: [ev(6)] }] };
    const conflicts = [{ id: "ac-0123abcd", a: "mem-1", b: "mem-2", polarityA: "contains", polarityB: "free_from", classA: "regulator", classB: "off_labels", status: "resolved", resolution: { outcome: "keep_a", winner: "mem-1", rule: "regulator_over_off_labels", by: "officer", at: "2026-10-01T03:00:00.000Z" } }];
    const html = card.renderCard!({ ...cardModel({ run: r }), conflicts });
    expect(html).toContain("Resolved since this run");
  });

  it("offers a release with no status chosen, lists the rules it overrides and warns before a CLEAR without a statement", () => {
    const r = run({ notices: [{ recall_number: "H-0001-2026", undeclared_groups: ["milk"] }] });
    const html = card.actionPanel!(G, "UK", { decision: { status: "HOLD" }, pending: [] }, r);
    expect(html).not.toMatch(/name="status" value="[A-Z_]+" checked/u);
    expect(html).toContain("You would be overriding");
    expect(html).toContain("Recall of this barcode");
    expect(html).toContain("data-clear-warn hidden");
    expect(html).toContain("FDA H-0001-2026: undeclared");
    expect(html).toContain("I have checked that no allergen statement is needed");
  });

  it("shows what is signed before the signature", () => {
    const pending = [{ id: "q-test-1", kind: "proposal", state: "pending", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk.", reasons: ["R5 synthetic"], created_at: "2026-10-01T02:00:00.000Z", replay: null, run_id: RUN }];
    const html = card.actionPanel!(G, "UK", { decision: null, pending }, run({ statement: { market: "UK", contains: [], mayContain: [{ name: "Milk", groups: ["milk"], evidenceIds: [ev(4)] }], toConfirm: [], excluded: [], text: "May contain: Milk." } }));
    expect(html).toContain('<dl class="sign" data-sign>');
    expect(html).toContain("valid for 15 minutes");
    expect(html).toContain('data-names="Milk"');
  });

  it("marks keyword-baseline hits and the verifier's trap reading in the label text", () => {
    const text = "Cocoa mass, cocoa butter. May contain milk.";
    const checks = { keyword: [{ group: "milk", term: "butter", start: 18, end: 24 }, { group: "milk", term: "milk", start: 38, end: 42 }], traps: [{ group: "milk", term: "cocoa butter", start: 12, end: 24, reason: "cocoa butter is not milk fat" }] };
    const html = card.highlightSpans!(text, [{ group: "milk", relation: "may_contain", model: true, lexicon: true, agree: true, evidence_text: "milk" }], checks);
    expect(html).toMatch(/<mark class="sp sp--not_allergen sp--trap sp--kw"[^>]*>cocoa butter/u);
    expect(html.match(/class="kw"/gu)).toHaveLength(2);
    const notes = card.keywordNotes!(text, [{ relation: "may_contain", evidence_text: "milk" }], checks);
    expect(notes[0]).toContain("cocoa butter is not milk fat");
    expect(notes[1]).toContain("may contain");
  });

  it("gives the catalogue a reason column from the decision row", () => {
    const cat = { skus: [{ gtin: G, name: "Test Bar", brand: "", markets: ["UK"], decisions: { UK: { status: "HOLD", actor: "clearshelf-agent", reason: "intake. auto HOLD (policy t): R1 H-0001-2026 (Class I, Terminated, reported 2026-09-09): recall of this GTIN within 24 months; lot codes not matched; R3 DQ english_label on product: 1 invalid record(s) for this GTIN (Zetaris DQ)" } }, pending: [], latest_runs: {} }] };
    const html = intake.renderCatalogue!(cat, "all");
    expect(html).toContain("Label not in English");
    expect(html).toContain('<span aria-hidden="true">R1</span>');
  });

  it("keeps intake rows that skip registration from claiming the registering stage, and gives queue positions", () => {
    const html = intake.renderProgress!([{ gtin: G, market: "UK", state: "running", stage: 1, seen: [1], submitted_at: 1 }]);
    expect(html).toContain("prog__step--skip");
    expect(html).toContain("already registered");
    expect(html).toContain("prog__step--now");
    const q = intake.renderProgress!([
      { gtin: G, market: "UK", state: "queued", submitted_at: 2 },
      { gtin: "0012345678912", market: "UK", state: "queued", submitted_at: 1 },
    ]);
    expect(q).toContain("<strong>1 of 2</strong> in the queue");
    expect(q).toContain("0 of 2</strong> finished");
  });

  it("removes a street address from display and says 0 of 0 when nothing is cleared", () => {
    expect(lib.noAddress!("DISTRIBUTED BY EXAMPLE FOODS, LLC. 1200 N. MAIN STREET, SPRINGFIELD, IL 62701 UPC 1")).toBe("DISTRIBUTED BY EXAMPLE FOODS, LLC. [address removed] UPC 1");
    expect(watch.renderRecheck!({ rows: [] }, 0)).toContain("<strong>0 of 0</strong>");
  });

  it("marks a sweep action that a later decision superseded, and folds its evidence into one button", () => {
    const s = { sweep_id: "w20261001T100000abcd", kind: "poll", window: {}, model: {}, notices: [], exact_matches: [], name_matches: [], recheck: { rows: [] }, gaps: [], actions: [{ gtin: G, market: "UK", status: "HOLD", rules: ["R1"], applied: true, decision_id: "rp-old", run_id: "w20261001T100000abcd", evidence_ids: [ev(1), ev(2)] }] };
    const html = watch.renderSweep!(s, [], { current: { [`${G}|UK`]: { decision_id: "d-new", status: "HOLD", decided_at: "2026-10-02T10:00:00+0800" } } });
    expect(html).toContain("Since superseded");
    expect(html).toContain("2 evidence records");
  });

  it("shows Zetaris's write-back DQ results on the recheck and after a signed write", () => {
    const html = watch.renderRecheck!({ rows: [], dq: [{ rule: "signed_clear", invalid: 0, invalid_decisions: [], sql: "SHOW DQ INVALID RECORD signed_clear TABLE x", elapsed_ms: 40, error: null }, { rule: "known_status", invalid: 1, invalid_decisions: ["d-odd"], sql: null, elapsed_ms: 30, error: null }] }, 1);
    expect(html).toContain("0 invalid records");
    expect(html).toContain("SHOW DQ INVALID RECORD signed_clear");
    expect(html).toMatch(/1 invalid<\/span>: <code>d-<wbr>odd/u);
    expect(watch.renderWritebackDq!(undefined)).toBe("");
    expect(card.signedClearLine!({ rule: "signed_clear", invalid: 0, row_invalid: false, sql: "SHOW DQ", error: null })).toContain("passes");
    expect(card.signedClearLine!({ rule: "signed_clear", invalid: 1, row_invalid: true, sql: null, error: null })).toContain("is flagged");
    expect(card.signedClearLine!(null)).toBe("");
  });

  it("says a sweep's decision was withdrawn, not superseded, when the current decision is older (a reset)", () => {
    const action = { gtin: G, market: "UK", status: "HOLD", rules: ["R1"], applied: true, visible_in_zetaris: true, decision_id: `rp-${G}-UK-20261023T114636-da74`, run_id: "w20261023T114500abcd", evidence_ids: [] };
    const s = { sweep_id: "w20261023T114500abcd", kind: "poll", window: {}, model: {}, notices: [], exact_matches: [], name_matches: [], recheck: { rows: [] }, gaps: [], actions: [action] };
    const older = watch.renderSweep!(s, [], { current: { [`${G}|UK`]: { decision_id: `d-${G}-UK-20261023T083032-3368`, status: "HOLD", decided_at: "2026-10-23T16:30:32+0800" } } });
    expect(older).toContain("No longer in the ops store");
    expect(older).toContain("yes</span> when written");
    expect(older).not.toContain("Since superseded");
    const newer = watch.renderSweep!(s, [], { current: { [`${G}|UK`]: { decision_id: `d-${G}-UK-20261023T130000-0001`, status: "BLOCK", decided_at: "2026-10-23T21:00:00+0800" } } });
    expect(newer).toContain("Since superseded");
    expect(newer).not.toContain("No longer in the ops store");
    expect(watch.idTime!(`d-${G}-UK-20261023T083032-3368`)).toBe("20261023T083032");
  });

  it("leads the why trace with at most five plain lines and folds the rest", () => {
    const trace = {
      lines: ["one", "two"],
      current: { decision_id: "d-1", status: "HOLD", actor: "clearshelf-agent", decided_at: "2026-10-01T10:00:00+0800" },
      zetaris: [{ decision_id: "d-1", status: "HOLD" }],
      citations: { prior_decisions: ev(20) },
      hmem: {
        decision: {
          status: "HOLD",
          actor: "clearshelf-policy",
          decidedAt: "2026-10-01T10:00:00+0800",
          runId: RUN,
          evidenceId: ev(7),
          state: "applied",
          firings: [
            { rule: "R1", effect: "HOLD", reason: "synthetic recall", evidenceIds: [ev(2)] },
            { rule: "R3", effect: "HOLD", reason: "DQ english_label on product: 1 invalid record(s)", evidenceIds: [ev(5)] },
            { rule: "R4", effect: "HOLD", reason: "unresolved contradiction (claim_not_supported): x", evidenceIds: [ev(4)] },
            { rule: "R0", effect: "HOLD", reason: "investigation incomplete: 3 unparsed fragment(s)", evidenceIds: [ev(3)] },
          ],
        },
        conflicts: [],
        invariants: [],
        ledger: [{ memoryId: "mem-3", entries: [{ memoryId: "mem-3", action: "read", actor: "clearshelf-agent", timestamp: 1 }, { memoryId: "mem-3", action: "read", actor: "clearshelf-agent", timestamp: 2 }] }],
      },
    };
    const lines = whyView.plainLines!(trace);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines[lines.length - 1].ev).toEqual([ev(20)]);
    const html = whyView.renderWhy!(trace);
    expect(html).toContain('<details class="why__more"><summary>Full trace');
    expect(html).toContain("Reads of these memories");
  });

  it("renders the evaluation report as escaped text with tables", () => {
    const html = evalView.renderReport!("# Report\n\n## 1. Scores\n\n| A | B |\n|---|---|\n| **1** | <script>x</script> |\n\n- item `code`");
    expect(html).toContain("<table");
    expect(html).toContain("<strong>1</strong>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<code>code</code>");
  });
});
