import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContractVerifier } from "../src/contract/scout.ts";
import { ApprovalQueue } from "../src/ops/queue.ts";
import { OpsStore } from "../src/ops/store.ts";
import type { ClearResult, PipelineDeps } from "../src/pipeline.ts";
import type { Decision, Market } from "../src/policy/decide.ts";
import { createServer, EventBus, type ClearShelfServer } from "../src/server.ts";
import { RecallWatch, WatchStateStore, type Catalogue } from "../src/watch/recallWatch.ts";
import { VECTOR_SECRET } from "./fixtures/contract-vector.ts";
import { fakeGateway, stubModel, type FakeWorld } from "./helpers/fakeZetaris.ts";

// Synthetic SKUs and rows only.
const A = "0012345678905";
const B = "0012345678912";
const CATALOGUE: Catalogue = {
  source: "test",
  replayPicks: [],
  skus: [
    { gtin: A, markets: ["UK"], name: "Dark Bar", brand: "Example", brand_token: "example", scenarios: [] },
    { gtin: B, markets: ["UK"], name: "Seed Bar", brand: "Seedco", brand_token: "seedco", scenarios: [] },
  ],
};

let app: ClearShelfServer | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

function fakeClear(statusFor: Record<string, Decision>) {
  return async (gtin: string, market: Market, deps: PipelineDeps, asOf = "2026-10-23"): Promise<ClearResult> => {
    const status = statusFor[gtin] ?? "HOLD";
    deps.evidence.add({ kind: "policy", claim: `synthetic decision ${status}`, derived_from: [] });
    return {
      run_id: deps.evidence.runId,
      gtin,
      market,
      as_of: asOf,
      decision: { status, firings: [{ rule: status === "HOLD" ? "R3" : "R5", effect: status === "HOLD" ? "HOLD" : status, reason: "synthetic", evidenceIds: [] }], review: [], notes: [], autoExecutable: status === "HOLD", pendingSignature: status !== "HOLD", policyVersion: "test" },
      statement: status === "CLEAR_WITH_STATEMENT" ? { text: "May contain: Milk." } : null,
      evidence_ids: deps.evidence.all().map((e) => e.id),
      card: [],
      notices: [],
      extraction: { model: null, reused: false },
    } as unknown as ClearResult;
  };
}

async function start(statusFor: Record<string, Decision> = { [A]: "CLEAR_WITH_STATEMENT", [B]: "HOLD" }) {
  const root = mkdtempSync(join(tmpdir(), "cs-server-"));
  const w: FakeWorld = { opsDir: join(root, "ops"), products: [], fda: [], fsa: [], calls: [] };
  const gateway = fakeGateway(w);
  const verifier = new ContractVerifier(VECTOR_SECRET, "agent-ops", join(root, "contracts"));
  const ops = new OpsStore({ dir: w.opsDir, verifier });
  const queue = new ApprovalQueue(join(root, "approvals"));
  const bus = new EventBus();
  const ollama = stubModel();
  const watch = new RecallWatch({ gateway, ollama, ops, queue, catalogue: CATALOGUE, stateStore: new WatchStateStore(join(root, "watch")), sweepDir: null, evidenceDir: null, emit: (t, d) => bus.publish(t, d), today: () => "2026-10-23" });
  const uiDir = join(root, "ui");
  mkdirSync(uiDir);
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(root, "secret.txt"), "not served");
  app = createServer({ gateway, ollama, ops, queue, watch, catalogue: CATALOGUE, bus, uiDir, runsDir: join(root, "runs"), evidenceDir: join(root, "evidence"), sweepDir: null, clear: fakeClear(statusFor) });
  const port = await app.listen(0);
  return { root, w, ops, queue, port, base: `http://127.0.0.1:${port}`, verifierLog: join(root, "contracts", "verifier-agent-ops.jsonl") };
}

