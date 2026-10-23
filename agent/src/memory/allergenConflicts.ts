// Allergen-polarity conflicts on H-MEM facts. The reference conflict check only knows
// regex opposites (always/never, on/off) and numbers, so it never fires on "contains milk"
// against "free from milk". This module does:
//   - two non-superseded facts conflict when they are about the same allergen with
//     opposite polarity (contains or may_contain against free_from) and the same subject:
//     the same GTIN, or the same brand when one of them carries no GTIN (an FSA alert).
//     Facts about two different GTINs never conflict.
//   - every conflict is logged as `conflict_detected` on both memories and QUEUED. It is
//     never resolved automatically. A score per side is computed and kept on the record as
//     a suggestion for the officer.
//   - resolution is the officer's: the loser gets `supersededBy` through store.update and a
//     `conflict_resolved` ledger entry with actor officer and a rule label. Nothing is deleted.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { HMEM as ReferenceHMEM, MemoryRecord } from "../../../engines/hmem/reference/src/index.ts";

export type Polarity = "contains" | "may_contain" | "free_from";

/** Where a fact comes from, in the order the evidence usually deserves. */
export type SourceClass = "regulator" | "officer" | "label_verified" | "label_claim" | "off_tag" | "off_labels";

export const SOURCE_WEIGHT: Readonly<Record<SourceClass, number>> = {
  regulator: 0.95, // FDA recall or FSA alert: a regulator or laboratory finding
  officer: 0.9, // officer ruling, e.g. after inspecting the physical label
  label_verified: 0.75, // OFF label text, model span agreed by the lexicon verifier
  label_claim: 0.6, // free-from wording in the OFF label text
  off_tag: 0.5, // OFF allergens / traces tags (crowd-sourced)
  off_labels: 0.45, // OFF label claims such as en:vegan (crowd-sourced)
};

/** Rule labels an officer can give a resolution (free labels of the same shape are accepted too). */
export const RESOLUTION_RULES = [
  "regulator_over_crowd_source",
  "regulator_over_label_text",
  "label_text_over_crowd_claim",
  "officer_label_inspection",
  "newer_source_record",
  "different_products",
  "both_stand_by_lot",
] as const;

/** Claim -> groups it says are absent (mirrors the claim tester's contradiction table). */
export const CLAIM_FREE_FROM: Readonly<Record<string, string[]>> = {
  vegan: ["milk", "egg", "fish", "crustacean", "mollusc"],
  dairy_free: ["milk"],
  gluten_free: ["gluten_cereal", "wheat"],
  nut_free: ["tree_nut", "peanut"],
};

export interface FactMeta {
  gtin?: string;
  brand?: string;
  allergen?: string;
  polarity?: Polarity;
  notice?: string;
  market?: string;
  srcclass?: SourceClass;
  /** Source record date, YYYY-MM-DD. */
  srcdate?: string;
}

export function tagValue(tags: readonly string[], prefix: string): string | undefined {
  const t = tags.find((x) => x.startsWith(`${prefix}:`));
  return t === undefined ? undefined : t.slice(prefix.length + 1);
}

export function factMeta(m: Pick<MemoryRecord, "tags">): FactMeta {
  return {
    gtin: tagValue(m.tags, "gtin"),
    brand: tagValue(m.tags, "brand"),
    allergen: tagValue(m.tags, "allergen"),
    polarity: tagValue(m.tags, "polarity") as Polarity | undefined,
    notice: tagValue(m.tags, "notice"),
    market: tagValue(m.tags, "market"),
    srcclass: tagValue(m.tags, "srcclass") as SourceClass | undefined,
    srcdate: tagValue(m.tags, "srcdate"),
  };
}

function isPresence(p: Polarity | undefined): boolean {
  return p === "contains" || p === "may_contain";
}

/** True when a presence-side group is contradicted by a free-from group (wheat is a gluten cereal). */
export function groupsClash(presence: string, freeFrom: string): boolean {
  return presence === freeFrom || (presence === "wheat" && freeFrom === "gluten_cereal");
}

export function sameSubject(a: FactMeta, b: FactMeta): "gtin" | "brand" | null {
  if (a.gtin && b.gtin) return a.gtin === b.gtin ? "gtin" : null;
  if (a.brand && b.brand && a.brand === b.brand) return "brand";
  return null;
}

export interface SideScore {
  total: number;
  weight: number;
  confidence: number;
  recency: number;
  safety: number;
}

export interface ConflictScore {
  a: SideScore;
  b: SideScore;
  /** Memory id the score favours. A suggestion only. */
  suggested: string;
  margin: number;
  suggestedRule: string;
}

export interface ConflictResolution {
  outcome: "keep_a" | "keep_b" | "keep_both";
  winner: string | null;
  loser: string | null;
  rule: string;
  reason: string;
  by: string;
  at: string;
  followedSuggestion: boolean;
  reasonMemoryIds: string[];
}

