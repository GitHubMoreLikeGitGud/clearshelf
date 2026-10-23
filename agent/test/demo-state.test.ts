import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listSnapshots, resetDemo, snapshotDemo } from "../src/ops/demoState.ts";
import { RunStore } from "../src/ops/runStore.ts";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cs-demo-"));
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text, "utf8");
  };
  put("data/ops/decisions.json", '{"data":[{"decision_id":"__schema__"}]}\n');
  put("data/approvals/queue.json", '{"items":[]}\n');
  put("data/hmem/state.json", '{"memories":1}\n');
  put("data/world/.world/events.jsonl", "e1\n");
  put("data/contracts/used-agent-ops.jsonl", "c-1\n");
  put("data/contracts/verifier-agent-ops.jsonl", "v-1\n");
  put("data/evidence/r1.jsonl", "ev\n");
  return root;
}

describe("demo state", () => {
  it("restores the stores to a snapshot, saves the state it replaced, and keeps used contracts and evidence", () => {
    const root = repo();
    const m = snapshotDemo(root, "post-warmup");
    expect(Object.keys(m.files).sort()).toEqual(["data/approvals/queue.json", "data/contracts/verifier-agent-ops.jsonl", "data/hmem/state.json", "data/ops/decisions.json", "data/world/.world/events.jsonl"]);
    expect(m.absent).toContain("data/runs");
    expect(() => snapshotDemo(root, "post-warmup")).toThrow(/exists/u);

    // A rehearsal: a test approval, a memory, a run, a used contract, more evidence.
    writeFileSync(join(root, "data/ops/decisions.json"), '{"data":[{"decision_id":"__schema__"},{"decision_id":"d-test","actor":"officer"}]}\n');
    writeFileSync(join(root, "data/hmem/state.json"), '{"memories":2}\n');
    writeFileSync(join(root, "data/hmem/decisions.jsonl"), "officer test\n");
    new RunStore(join(root, "data/runs")).save({ run_id: "r20261023T000000aaaa", gtin: "0012345678905", market: "UK" } as never, { source: "server", applied: true });
    writeFileSync(join(root, "data/contracts/used-agent-ops.jsonl"), "c-1\nc-2\n");
    writeFileSync(join(root, "data/evidence/r2.jsonl"), "ev\n");

    const r = resetDemo(root, { name: "post-warmup" });
    expect(r.mismatched).toEqual([]);
    expect(readFileSync(join(root, "data/ops/decisions.json"), "utf8")).not.toContain("d-test");
    expect(readFileSync(join(root, "data/hmem/state.json"), "utf8")).toContain('"memories":1');
    expect(existsSync(join(root, "data/hmem/decisions.jsonl"))).toBe(false);
    expect(existsSync(join(root, "data/runs"))).toBe(false);
    // Kept: a used contract stays used; evidence files stay.
    expect(readFileSync(join(root, "data/contracts/used-agent-ops.jsonl"), "utf8")).toBe("c-1\nc-2\n");
    expect(existsSync(join(root, "data/evidence/r2.jsonl"))).toBe(true);
    // The replaced state is a snapshot of its own.
    const before = listSnapshots(root).find((x) => x.name === r.archived)!;
    expect(before.files["data/hmem/decisions.jsonl"]).toBeDefined();
    expect(readFileSync(join(root, "data/demo", r.archived, "data/ops/decisions.json"), "utf8")).toContain("d-test");
  });

  it("fresh: empty stores with the ops sentinel rows Zetaris needs", () => {
    const root = repo();
    const r = resetDemo(root, { fresh: true });
    expect(r.from).toBe("fresh");
    const doc = JSON.parse(readFileSync(join(root, "data/ops/decisions.json"), "utf8")) as { data: { decision_id: string }[] };
    expect(doc.data.map((d) => d.decision_id)).toEqual(["__schema__"]);
    expect(JSON.parse(readFileSync(join(root, "data/ops/extractions.json"), "utf8")).data).toHaveLength(1);
    expect(existsSync(join(root, "data/hmem"))).toBe(false);
    expect(existsSync(join(root, "data/approvals/queue.json"))).toBe(false);
    expect(() => resetDemo(root, { name: "nope" })).toThrow(/no snapshot/u);
    expect(() => snapshotDemo(root, "../escape")).toThrow(/must match/u);
  });
});

describe("run store", () => {
  it("keeps the latest run per GTIN and market, labelled with its origin, and merges another process's index", () => {
    const root = mkdtempSync(join(tmpdir(), "cs-runs-"));
    const a = new RunStore(root);
    a.save({ run_id: "r1", gtin: "G1", market: "UK" } as never, { source: "cli", applied: false, note: "dry run" });
    const b = new RunStore(root);
    b.save({ run_id: "r2", gtin: "G2", market: "US" } as never, { source: "eval", applied: false });
    a.save({ run_id: "r3", gtin: "G1", market: "UK" } as never, { source: "watch", applied: true, sweep_id: "w1" });
    const c = new RunStore(root);
    expect(c.latestId("G1", "UK")).toBe("r3");
    expect(c.latestId("G2", "US")).toBe("r2");
    expect(c.latest("G1", "UK")!.saved).toMatchObject({ source: "watch", applied: true, sweep_id: "w1" });
    expect(c.load("r1")!.saved?.note).toBe("dry run");
  });
});