async function call(base: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function waitJob(base: string, id: string) {
  for (let i = 0; i < 100; i++) {
    const j = await call(base, `/api/jobs/${id}`);
    if (j.body.state === "done" || j.body.state === "failed") return j.body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("job did not finish");
}

/** Raw request with a chosen Host header (fetch does not allow overriding it). */
function rawGet(port: number, path: string, host: string): Promise<number> {
  return new Promise((ok, fail) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    req.on("error", fail);
    req.end();
  });
}

describe("server: E10 and the signed-approval path", () => {
  it("refuses RELEASE and CLEAR without a valid contract: 403, logged, nothing written", async () => {
    const { base, ops, verifierLog } = await start();
    const r1 = await call(base, "/api/execute", { gtin: A, market: "UK", status: "CLEAR", action: "RELEASE", reason: "no contract" });
    expect(r1.status).toBe(403);
    expect(r1.body.code).toBe("missing");
    const r2 = await call(base, "/api/decisions", { gtin: A, market: "UK", status: "RELEASE", reason: "no contract" });
    expect(r2.status).toBe(403);
    const r3 = await call(base, "/api/execute", { gtin: A, market: "UK", status: "CLEAR", reason: "forged", contract: { contractId: "c-x", signature: "0".repeat(64) } });
    expect(r3.status).toBe(403);
    expect(r3.body.code).toBe("malformed");
    expect(ops.decisions()).toHaveLength(0);
    const log = readFileSync(verifierLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.map((e) => [e.action, e.ok, e.code])).toEqual([
      ["RELEASE", false, "missing"],
      ["RELEASE", false, "missing"],
      ["CLEAR", false, "malformed"],
    ]);
  });

  it("clear -> proposal -> officer signs -> execute writes the row, visible in Zetaris; replay refused", async () => {
    const { base, ops } = await start();
    const job = await call(base, "/api/clear", { gtin: A, market: "UK" });
    expect(job.status).toBe(202);
    const done = await waitJob(base, job.body.job_id);
    expect(done.result).toMatchObject({ status: "CLEAR_WITH_STATEMENT", applied: false });
    const q = await call(base, "/api/approvals?state=pending");
    expect(q.body.items).toHaveLength(1);
    const signed = await call(base, "/api/approvals/sign", { gtin: A, market: "UK", action: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk.", reason: "label photo matches", officer: "officer" });
    expect(signed.status).toBe(200);
    const contract = signed.body.contract;
    expect(contract.risk).toMatchObject({ level: "high" });
    const ex = await call(base, "/api/execute", { gtin: A, market: "UK", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk.", reason: "label photo matches", contract });
    expect(ex.status).toBe(200);
    expect(ex.body.visible_in_zetaris).toBe(true);
    // Zetaris re-checks the signed row with its own signed_clear DQ rule after the write.
    expect(ex.body.signed_clear_dq).toMatchObject({ rule: "signed_clear", invalid: 0, row_invalid: false, error: null });
    expect(ex.body.signed_clear_dq.sql).toContain("dq_invalid_signed_clear");
    expect(ops.decisions()[0]).toMatchObject({ status: "CLEAR_WITH_STATEMENT", actor: "officer", contract_id: contract.contractId });
    const again = await call(base, "/api/execute", { gtin: A, market: "UK", status: "CLEAR_WITH_STATEMENT", statement: "May contain: Milk.", reason: "again", contract });
    expect(again.status).toBe(403);
    expect(again.body.code).toBe("replayed");
    const tampered = await call(base, "/api/execute", { gtin: A, market: "UK", status: "CLEAR_WITH_STATEMENT", statement: "No allergens.", reason: "edited after signing", contract });
    expect(tampered.status).toBe(403);
    expect(ops.decisions()).toHaveLength(1);
  });

  it("applies a HOLD at intake automatically and serves the run and its evidence", async () => {
    const { base, ops } = await start();
    const job = await call(base, "/api/clear", { gtin: B, market: "UK" });
    const done = await waitJob(base, job.body.job_id);
    expect(done.result).toMatchObject({ status: "HOLD", applied: true, visible_in_zetaris: true });
    expect(ops.current().get(`${B}|UK`)?.status).toBe("HOLD");
    const run = await call(base, `/api/runs/${done.result.run_id}`);
    expect(run.body.gtin).toBe(B);
    const ev = await call(base, `/api/evidence/${done.result.run_id}`);
    expect(ev.body.records).toHaveLength(1);
    const sku = await call(base, `/api/sku/${B}`);
    expect(sku.body.markets.UK.decision.status).toBe("HOLD");
    // The run is saved for the card, labelled with where it came from and what was done.
    expect(sku.body.markets.UK.run.run_id).toBe(done.result.run_id);
    expect(sku.body.markets.UK.run.saved).toMatchObject({ source: "server", applied: true, decision_id: done.result.decision_id });
    const cat = await call(base, "/api/catalogue");
    expect(cat.body.skus.find((s: any) => s.gtin === B).decisions.UK.status).toBe("HOLD");
    expect(cat.body.skus.find((s: any) => s.gtin === B).latest_runs.UK).toBe(done.result.run_id);
  });

  it("the recheck runs Zetaris's write-back DQ rules: a clearance row without a contract is flagged", async () => {
    const { base, w } = await start();
    await waitJob(base, (await call(base, "/api/clear", { gtin: B, market: "UK" })).body.job_id);
    const clean = await call(base, "/api/recheck");
    expect(clean.status).toBe(200);
    expect(clean.body.dq.map((d: any) => [d.rule, d.invalid, d.error])).toEqual([
      ["signed_clear", 0, null],
      ["known_status", 0, null],
    ]);
    // A row written around the server (no contract), as a tampered ops file would hold it.
    const file = join(w.opsDir, "decisions.json");
    const doc = JSON.parse(readFileSync(file, "utf8")) as { data: Record<string, string>[] };
    doc.data.push({ decision_id: "d-forged", gtin: A, market: "UK", status: "CLEAR", statement: "", decided_at: "2026-10-23T10:00:00+0800", decided_date: "2026-10-23", actor: "officer", contract_id: "", reason: "forged" });
    doc.data.push({ decision_id: "d-odd", gtin: B, market: "UK", status: "RELEASE", statement: "", decided_at: "2026-10-23T10:00:01+0800", decided_date: "2026-10-23", actor: "officer", contract_id: "c-1", reason: "odd" });
    writeFileSync(file, JSON.stringify(doc), "utf8");
    const flagged = await call(base, "/api/recheck");
    expect(flagged.body.dq.find((d: any) => d.rule === "signed_clear")).toMatchObject({ invalid: 1, invalid_decisions: ["d-forged"] });
    expect(flagged.body.dq.find((d: any) => d.rule === "known_status")).toMatchObject({ invalid: 1, invalid_decisions: ["d-odd"] });
  });

  it("schedules polls only while the watch is live, one at a time", async () => {
    const { base } = await start();
    expect(app!.schedulePoll()).toBeNull();
    expect((await call(base, "/api/watch/live", {})).status).toBe(200);
    const job = app!.schedulePoll();
    expect(job).toMatchObject({ kind: "watch.poll", input: { scheduled: true } });
    expect(app!.schedulePoll()).toBeNull();
    const done = await waitJob(base, job!.id);
    expect(done.state).toBe("done");
  });

  it("accepts a UPC-A, EAN-8 or GTIN-14 at intake and clears it as its GTIN-13", async () => {
    const { base } = await start();
    const upc = await call(base, "/api/clear", { gtin: A.slice(1), market: "UK" });
    expect(upc.status).toBe(202);
    expect(upc.body).toMatchObject({ gtin: A, normalised_from: A.slice(1) });
    const done = await waitJob(base, upc.body.job_id);
    expect(done.result).toMatchObject({ gtin: A, market: "UK" });
    const g14 = await call(base, "/api/clear", { gtin: `0${A}`, market: "UK" });
    expect(g14.body).toMatchObject({ gtin: A, normalised_from: `0${A}` });
    await waitJob(base, g14.body.job_id);
    const plain = await call(base, "/api/clear", { gtin: A, market: "UK" });
    expect(plain.body.gtin).toBe(A);
    expect(plain.body.normalised_from).toBeUndefined();
    await waitJob(base, plain.body.job_id);
    const caseCode = await call(base, "/api/clear", { gtin: `1${A}`, market: "UK" });
    expect(caseCode.status).toBe(400);
    expect(caseCode.body.code).toBe("bad_gtin");
    const badUpc = await call(base, "/api/clear", { gtin: "012345678906", market: "UK" });
    expect(badUpc.status).toBe(400);
  });

  it("rejecting a proposal holds the listing with the officer's reason", async () => {
    const { base, ops } = await start();
    await waitJob(base, (await call(base, "/api/clear", { gtin: A, market: "UK" })).body.job_id);
    const id = (await call(base, "/api/approvals?state=pending")).body.items[0].id;
    const r = await call(base, "/api/approvals/reject", { queue_id: id, reason: "supplier spec missing", officer: "officer" });
    expect(r.status).toBe(200);
    expect(ops.current().get(`${A}|UK`)).toMatchObject({ status: "HOLD", actor: "officer" });
  });
});

describe("server: transport safety", () => {
  it("answers only to its own Host and refuses foreign origins and non-JSON writes", async () => {
    const { base, port } = await start();
    expect(await rawGet(port, "/api/health", "evil.example")).toBe(421);
    expect(await rawGet(port, "/api/health", `127.0.0.1:${port}`)).toBe(200);
    const cross = await call(base, "/api/clear", { gtin: A, market: "UK" }, { origin: "http://evil.example" });
    expect(cross.status).toBe(403);
    const form = await fetch(`${base}/api/clear`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(form.status).toBe(415);
    const bad = await call(base, "/api/clear", { gtin: "0012345678906", market: "UK" });
    expect(bad.status).toBe(400);
  });

  it("serves the UI directory and nothing outside it", async () => {
    const { base, port } = await start();
    const idx = await fetch(`${base}/`);
    expect(idx.status).toBe(200);
    expect(await idx.text()).toContain("<title>t</title>");
    expect(await rawGet(port, "/..%2fsecret.txt", `127.0.0.1:${port}`)).toBe(403);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it("streams events over SSE; only a reconnect (Last-Event-ID) or ?since replays missed events", async () => {
    const { base, port } = await start();
    await waitJob(base, (await call(base, "/api/clear", { gtin: B, market: "UK" })).body.job_id);
    // A new connection gets no history: only the retry line, then live events.
    const fresh = await new Promise<string>((ok, fail) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += String(c)));
        setTimeout(() => {
          req.destroy();
          ok(buf);
        }, 300);
      });
      req.on("error", (e) => (String(e).includes("socket hang up") ? undefined : fail(e)));
      req.end();
    });
    expect(fresh).toContain("retry: 3000");
    expect(fresh).not.toMatch(/^id: /mu);
    const text = await new Promise<string>((ok, fail) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}`, "last-event-id": "0" } }, (res) => {
        expect(res.headers["content-type"]).toContain("text/event-stream");
        let buf = "";
        res.on("data", (c) => {
          buf += String(c);
          if (buf.includes("event: clear.done")) {
            req.destroy();
            ok(buf);
          }
        });
      });
      req.on("error", (e) => (String(e).includes("socket hang up") ? undefined : fail(e)));
      req.end();
    });
    expect(text).toContain("event: job.queued");
    expect(text).toContain("event: decision.written");
    expect(text).toMatch(/id: \d+/u);
    const since = await new Promise<string>((ok, fail) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/events?since=1", headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += String(c)));
        setTimeout(() => {
          req.destroy();
          ok(buf);
        }, 300);
      });
      req.on("error", (e) => (String(e).includes("socket hang up") ? undefined : fail(e)));
      req.end();
    });
    expect(since).toMatch(/^id: 2$/mu);
    expect(since).not.toMatch(/^id: 1$/mu);
  });
});
