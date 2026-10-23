import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContractVerifier, officerApproval } from "../src/contract/scout.ts";
import { applyAutomatic, executeDecision, signApproval } from "../src/ops/actions.ts";
import { ApprovalQueue } from "../src/ops/queue.ts";
import { ContractRefused, decisionContractParams, OpsError, OpsStore, sha256 } from "../src/ops/store.ts";
import { VECTOR_SECRET } from "./fixtures/contract-vector.ts";
import { fakeGateway, type FakeWorld } from "./helpers/fakeZetaris.ts";

// Synthetic GTINs and rows only.
const A = "0012345678905";
const B = "0012345678912";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "cs-ops-"));
  const opsDir = join(root, "ops");
  const verifier = new ContractVerifier(VECTOR_SECRET, "test", join(root, "contracts"));
  const ops = new OpsStore({ dir: opsDir, verifier });
  const queue = new ApprovalQueue(join(root, "approvals"));
  const world: FakeWorld = { opsDir, products: [], fda: [], fsa: [], calls: [] };
  return { root, opsDir, verifier, ops, queue, world, gateway: fakeGateway(world) };
}

function lowContract(verifier: ContractVerifier, gtin: string, market: "UK" | "US", status: "HOLD" | "BLOCK") {
  const { action, params } = decisionContractParams({ gtin, market, status });
  return verifier.issue({ action, parameters: params, user: "clearshelf-agent", surface: "clearshelf-agent" });
}

const fileText = (p: string) => readFileSync(p, "utf8");

