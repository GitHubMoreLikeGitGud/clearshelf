import { describe, expect, it } from "vitest";
import { eCovFull } from "../src/eval/measure/cold-warm.ts";
import { labels, score, type SkuRecord } from "../src/eval/measure/extraction.ts";

describe("extraction measurement", () => {
  it("one label per group, wheat implies gluten, and P/R, trap and precautionary counts on a hand-checked table", () => {
    expect(labels([{ group: "wheat", relation: "contains" }, { group: "milk", relation: "may_contain" }, { group: "milk", relation: "contains" }, { group: "egg", relation: "may_contain" }])).toMatchObject({
      wheat: "contains",
      gluten_cereal: "contains",
      milk: "contains",
      egg: "may_contain",
      soy: "none",
    });
    const none = labels([]);
    const rec = (reference: SkuRecord["reference"], K: SkuRecord["K"], traps: string[] = []): SkuRecord => ({ gtin: "g", reference, traps_present: traps, lang: "en", K, N: none, NV: none });
    const recs = [
      rec({ milk: "contains", tree_nut: "none" }, labels([{ group: "milk", relation: "contains" }, { group: "tree_nut", relation: "contains" }]), ["coconut"]),
      rec({ milk: "contains", egg: "may_contain" }, labels([{ group: "egg", relation: "may_contain" }])),
      rec({ milk: "contains", soy: "unscored" }, labels([{ group: "milk", relation: "contains" }, { group: "soy", relation: "contains" }])),
    ];
    const k = score("K", recs);
    expect(k.micro).toMatchObject({ tp: 2, fp: 1, fn: 1 });
    expect(k.per_group_contains_support_ge3.milk).toMatchObject({ support: 3, precision: 1, recall: 2 / 3 });
    expect(k.per_group_contains_support_ge3.tree_nut).toBeUndefined();
    expect(k.trap_false_alarm).toMatchObject({ alarms: 1, pairs: 1 });
    expect(k.precautionary_accuracy).toMatchObject({ exact: 1, pairs: 1 });
    expect(score("N", []).micro.precision).toBeNull();
  });

  it("E-cov over every claim kind", () => {
    expect(eCovFull({ card: [{ evidenceIds: ["a"] }, { evidenceIds: [] }], firings: [{ evidenceIds: ["b"] }] })).toMatchObject({ claims: 3, cited: 2 });
    expect(eCovFull({}).rate).toBeNull();
  });
});
