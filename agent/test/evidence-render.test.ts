// Render tests for the evidence drawer, the "why" trace and the telemetry footer and chart
// (ui/views/evidence.js, why.js, telemetry.js). Synthetic records only.

import { describe, expect, it } from "vitest";

type Fn = (...args: any[]) => any;
type Mod = Record<string, Fn>;
const load = async (p: string): Promise<Mod> => (await import(new URL(`../../ui/${p}`, import.meta.url).href)) as Mod;

const evidence = await load("views/evidence.js");
const why = await load("views/why.js");
const tele = await load("views/telemetry.js");

const RUN = "r20261001T100000abcd";
const XSS = `<script>alert("x")</script>`;

function record(over: Record<string, unknown> = {}) {
  return {
    id: `ev-${RUN}-04`,
    run_id: RUN,
    kind: "zetaris_sql",
    claim: `FDA H-0001-2026 reports undeclared milk ${XSS}`,
    template_id: "recalls_by_gtin",
    params: { gtin: "0012345678905" },
    sql: `SELECT f.reason FROM lightning.metastore.clearshelf.clearance_usl.fda_recall f WHERE f.reason = '${XSS}'`,
    sql_sha256: "81c2deadbeef",
    zetaris_object: "lightning.metastore.clearshelf.clearance_usl.fda_recall",
    zetaris_objects: ["lightning.metastore.clearshelf.clearance_usl.recall_product_link", "lightning.metastore.clearshelf.clearance_usl.fda_recall"],
    raw_objects: ["clearshelf_ops.recall_links", "clearshelf_fda.enforcement_undeclared"],
    source_url: "https://api.fda.gov/food/enforcement.json?search=reason_for_recall:undeclared",
    licence: "openFDA public domain / CC0; not endorsed by the FDA",
    queried_at: "2026-10-01T10:30:00+0800",
    source_cached_at: "2026-10-01T10:00:00+0800",
    sources: [{ object: "clearshelf_fda.enforcement_undeclared", url: "https://api.fda.gov/food/enforcement.json", licence: "openFDA public domain / CC0; not endorsed by the FDA", cached_at: "2026-10-01T10:00:00+0800" }],
    columns: ["recall_number", "reason"],
    rows: [["H-0001-2026", XSS]],
    row_count: 1,
    elapsed_ms: 412,
    cache_state: "hit",
    ...over,
  };
}