export interface AllergenConflict {
  id: string;
  kind: "allergen_polarity";
  allergen: string;
  scope: "gtin" | "brand";
  gtin: string | null;
  brand: string | null;
  /** The presence side (contains or may_contain). */
  a: string;
  /** The free-from side. */
  b: string;
  polarityA: Polarity;
  polarityB: Polarity;
  classA: SourceClass | null;
  classB: SourceClass | null;
  detectedAt: string;
  status: "queued" | "resolved";
  score: ConflictScore;
  resolution?: ConflictResolution;
}

/** What the service needs from the H-MEM facade. */
export interface ConflictHost {
  readonly store: ReferenceHMEM["store"];
  readonly ledger: ReferenceHMEM["ledger"];
  readonly clock: () => number;
  readonly actor: string;
  withActor<T>(actor: string, fn: () => T): T;
}

const W = { weight: 0.55, confidence: 0.2, recency: 0.15, safety: 0.1 } as const;

export function scoreConflict(a: MemoryRecord, b: MemoryRecord): ConflictScore {
  const ma = factMeta(a);
  const mb = factMeta(b);
  const da = ma.srcdate ?? "";
  const db = mb.srcdate ?? "";
  const rec = (x: string, y: string) => (!x || !y || x === y ? 0.5 : x > y ? 1 : 0);
  const side = (m: MemoryRecord, meta: FactMeta, recency: number): SideScore => {
    const weight = meta.srcclass ? SOURCE_WEIGHT[meta.srcclass] : 0.4;
    const safety = isPresence(meta.polarity) ? 1 : 0;
    const total = W.weight * weight + W.confidence * m.confidence + W.recency * recency + W.safety * safety;
    return { total: round(total), weight, confidence: m.confidence, recency, safety };
  };
  const sa = side(a, ma, rec(da, db));
  const sb = side(b, mb, rec(db, da));
  const aWins = sa.total >= sb.total;
  const winner = aWins ? ma : mb;
  const loser = aWins ? mb : ma;
  return {
    a: sa,
    b: sb,
    suggested: aWins ? a.id : b.id,
    margin: round(Math.abs(sa.total - sb.total) / Math.max(sa.total, sb.total, 1e-9)),
    suggestedRule: `${winner.srcclass ?? "unknown"}_over_${loser.srcclass ?? "unknown"}`,
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function conflictId(x: string, y: string): string {
  return `ac-${createHash("sha256").update([x, y].sort().join("|")).digest("hex").slice(0, 12)}`;
}

export class AllergenConflictService {
  private conflicts: AllergenConflict[] = [];
  private readonly file: string | null;

  constructor(
    private readonly host: ConflictHost,
    persistDir: string | null,
  ) {
    this.file = persistDir ? path.join(persistDir, "allergen_conflicts.json") : null;
    if (this.file && existsSync(this.file)) {
      this.conflicts = (JSON.parse(readFileSync(this.file, "utf8")) as { conflicts: AllergenConflict[] }).conflicts ?? [];
    }
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ conflicts: this.conflicts }, null, 2)}\n`, "utf8");
  }

  all(): readonly AllergenConflict[] {
    return this.conflicts;
  }

  get(id: string): AllergenConflict | undefined {
    return this.conflicts.find((c) => c.id === id);
  }

  queue(): AllergenConflict[] {
    return this.conflicts.filter((c) => c.status === "queued");
  }

  /** Queued conflicts about a GTIN, or brand-scoped ones about its brand(s). */
  queuedFor(gtin: string, brands: string[] = []): AllergenConflict[] {
    return this.queue().filter((c) => c.gtin === gtin || (c.scope === "brand" && c.brand !== null && brands.includes(c.brand)));
  }

  forGtin(gtin: string, brands: string[] = []): AllergenConflict[] {
    return this.conflicts.filter((c) => c.gtin === gtin || (c.scope === "brand" && c.brand !== null && brands.includes(c.brand)));
  }

  private pair(x: MemoryRecord, y: MemoryRecord): AllergenConflict | null {
    if (x.id === y.id || x.supersededBy || y.supersededBy) return null;
    const mx = factMeta(x);
    const my = factMeta(y);
    if (!mx.allergen || !my.allergen || !mx.polarity || !my.polarity) return null;
    let presence: MemoryRecord;
    let free: MemoryRecord;
    if (isPresence(mx.polarity) && my.polarity === "free_from") [presence, free] = [x, y];
    else if (isPresence(my.polarity) && mx.polarity === "free_from") [presence, free] = [y, x];
    else return null;
    const mp = factMeta(presence);
    const mf = factMeta(free);
    if (!groupsClash(mp.allergen!, mf.allergen!)) return null;
    const scope = sameSubject(mp, mf);
    if (!scope) return null;
    const id = conflictId(presence.id, free.id);
    if (this.get(id)) return null;
    return {
      id,
      kind: "allergen_polarity",
      allergen: mp.allergen!,
      scope,
      gtin: scope === "gtin" ? mp.gtin! : (mp.gtin ?? mf.gtin ?? null),
      brand: mp.brand ?? mf.brand ?? null,
      a: presence.id,
      b: free.id,
      polarityA: mp.polarity!,
      polarityB: mf.polarity!,
      classA: mp.srcclass ?? null,
      classB: mf.srcclass ?? null,
      detectedAt: new Date(this.host.clock()).toISOString(),
      status: "queued",
      score: scoreConflict(presence, free),
    };
  }

  private record(c: AllergenConflict): void {
    this.conflicts.push(c);
    for (const [self, other] of [[c.a, c.b], [c.b, c.a]] as const) {
      this.host.ledger.log(self, "conflict_detected", this.host.actor, {
        details: {
          conflictId: c.id,
          kind: c.kind,
          with: other,
          allergen: c.allergen,
          scope: c.scope,
          polarity: self === c.a ? c.polarityA : c.polarityB,
          queued: true,
          suggested: c.score.suggested,
          scores: { [c.a]: c.score.a.total, [c.b]: c.score.b.total },
        },
      });
    }
  }

  /** Checks one fact against every other allergen fact; new conflicts are logged and queued. */
  detectFor(memoryId: string): AllergenConflict[] {
    const m = this.host.store.get(memoryId);
    if (!m || !factMeta(m).allergen) return [];
    const found: AllergenConflict[] = [];
    for (const other of this.host.store.all()) {
      const c = this.pair(m, other);
      if (c) {
        this.record(c);
        found.push(c);
      }
    }
    if (found.length) this.persist();
    return found;
  }

  /** Full pairwise scan (maintenance); finds only conflicts not already on record. */
  scanAll(): AllergenConflict[] {
    const facts = this.host.store.all().filter((m) => factMeta(m).allergen && factMeta(m).polarity);
    const found: AllergenConflict[] = [];
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const c = this.pair(facts[i]!, facts[j]!);
        if (c) {
          this.record(c);
          found.push(c);
        }
      }
    }
    if (found.length) this.persist();
    return found;
  }

  /**
   * The officer's resolution. `winner` is a memory id of the pair, or "both" when the two
   * facts stand together (different products, different lots). Returns the updated record.
   */
  /** Throws when a resolution would be refused; nothing is written. */
  validateResolution(id: string, r: { winner: string | "both"; rule: string; reason: string }): AllergenConflict {
    const c = this.get(id);
    if (!c) throw new Error(`allergen conflict ${id} not found`);
    if (c.status !== "queued") throw new Error(`allergen conflict ${id} is already resolved`);
    if (!/^[a-z][a-z0-9_]{2,59}$/u.test(r.rule)) throw new Error(`rule label must be lower_snake_case: ${r.rule}`);
    if (!r.reason.trim()) throw new Error("a resolution needs the officer's reason");
    if (r.winner !== "both" && r.winner !== c.a && r.winner !== c.b) throw new Error(`winner must be ${c.a}, ${c.b} or "both"`);
    return c;
  }

  resolve(id: string, r: { winner: string | "both"; rule: string; reason: string; by: string; reasonMemoryIds?: string[] }): AllergenConflict {
    const c = this.validateResolution(id, r);
    const at = new Date(this.host.clock()).toISOString();
    const loser = r.winner === "both" ? null : r.winner === c.a ? c.b : c.a;
    const resolution: ConflictResolution = {
      outcome: r.winner === "both" ? "keep_both" : r.winner === c.a ? "keep_a" : "keep_b",
      winner: r.winner === "both" ? null : r.winner,
      loser,
      rule: r.rule,
      reason: r.reason.trim(),
      by: r.by,
      at,
      followedSuggestion: r.winner === c.score.suggested,
      reasonMemoryIds: r.reasonMemoryIds ?? [],
    };
    this.host.withActor(r.by, () => {
      const details = { conflictId: c.id, kind: c.kind, allergen: c.allergen, outcome: resolution.outcome, winner: resolution.winner, rule: r.rule, reason: resolution.reason, suggested: c.score.suggested, followedSuggestion: resolution.followedSuggestion };
      if (loser) {
        const before = this.host.store.get(loser);
        if (!before) throw new Error(`memory ${loser} is gone`);
        this.host.store.update(loser, { supersededBy: r.winner });
        this.host.ledger.log(loser, "conflict_resolved", r.by, { details });
      } else {
        this.host.ledger.log(c.a, "conflict_resolved", r.by, { details });
        this.host.ledger.log(c.b, "conflict_resolved", r.by, { details });
      }
    });
    c.status = "resolved";
    c.resolution = resolution;
    this.persist();
    return c;
  }
}