describe("OpsStore decisions", () => {
  it("appends a HOLD under a low-risk contract, keeps the sentinel first and every value a string", async () => {
    const { ops, verifier } = setup();
    const c = lowContract(verifier, A, "UK", "HOLD");
    const r = await ops.writeDecision({ gtin: A, market: "UK", status: "HOLD", reason: "R3 has_ingredients", actor: "clearshelf-agent", contract: c });
    const doc = JSON.parse(fileText(ops.path("decisions"))) as { data: Record<string, unknown>[] };
    expect(doc.data[0]!.decision_id).toBe("__schema__");
    expect(doc.data).toHaveLength(2);
    expect(Object.values(doc.data[1]!).every((v) => typeof v === "string")).toBe(true);
    expect(r.row).toMatchObject({ gtin: A, market: "UK", status: "HOLD", statement: "", contract_id: c.contractId });
    expect(r.row.decision_id).toMatch(/^d-0012345678905-UK-\d{8}T\d{6}-[0-9a-f]{4}$/u);
    expect(r.row.decided_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/u);
    expect(r.row.decided_date).toBe(r.row.decided_at.slice(0, 10));
    expect(verifier.isUsed(c.contractId)).toBe(true);
  });

  it("labels replay rows: rp- id, decided_date at the as-of date, banner in the reason", async () => {
    const { ops, verifier } = setup();
    const r = await ops.writeDecision({
      gtin: A,
      market: "UK",
      status: "HOLD",
      reason: "R3",
      actor: "clearshelf-agent (replay)",
      contract: lowContract(verifier, A, "UK", "HOLD"),
      replay: { asOf: "2026-10-10", banner: "Replay as of 10 Oct 2026" },
    });
    expect(r.row.decision_id.startsWith("rp-")).toBe(true);
    expect(r.row.decided_date).toBe("2026-10-10");
    expect(r.row.reason.startsWith("REPLAY AS OF 10 OCT 2026 | ")).toBe(true);
  });

  it("refuses a RELEASE or CLEAR without a valid contract and writes nothing (E10)", async () => {
    const { ops, verifier, root } = setup();
    await ops.writeDecision({ gtin: A, market: "UK", status: "HOLD", reason: "seed", actor: "a", contract: lowContract(verifier, A, "UK", "HOLD") });
    const before = fileText(ops.path("decisions"));
    await expect(ops.writeDecision({ gtin: A, market: "UK", status: "CLEAR", action: "RELEASE", reason: "x", actor: "officer", contract: undefined })).rejects.toMatchObject({ status: 403, code: "missing" });
    // A low-risk HOLD contract cannot carry a CLEAR.
    const hold = lowContract(verifier, A, "UK", "HOLD");
    await expect(ops.writeDecision({ gtin: A, market: "UK", status: "CLEAR", reason: "x", actor: "officer", contract: hold })).rejects.toBeInstanceOf(ContractRefused);
    expect(fileText(ops.path("decisions"))).toBe(before);
    const log = fileText(join(root, "contracts", "verifier-test.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
    expect(log.filter((e) => !e.ok).map((e) => e.code)).toEqual(["missing", "wrong_action"]);
  });

  it("binds a statement to its contract: another statement is a parameter mismatch", async () => {
    const { ops, verifier } = setup();
    const { action, params } = decisionContractParams({ gtin: A, market: "UK", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk." });
    const c = verifier.issue({ action, parameters: params, user: "officer", surface: "clearshelf-ui", approvals: [officerApproval("label checked")] });
    await expect(ops.writeDecision({ gtin: A, market: "UK", status: "CLEAR_WITH_STATEMENT", statement: "No allergens.", reason: "x", actor: "officer", contract: c })).rejects.toMatchObject({ code: "parameter_mismatch" });
    const ok = await ops.writeDecision({ gtin: A, market: "UK", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk.", reason: "x", actor: "officer", contract: c });
    expect(ok.row.statement).toBe("May contain: Milk.");
    expect(params.statement_sha256).toBe(sha256("May contain: Milk."));
    await expect(ops.writeDecision({ gtin: A, market: "UK", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk.", reason: "x", actor: "officer", contract: c })).rejects.toMatchObject({ code: "replayed" });
  });

  it("serialises concurrent writers and keeps the file valid", async () => {
    const { ops, verifier } = setup();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => ops.writeDecision({ gtin: i % 2 ? A : B, market: "UK", status: "HOLD", reason: `n${i}`, actor: "a", contract: lowContract(verifier, i % 2 ? A : B, "UK", "HOLD") })),
    );
    expect(ops.decisions()).toHaveLength(6);
    expect(ops.current().size).toBe(2);
  });

  it("refuses values wider than the USL column", async () => {
    const { ops, verifier } = setup();
    await expect(ops.writeDecision({ gtin: A, market: "UK", status: "HOLD", reason: "r", actor: "x".repeat(61), contract: lowContract(verifier, A, "UK", "HOLD") })).rejects.toBeInstanceOf(OpsError);
  });
});

describe("OpsStore links and extractions", () => {
  it("adds links once, never replaces an existing row, and validates the key", async () => {
    const { ops } = setup();
    const l = { link_key: `H-0001-2026|${A}`, recall_number: "H-0001-2026", gtin: A, raw_code: "012345678905", transform: "upc12_pad13", extracted_by: "watch-scan" };
    expect((await ops.addLinks([l])).added).toHaveLength(1);
    expect((await ops.addLinks([{ ...l, extracted_by: "nemotron" }])).skipped).toEqual([l.link_key]);
    expect(ops.rows("recall_links")).toEqual([l]);
    await expect(ops.addLinks([{ ...l, link_key: "x" }])).rejects.toBeInstanceOf(OpsError);
    await expect(ops.addLinks([{ ...l, recall_number: "Z-0001-2026", link_key: `Z-0001-2026|${A}` }])).rejects.toBeInstanceOf(OpsError);
  });

  it("replaces one GTIN's extraction rows and leaves the others", async () => {
    const { ops } = setup();
    const row = (g: string, k: string) => ({ extracted_key: k, gtin: g, market_code: "UK:milk", relation: "contains", evidence_text: "milk", verifier: "agree", run_id: "r1" });
    await ops.replaceExtractions(A, [row(A, "a1"), row(A, "a2")]);
    await ops.replaceExtractions(B, [row(B, "b1")]);
    const r = await ops.replaceExtractions(A, [row(A, "a3")]);
    expect(r).toMatchObject({ removed: 2, added: 1 });
    expect(ops.rows("extractions").map((x) => x.extracted_key).sort()).toEqual(["a3", "b1"]);
  });
});

describe("actions", () => {
  it("applies a HOLD automatically and proves the row is visible through the gateway", async () => {
    const { ops, gateway } = setup();
    const a = await applyAutomatic(ops, gateway, { gtin: A, market: "UK", status: "HOLD", reason: "R1", runId: "r-test" });
    expect(a.visibility.visible).toBe(true);
    expect(a.contract.risk.level).toBe("low");
    expect(a.contract.risk.flags).toContain("auto");
  });

  it("signs only a pending proposal with the same status and executes it once", async () => {
    const { ops, gateway, queue } = setup();
    expect(() => signApproval(ops, queue, { gtin: A, market: "UK", action: "CLEAR", status: "CLEAR", statement: null, reason: "ok", officer: "officer" })).toThrow(/no pending CLEAR proposal/);
    queue.add({ kind: "proposal", gtin: A, market: "UK", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk.", summary: "s", reasons: [], evidence_ids: [], run_id: "r1", source: "clear", replay: null });
    expect(() => signApproval(ops, queue, { gtin: A, market: "UK", action: "CLEAR", status: "CLEAR", statement: null, reason: "ok", officer: "officer" })).toThrow(/never relaxes|no pending CLEAR/);
    expect(() => signApproval(ops, queue, { gtin: A, market: "UK", action: "CLEAR_WITH_STATEMENT", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk.", reason: " ", officer: "officer" })).toThrow(/reason/);
    expect(() => signApproval(ops, queue, { gtin: A, market: "UK", action: "CLEAR_WITH_STATEMENT", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk.", reason: "ok", officer: "mallory" })).toThrow(/approver/);
    expect(() =>
      signApproval(ops, queue, { gtin: A, market: "UK", action: "CLEAR_WITH_STATEMENT", status: "CLEAR_WITH_STATEMENT", statement: "Contains: Milk (to confirm).", reason: "ok", officer: "officer" }),
    ).toThrow(/to confirm/);
    const { contract } = signApproval(ops, queue, { gtin: A, market: "UK", action: "CLEAR_WITH_STATEMENT", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk.", reason: "label checked", officer: "officer" });
    const ex = await executeDecision(ops, gateway, queue, { gtin: A, market: "UK", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk.", reason: "label checked", contract });
    expect(ex.visibility.visible).toBe(true);
    expect(ex.row.actor).toBe("officer");
    expect(queue.all()[0]!.state).toBe("executed");
    await expect(executeDecision(ops, gateway, queue, { gtin: A, market: "UK", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk.", reason: "again", contract })).rejects.toMatchObject({ status: 403, code: "replayed" });
  });

  it("refuses to execute a signed clearance while an exact-GTIN recall is open", async () => {
    const { ops, gateway, queue, world } = setup();
    world.fda.push({ recall_number: "H-0002-2026", report_date: "2026-10-01", classification: "Class I", status: "Ongoing", firm: "Example", distribution: "Nationwide", product_description: "Bar", reason: "Undeclared milk", code_info: "" });
    await ops.addLinks([{ link_key: `H-0002-2026|${A}`, recall_number: "H-0002-2026", gtin: A, raw_code: "", transform: "", extracted_by: "watch-scan" }]);
    queue.add({ kind: "proposal", gtin: A, market: "UK", status: "CLEAR", statement: null, summary: "s", reasons: [], evidence_ids: [], run_id: "r1", source: "clear", replay: null });
    const { contract } = signApproval(ops, queue, { gtin: A, market: "UK", action: "CLEAR", status: "CLEAR", statement: null, reason: "ok", officer: "officer" });
    await expect(executeDecision(ops, gateway, queue, { gtin: A, market: "UK", status: "CLEAR", statement: null, reason: "ok", contract })).rejects.toMatchObject({ status: 409, code: "open_recall" });
    expect(ops.decisions()).toHaveLength(0);
  });

  it("allows a RELEASE of a held listing only with a signed contract", async () => {
    const { ops, gateway, queue } = setup();
    await applyAutomatic(ops, gateway, { gtin: A, market: "UK", status: "HOLD", reason: "R1 terminated recall", runId: "r" });
    const { contract } = signApproval(ops, queue, { gtin: A, market: "UK", action: "RELEASE", status: "CLEAR", statement: null, reason: "lot codes checked: none in stock", officer: "officer" });
    const ex = await executeDecision(ops, gateway, queue, { gtin: A, market: "UK", status: "CLEAR", statement: null, action: "RELEASE", reason: "lot codes checked", contract });
    expect(ex.row.status).toBe("CLEAR");
    expect(ex.row.reason.startsWith("RELEASE: ")).toBe(true);
    expect(() => signApproval(ops, queue, { gtin: A, market: "UK", action: "RELEASE", status: "CLEAR", statement: null, reason: "x", officer: "officer" })).toThrow(/held listing/);
  });
});

describe("a later HOLD or BLOCK outranks a pending clearance", () => {
  const proposal = (over?: string) => ({ kind: "proposal" as const, gtin: A, market: "UK" as const, status: "CLEAR_WITH_STATEMENT" as const, statement: "May contain: Milk.", summary: "s", reasons: ["R5"], evidence_ids: [], run_id: "r20261023T000000aaaa", source: "clear" as const, replay: null, ...(over !== undefined ? { over_decision: over } : {}) });
  const sign = (ops: OpsStore, queue: ApprovalQueue) => signApproval(ops, queue, { gtin: A, market: "UK", action: "CLEAR_WITH_STATEMENT", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk.", reason: "looks fine", officer: "officer" });
  const execute = (ops: OpsStore, gateway: ReturnType<typeof fakeGateway>, queue: ApprovalQueue, contract: unknown) =>
    executeDecision(ops, gateway, queue, { gtin: A, market: "UK", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk.", reason: "looks fine", contract });

  it("supersedes the proposal when an automatic HOLD is written, so it can no longer be signed (review probe)", async () => {
    const { ops, gateway, queue } = setup();
    const q = queue.add(proposal());
    const held = await applyAutomatic(ops, gateway, { gtin: A, market: "UK", status: "HOLD", reason: "R4 queued allergen conflict (later run)", runId: "r20261023T000100bbbb" }, queue);
    expect(held.superseded).toEqual([q.id]);
    expect(queue.get(q.id)).toMatchObject({ state: "superseded", resolution: { decision_id: held.row.decision_id } });
    expect(() => sign(ops, queue)).toThrow(expect.objectContaining({ status: 409, code: "no_proposal" }));
    expect(ops.current().get(`${A}|UK`)?.status).toBe("HOLD");
  });

  it("refuses at execution a clearance signed before a later HOLD, superseded or not (409 stale_proposal, nothing written)", async () => {
    for (const viaQueue of [false, true]) {
      const { ops, gateway, queue } = setup();
      queue.add(proposal(""));
      const { contract } = sign(ops, queue);
      // A writer that does not know the queue (viaQueue false) and one that supersedes (true).
      const held = await applyAutomatic(ops, gateway, { gtin: A, market: "UK", status: "HOLD", reason: "R1 new recall", runId: "r20261023T000200cccc" }, viaQueue ? queue : null);
      await expect(execute(ops, gateway, queue, contract)).rejects.toMatchObject({ status: 409, code: "stale_proposal" });
      expect(ops.decisions().map((d) => d.decision_id)).toEqual([held.row.decision_id]);
      expect(ops.current().get(`${A}|UK`)?.status).toBe("HOLD");
    }
  });

  it("refuses to sign a proposal older than the current HOLD when the HOLD writer did not supersede it", async () => {
    const { ops, gateway, queue } = setup();
    queue.add(proposal(""));
    await applyAutomatic(ops, gateway, { gtin: A, market: "UK", status: "BLOCK", reason: "R1 ongoing recall", runId: "r20261023T000300dddd" });
    expect(() => sign(ops, queue)).toThrow(expect.objectContaining({ status: 409, code: "stale_proposal" }));
  });

  it("still lets the officer sign a clearance proposed after the hold it would lift", async () => {
    const { ops, gateway, queue } = setup();
    const h1 = await applyAutomatic(ops, gateway, { gtin: A, market: "UK", status: "HOLD", reason: "R4 conflict, since resolved", runId: "r20261023T000400eeee" }, queue);
    queue.add(proposal(h1.row.decision_id));
    const { contract } = sign(ops, queue);
    expect(contract.toolPlan[0]!.input).toMatchObject({ over_decision: h1.row.decision_id });
    const ex = await execute(ops, gateway, queue, contract);
    expect(ex.row.status).toBe("CLEAR_WITH_STATEMENT");
    expect(queue.all().find((i) => i.kind === "proposal")!.state).toBe("executed");
  });

  it("refuses a RELEASE signed before a newer HOLD (409 stale_release)", async () => {
    const { ops, gateway, queue } = setup();
    await applyAutomatic(ops, gateway, { gtin: A, market: "UK", status: "HOLD", reason: "R1 terminated recall", runId: "r" });
    const { contract } = signApproval(ops, queue, { gtin: A, market: "UK", action: "RELEASE", status: "CLEAR", statement: null, reason: "lot codes checked", officer: "officer" });
    await applyAutomatic(ops, gateway, { gtin: A, market: "UK", status: "HOLD", reason: "R4 new conflict", runId: "r2" });
    await expect(executeDecision(ops, gateway, queue, { gtin: A, market: "UK", status: "CLEAR", statement: null, action: "RELEASE", reason: "lot codes checked", contract })).rejects.toMatchObject({ status: 409, code: "stale_release" });
  });
});