describe("evidence drawer", () => {
  it("shows every required field of a Zetaris record, with the SQL as the citation", () => {
    const html = evidence.renderEvidence!([record()]);
    for (const text of [
      `ev-${RUN}-04`,
      RUN,
      "Zetaris SQL",
      "Lightning SQL, the citation for this claim",
      "81c2deadbeef",
      "recalls_by_gtin",
      "gtin=0012345678905",
      "lightning.metastore.clearshelf.clearance_usl.fda_recall",
      "clearshelf_fda.enforcement_undeclared",
      "https://api.fda.gov/food/enforcement.json?search=reason_for_recall:undeclared",
      "openFDA public domain / CC0; not endorsed by the FDA",
      "2026-10-01T10:30:00+0800",
      "2026-10-01T10:00:00+0800",
      "source cached 30 minutes before the query",
      "hit",
      "412 ms",
      "1 of 1 row shown",
      "Copy SQL",
      "Open in Zetaris",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('rel="noreferrer"');
    expect(html).not.toContain("missing");
  });

  it("renders a missing required field as missing instead of hiding it", () => {
    const { sql_sha256: _s, licence: _l, ...rest } = record();
    const html = evidence.renderRecord!({ ...rest, cache_state: undefined });
    expect(html.match(/<span class="missing">missing<\/span>/gu)?.length).toBe(3);
  });

  it("escapes a <script> in a row value, the claim and the SQL", () => {
    const html = evidence.renderEvidence!([record()]);
    expect(html).not.toContain("<script>");
    expect(html.match(/&lt;script&gt;/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it("does not link a URL that is not http(s)", () => {
    const html = evidence.renderRecord!(record({ source_url: "javascript:alert(1)" }));
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("javascript:alert(1)");
  });

  it("says which DQ source a dq record came from", () => {
    expect(evidence.renderRecord!(record({ kind: "dq", dq_source: "zetaris_dq" }))).toContain("from Zetaris DQ");
    expect(evidence.renderRecord!(record({ kind: "dq", dq_source: "dq_equivalent_sql" }))).toContain("from DQ-equivalent SQL");
    expect(evidence.renderRecord!(record({ kind: "dq", dq_source: undefined }))).toMatch(/DQ source<\/dt><dd><span class="missing">missing/u);
  });

  it("calls an ops-table read live, and says so when a cache time was not recorded", () => {
    const ops = record({ raw_objects: ["clearshelf_ops.decisions"], source_cached_at: null });
    expect(evidence.freshnessLine!(ops)).toMatch(/^live read \(ops table\)/u);
    expect(evidence.renderRecord!(ops)).toContain("live read (ops table)");
    expect(evidence.freshnessLine!(record({ source_cached_at: null }))).toBe("cache time not recorded");
  });

  it("shows the model block of an extraction record with its measured label", () => {
    const html = evidence.renderRecord!({ id: `ev-${RUN}-06`, run_id: RUN, kind: "model_extraction", claim: "spans", queried_at: "2026-10-01T10:00:00+0800", model: { name: "stub-model", think: false, prompt_sha256: "abc", tokens_in: 1830, tokens_out: 212, attempts: 1, eval_ms: 1400, tokens_per_s: 151.4, label: "measured" }, derived_from: [`ev-${RUN}-04`] });
    for (const t of ["stub-model", "1,830", "212", "151.4 tok/s", "measured", `data-ev="ev-${RUN}-04"`]) expect(html).toContain(t);
    expect(evidence.renderRecord!({ id: `ev-${RUN}-07`, run_id: RUN, kind: "model_extraction", claim: "x", queried_at: "t" })).toContain("missing");
  });
});

describe("why trace", () => {
  const trace = {
    lines: [`HOLD (applied) for 0012345678905 in UK, evidence ev-${RUN}-16.`, "R1 → HOLD: synthetic recall"],
    current: { decision_id: "d-1", status: "HOLD", actor: "clearshelf-agent", decided_at: "2026-10-01T10:00:00+0800" },
    hmem: {
      decision: { status: "HOLD" },
      invariants: [],
      conflicts: [
        { id: "ac-1", allergen: "milk", a: "mem-1", b: "mem-2", polarityA: "contains", polarityB: "free_from", classA: "regulator", classB: "off_labels", detectedAt: "2026-10-01T02:00:05.000Z", score: { suggested: "mem-1", suggestedRule: "regulator_over_off_labels" }, resolution: { outcome: "keep_a", winner: "mem-1", rule: "regulator_over_off_labels", reason: `the notice outranks the tag ${XSS}`, by: "officer", at: "2026-10-01T03:00:00.000Z" } },
      ],
      ledger: [
        {
          memoryId: "mem-3",
          entries: [
            { memoryId: "mem-3", action: "read", actor: "clearshelf-agent", timestamp: Date.parse("2026-10-01T02:30:00.000Z") },
            { memoryId: "mem-3", action: "create", actor: "clearshelf-agent", timestamp: Date.parse("2026-10-01T02:00:10.000Z"), newState: { content: "Decision HOLD for GTIN 0012345678905", tags: ["kind:decision"], provenance: { refs: [`ev-${RUN}-16`] } } },
            { memoryId: "mem-3", action: "read", actor: "clearshelf-agent", timestamp: Date.parse("2026-10-01T02:40:00.000Z") },
          ],
        },
        { memoryId: "mem-1", entries: [{ memoryId: "mem-1", action: "conflict_detected", actor: "clearshelf-agent", timestamp: Date.parse("2026-10-01T02:00:05.000Z") }] },
        { memoryId: "mem-9", entries: [{ memoryId: "mem-9", action: "create", actor: "officer", timestamp: Date.parse("2026-10-01T01:00:00.000Z"), newState: { content: "officer ruling: synthetic", tags: [] } }] },
      ],
    },
  };

  it("lists the server's lines first, then one ledger in time order that names the officer", () => {
    const html = why.renderWhy!(trace);
    expect(html.indexOf("Full trace, as the server wrote it")).toBeGreaterThan(-1);
    expect(html.indexOf("Full trace, as the server wrote it")).toBeLessThan(html.indexOf("Ledger, in time order"));
    expect(html).toContain(`data-ev="ev-${RUN}-16"`);
    const ev = why.ledgerEvents!(trace.hmem);
    expect(ev.map((e: { action: string }) => e.action)).toEqual(["create", "conflict detected", "decision recorded", "read ×2", "conflict resolved"]);
    const times = ev.map((e: { t: number }) => e.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(ev[0].actor).toBe("officer");
    expect(ev[4].actor).toBe("officer");
    expect(ev[4].text).toContain("rule regulator_over_off_labels");
    expect(html).toContain('<strong class="actor actor--officer">officer</strong>');
    expect(html).not.toContain("<script>");
  });

  it("titles the trace by the current status", () => {
    expect(why.whyTitle!(trace)).toBe("Why was this held?");
    expect(why.whyTitle!({ current: { status: "BLOCK" } })).toBe("Why was this blocked?");
    expect(why.whyTitle!({ current: { status: "CLEAR" } })).toBe("Why this decision?");
  });
});

describe("telemetry footer and chart", () => {
  it("prints not measured for absent VRAM, cold vs warm and speed, never 0", () => {
    const html = tele.renderFooter!({ model: "stub", model_host: "http://127.0.0.1:11434", cloud_model_calls: 0, refused_non_local_model_hosts: 0, planner_tokens_per_s: null, latest_loop: null, vram: null, cold_warm: null });
    expect(html.match(/not measured/gu)?.length).toBe(4);
    expect(html).toContain("Cloud model calls");
  });

  it("keeps the labels on measured and estimated figures", () => {
    const html = tele.renderFooter!({
      model: "stub",
      model_host: "http://127.0.0.1:11434",
      cloud_model_calls: 0,
      refused_non_local_model_hosts: 2,
      planner_tokens_per_s: { value: 151.2, label: "measured", runs: 5 },
      latest_loop: { chart: [{ chunk: 1, markovian_prompt_tokens_measured: 1200, naive_prompt_tokens_estimated: 1100 }, { chunk: 2, markovian_prompt_tokens_measured: 1300, naive_prompt_tokens_estimated: 1900 }] },
      vram: { whole_gpu_mib_peak: 6743, ollama_ps: [{ size_vram_mib: 2881 }], label: "measured (synthetic)" },
      cold_warm: { gtin: "0012345678905", market: "US", label: "measured", runs: [{ mode: "cold", chunks: 5, wall_ms: 61078, planner_tokens: { in: 14597, out: 4751 }, tool_model_tokens: { in: 2210, out: 1448 } }, { mode: "warm", chunks: 5, wall_ms: 48065, planner_tokens: { in: 14415, out: 4161 }, tool_model_tokens: { in: 721, out: 83 }, extraction_reused: true }] },
    });
    for (const t of ["151 tok/s", "6,743 MiB GPU", "model 2,881 MiB", "2 non-local refused", "estimated (chars/4)"]) expect(html).toContain(t);
    // All four cold-versus-warm figures, including the ones that did not improve.
    for (const t of ["chunks</span> 5 → 5", "planner</span> 19,348 → 18,576", "tool</span> 3,658 → 804", "time</span> 61.1 s → 48.1 s"]) expect(html).toContain(t);
    expect(html).toContain("Planner tokens 14,597 in / 4,751 out → 14,415 in / 4,161 out");
    expect(html.match(/>measured</gu)?.length).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain("not measured");
  });

  it("draws both series with their labels, and says so when there is no data", () => {
    const svg = tele.renderTokenChart!([
      { chunk: 1, markovian_prompt_tokens_measured: 1245, naive_prompt_tokens_estimated: 1086 },
      { chunk: 2, markovian_prompt_tokens_measured: 1396, naive_prompt_tokens_estimated: 1693 },
      { chunk: 3, markovian_prompt_tokens_measured: 1585, naive_prompt_tokens_estimated: 2276 },
    ]);
    expect(svg).toContain("Markovian prompt per chunk (measured)");
    expect(svg).toContain("full-history baseline (estimated, chars/4)");
    expect(svg).toContain('class="chart__m"');
    expect(svg).toContain('class="chart__naive"');
    for (const v of ["1,245", "1,396", "1,585", "2,276"]) expect(svg).toContain(v);
    expect(svg).toMatch(/role="img" aria-label="Prompt tokens per chunk/u);
    expect(tele.renderTokenChart!([])).toContain("no chart data");
    expect(tele.renderTokenChart!(undefined)).toContain("no chart data");
  });
});
