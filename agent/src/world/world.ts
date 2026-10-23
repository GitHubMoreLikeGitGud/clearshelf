// The catalogue graph on the vendored World Model reference (event-sourced, bitemporal).
// Entities: product (GTIN), brand and firm (name-keyed, so the reference resolver merges
// near-duplicate spellings or queues them for the officer), notice (FDA recall or FSA
// alert), allergen, market and decision. Every write carries provenance whose `at` is the
// source record's own date (OFF last_modified, FDA report_date, FSA created, decision
// time), never the retrieval time, so re-ingesting the same Zetaris rows writes nothing.
//
// Two rulings on top of the reference:
// - The reference closes an open edge when a new edge has the same (from, type, context)
//   and a different target. That models single-valued relations. Multi-valued relations
//   here (declares, made_by, concerns, reports, listed_in, name_match) carry a per-target
//   context "<scope>#<key>" so every target keeps its own open edge.
// - The reference has no way to close an edge whose target stays the same. An edge whose
//   attributes change, or that the source no longer lists, is closed by relating the same
//   context to the target "retracted" at the new source time; that edge is in turn closed
//   when the context gets a real target again. "retracted" is never an entity, so graph
//   views never return it.
//
// The reference WorldModel has no snapshot() write; snapshots ("what we knew when") are
// kept here in snapshots.jsonl, one per decision, each with the event sequence number and
// state hash at that moment.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WorldModel,
  canonicalJson,
  entityIdFromName,
  externalId,
  normalizeName,
  sha256Hex,
  type Entity,
  type Fact,
  type MergeProposal,
  type Provenance,
  type Relationship,
  type WorldEvent,
} from "../../../engines/world-model/reference/src/index.ts";
import { REPO_ROOT_URL } from "../config.ts";
import { sourceFor, type EvidenceRecord, type EvidenceStore } from "../evidence/store.ts";
import type { ClearResult } from "../pipeline.ts";
import { undeclaredGroups } from "../extract/notice.ts";
import { lexiconScan } from "../verify/lexicon.ts";
import { rowsAsObjects, type GatewayClient, type TemplateResult } from "../zetaris/client.ts";
import {
  brandKey,
  brandTokens,
  matchNotice,
  titleSimilarity,
  type BrandCandidate,
  type CatalogueProduct,
  type ProductMatch,
} from "./match.ts";

export const WORLD_NAMESPACE = "clearshelf";
export const WORLD_DIR = fileURLToPath(new URL("data/world/", REPO_ROOT_URL));
export const RETRACTED = "retracted";
const USL = "clearance_usl";

export type Market = "UK" | "US";

// ---------------------------------------------------------------- ids

export const productId = (gtin: string): string => externalId("product", "gtin", gtin);
export const allergenId = (group: string): string => externalId("allergen", "code", group);
export const marketId = (market: string): string => externalId("market", "code", market);
export const decisionEntityId = (id: string): string => externalId("decision", "clearshelf", id);
export function noticeId(source: "fda" | "fsa", id: string): string {
  return externalId("notice", source, id);
}

// ---------------------------------------------------------------- source rows

/** clearance_usl.product (template `product`). */
export interface ProductRow {
  gtin: string;
  product_name: string | null;
  brand: string | null;
  lang: string | null;
  ingredients_text: string | null;
  ingredients_text_en: string | null;
  labels: string | null;
  vegan_claim: string | null;
  last_modified: string | null;
  source_url: string | null;
}

/** clearance_usl.declared_allergen joined to market_allergen (template `declared`). */
export interface DeclaredRow {
  declared_key: string;
  market_code: string;
  relation: string;
  source_tag: string | null;
  display_name: string | null;
}

/** clearance_usl.recall_product_link joined to fda_recall (template `recalls_by_gtin`). */
export interface RecallLinkRow {
  link_key: string;
  raw_code: string | null;
  transform: string | null;
  extracted_by: string | null;
  recall_number: string;
  report_date: string | null;
  classification: string | null;
  status: string | null;
  firm: string | null;
  distribution: string | null;
  product_description: string | null;
  reason: string | null;
  code_info: string | null;
}

/** clearance_usl.fsa_alert (template `fsa_recent`). */
export interface FsaAlertRow {
  notation: string;
  created: string | null;
  title: string | null;
  business: string | null;
  alert_url: string | null;
}

/** Where a row came from: the USL object, the statement hash and the source URL. */
export interface SourceMeta {
  object: string;
  sqlSha256: string;
  url?: string;
  evidenceId?: string;
}

export interface ProductBundle {
  product: ProductRow;
  markets: Market[];
  declared: DeclaredRow[];
  recalls: RecallLinkRow[];
  src: { product: SourceMeta; declared?: SourceMeta; recalls?: SourceMeta };
}

export interface FsaBundle {
  alert: FsaAlertRow;
  /** Allergen labels from fsa_alert_allergen; null when they could not be read (update notices). */
  allergens: string[] | null;
  src: { alert: SourceMeta; allergens?: SourceMeta };
}

export interface CatalogueBatch {
  products: ProductBundle[];
  fsa: FsaBundle[];
}

export interface IngestDelta {
  eventsBefore: number;
  eventsAfter: number;
  appended: number;
  stateBefore: string;
  stateAfter: string;
  changed: boolean;
  writes: { entities: number; edges: number; retractions: number; kept: number };
  nameMatches: ProductMatch[];
  mergeQueuePending: number;
}

// ---------------------------------------------------------------- helpers

/** Any source date as a full UTC ISO string: epoch seconds, YYYY-MM-DD, YYYYMMDD or ISO. */
export function toIsoUtc(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  if (/^\d{9,11}$/u.test(s)) return new Date(Number(s) * 1000).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(s)) return `${s}T00:00:00.000Z`;
  if (/^\d{8}$/u.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00.000Z`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const UNKNOWN_AT = "1970-01-01T00:00:00.000Z";

function clip(v: string | null | undefined, n: number): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function cleanAttrs(a: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined));
}

function attrsSubset(want: Record<string, unknown>, have: Record<string, unknown>): boolean {
  return Object.entries(want).every(([k, v]) => canonicalJson(have[k] ?? null) === canonicalJson(v ?? null));
}

function ctxOf(scope: string, key: string): string {
  return `${scope}#${key}`;
}

/** Allergen group codes for an FSA allergen label ("Almond" -> tree_nut). */
export function groupsOfLabel(label: string): string[] {
  const groups = new Set<string>();
  for (const h of lexiconScan(label)) if (h.relation === "contains" || h.relation === "may_contain") groups.add(h.group);
  if (groups.size === 0) {
    const w = label.toLowerCase();
    if (/crustacean/u.test(w)) groups.add("crustacean");
    else if (/mollus/u.test(w)) groups.add("mollusc");
  }
  return [...groups];
}

function provenance(meta: SourceMeta, at: string, by?: string): Provenance {
  return { kind: "api", by: by ?? `zetaris:${meta.object}`, at, url: meta.url, checksum: meta.sqlSha256 };
}

interface StateShape {
  entities: Entity[];
  relationships: Relationship[];
  facts: Fact[];
}

// ---------------------------------------------------------------- snapshots

export interface SnapshotEdge {
  type: string;
  dir: "out" | "in";
  other: string;
  otherType: string | null;
  otherName: string | null;
  attrs: Record<string, unknown>;
  validFrom: string | null;
  context: string | null;
}

export interface WorldSnapshot {
  id: string;
  /** When the agent took it (transaction time). */
  at: string;
  gtin: string;
  market: Market | null;
  reason: string;
  decisionId: string | null;
  /** Sequence number of the last world event folded into this snapshot. */
  eventSeq: number;
  stateSha256: string;
  product: { id: string; name: string | null; aliases: string[]; attrs: Record<string, unknown> } | null;
  edges: SnapshotEdge[];
  facts: { predicate: string; value: unknown; assertedAt: string; by: string | null; superseded: boolean }[];
  notices: { id: string; attrs: Record<string, unknown> }[];
}

export interface DecisionInput {
  decisionId: string;
  gtin: string;
  market: Market;
  status: string;
  rules: string[];
  /** Decision time, any ISO form; stored as UTC. */
  decidedAt: string;
  actor: string;
  runId?: string;
  evidenceId?: string;
  contractId?: string | null;
  statement?: string | null;
}

export interface TimelineLine {
  seq: number;
  at: string;
  kind: string;
  summary: string;
}

// ---------------------------------------------------------------- the graph

export interface CatalogueWorldOptions {
  /** Directory for `.world/clearshelf.json` and `snapshots.jsonl`; null keeps everything in memory. */
  directory?: string | null;
  clock?: () => Date;
}

export class CatalogueWorld {
  readonly wm: WorldModel;
  readonly directory: string | null;
  private readonly snapshotsFile: string | null;
  private readonly snapshots: WorldSnapshot[] = [];
  private counts = { entities: 0, edges: 0, retractions: 0, kept: 0 };

  constructor(opts: CatalogueWorldOptions = {}) {
    this.directory = opts.directory === undefined ? WORLD_DIR : opts.directory;
    this.wm = new WorldModel({
      storage: this.directory ? "local" : "memory",
      namespace: WORLD_NAMESPACE,
      directory: this.directory ?? undefined,
      conflictPolicy: "most-recent-wins",
      clock: opts.clock,
    });
    this.snapshotsFile = this.directory ? path.join(this.directory, "snapshots.jsonl") : null;
    if (this.snapshotsFile && existsSync(this.snapshotsFile)) {
      for (const line of readFileSync(this.snapshotsFile, "utf8").split("\n")) {
        if (line.trim()) this.snapshots.push(JSON.parse(line) as WorldSnapshot);
      }
    }
  }

  // ------------------------------------------------------------ reads

  shape(): StateShape {
    return this.wm.stateShape() as StateShape;
  }

  /** sha256 of the canonical state shape (the idempotency diff surface). */
  stateHash(): string {
    return sha256Hex(this.wm.stateShapeCanonical());
  }

  eventCount(): number {
    return this.wm.events().length;
  }

  entity(id: string): Entity | undefined {
    return this.wm.view("graph").entity(id);
  }

  private resolve(id: string): string {
    return this.entity(id)?.id ?? id;
  }

  /** Open (current) edges, optionally filtered; retraction sentinels excluded. */
  edges(filter: { from?: string; to?: string; type?: string; contextPrefix?: string; includeClosed?: boolean } = {}): Relationship[] {
    const from = filter.from ? this.resolve(filter.from) : undefined;
    const to = filter.to ? this.resolve(filter.to) : undefined;
    return this.shape().relationships.filter(
      (r) =>
        r.to !== RETRACTED &&
        (filter.includeClosed || !r.validTo) &&
        (!from || r.from === from) &&
        (!to || r.to === to) &&
        (!filter.type || r.type === filter.type) &&
        (!filter.contextPrefix || (r.context ?? "").startsWith(filter.contextPrefix)),
    );
  }

  private openEdgeAt(from: string, type: string, context: string): Relationship | undefined {
    const f = this.resolve(from);
    return this.shape().relationships.find((r) => r.from === f && r.type === type && (r.context ?? "") === context && !r.validTo);
  }

  // ------------------------------------------------------------ idempotent writes

  private async upsert(input: {
    type: string;
    externalKey?: { system: string; id: string };
    name?: string | null;
    attrs: Record<string, unknown>;
    source: Provenance;
  }): Promise<string> {
    const attrs = cleanAttrs(input.attrs);
    const name = input.name?.trim() || undefined;
    const id = input.externalKey ? externalId(input.type, input.externalKey.system, input.externalKey.id) : entityIdFromName(input.type, name!);
    const cur = this.entity(id);
    if (cur && (!name || cur.name === name || cur.aliases.includes(name)) && attrsSubset(attrs, cur.attrs)) {
      this.counts.kept++;
      return cur.id;
    }
    const e = await this.wm.upsertEntity({ type: input.type, externalKey: input.externalKey, name, attrs, source: input.source });
    this.counts.entities++;
    return e.id;
  }

  private async retract(from: string, type: string, context: string, source: Provenance): Promise<void> {
    await this.wm.relate({ from, type, to: RETRACTED, context, validFrom: source.at as string, source });
    this.counts.retractions++;
  }

  /**
   * One edge in a per-target context. "add" keeps any open edge already there; "sync"
   * replaces it when its target or attributes differ (retraction, then the new edge).
   */
  private async setEdge(
    from: string,
    type: string,
    to: string,
    scope: string,
    key: string,
    attrs: Record<string, unknown>,
    source: Provenance,
    mode: "add" | "sync",
  ): Promise<"kept" | "written" | "same_time"> {
    const context = ctxOf(scope, key);
    const target = this.resolve(to);
    const cur = this.openEdgeAt(from, type, context);
    const clean = cleanAttrs(attrs);
    if (cur && cur.to !== RETRACTED) {
      const same = cur.to === target && canonicalJson(cur.attrs ?? {}) === canonicalJson(clean);
      if (same || mode === "add") {
        this.counts.kept++;
        return "kept";
      }
      if (cur.to === target) {
        // Same target, new attributes: needs a later source time to close the old edge.
        if ((source.at as string) <= (cur.validFrom ?? "")) {
          this.counts.kept++;
          return "same_time";
        }
        await this.retract(from, type, context, source);
      }
    }
    await this.wm.relate({ from, type, to: target, context, attrs: clean, validFrom: source.at as string, source });
    this.counts.edges++;
    return "written";
  }

  /** Makes the open edges of (from, type) under a scope exactly `desired`, retracting the rest. */
  private async syncScope(
    from: string,
    type: string,
    scope: string,
    desired: { to: string; key: string; attrs: Record<string, unknown> }[],
    source: Provenance,
  ): Promise<void> {
    const keys = new Set(desired.map((d) => ctxOf(scope, d.key)));
    for (const r of this.edges({ from, type, contextPrefix: `${scope}#` })) {
      if (!keys.has(r.context ?? "")) await this.retract(from, type, r.context ?? "", source);
    }
    for (const d of desired) await this.setEdge(from, type, d.to, scope, d.key, d.attrs, source, "sync");
  }

  // ------------------------------------------------------------ ingest

  private async ensureMarket(m: Market): Promise<string> {
    return this.upsert({
      type: "market",
      externalKey: { system: "code", id: m },
      name: m,
      attrs: { code: m },
      source: { kind: "manual", by: "clearshelf", at: UNKNOWN_AT },
    });
  }

  private async ensureAllergen(group: string): Promise<string> {
    return this.upsert({
      type: "allergen",
      externalKey: { system: "code", id: group },
      name: group,
      attrs: { code: group },
      source: { kind: "manual", by: "clearshelf", at: UNKNOWN_AT },
    });
  }

  async ingestProduct(b: ProductBundle): Promise<string> {
    const p = b.product;
    const at = toIsoUtc(p.last_modified) ?? UNKNOWN_AT;
    const text = (p.ingredients_text ?? "").trim() || (p.ingredients_text_en ?? "").trim();
    const src = provenance({ ...b.src.product, url: p.source_url ?? b.src.product.url }, at);
    const pid = await this.upsert({
      type: "product",
      externalKey: { system: "gtin", id: p.gtin },
      name: p.product_name,
      attrs: {
        gtin: p.gtin,
        brand: p.brand ?? null,
        lang: p.lang ?? null,
        labels: p.labels ?? null,
        vegan_claim: p.vegan_claim ?? null,
        last_modified: at,
        has_ingredients_text: text.length > 0,
        // A hash only: Open Food Facts ingredient text is never copied into the graph.
        ingredients_sha256_12: text ? sha256Hex(text).slice(0, 12) : null,
        source_url: p.source_url ?? null,
      },
      source: src,
    });

    const brands: { to: string; key: string; attrs: Record<string, unknown> }[] = [];
    for (const raw of (p.brand ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
      const bid = await this.upsert({ type: "brand", name: raw, attrs: {}, source: src });
      brands.push({ to: bid, key: bid, attrs: { brand_raw: raw } });
    }
    await this.syncScope(pid, "made_by", "brand", brands, src);

    for (const m of b.markets) {
      const mid = await this.ensureMarket(m);
      await this.setEdge(pid, "listed_in", mid, "market", m, {}, src, "add");
    }

    if (b.src.declared) {
      const dsrc = provenance(b.src.declared, at);
      const desired: { to: string; key: string; attrs: Record<string, unknown> }[] = [];
      for (const d of b.declared) {
        const [market, ...rest] = String(d.market_code).split(":");
        const group = rest.join(":");
        if (!market || !group) continue;
        const aid = await this.ensureAllergen(group);
        desired.push({
          to: aid,
          key: `${marketId(market)}|${group}|${d.relation}`,
          attrs: { market, relation: d.relation, source_tag: d.source_tag ?? null, statutory: d.display_name !== null && d.display_name !== undefined },
        });
      }
      await this.syncScope(pid, "declares", "decl", desired, dsrc);
    }

    for (const r of b.recalls) await this.ingestFdaRecall(r, p.gtin, b.src.recalls ?? b.src.product);
    return pid;
  }

  async ingestFdaRecall(r: RecallLinkRow, gtin: string | null, meta: SourceMeta): Promise<string> {
    const at = toIsoUtc(r.report_date) ?? UNKNOWN_AT;
    const src = provenance({ ...meta, url: meta.url ?? sourceFor("clearshelf_fda.enforcement_undeclared").url }, at);
    const { groups, coconutAsTreeNut } = undeclaredGroups(r.reason ?? "");
    const nid = await this.upsert({
      type: "notice",
      externalKey: { system: "fda", id: r.recall_number },
      name: `FDA ${r.recall_number}`,
      attrs: {
        source: "fda",
        recall_number: r.recall_number,
        report_date: r.report_date ?? null,
        classification: r.classification ?? null,
        status: r.status ?? null,
        firm: r.firm ?? null,
        distribution: clip(r.distribution, 300),
        product_description: clip(r.product_description, 300),
        reason: clip(r.reason, 300),
        code_info: clip(r.code_info, 200),
        coconut_as_tree_nut: coconutAsTreeNut,
      },
      source: src,
    });
    if (r.firm && r.firm.trim()) {
      const fid = await this.upsert({ type: "firm", name: r.firm.trim(), attrs: {}, source: src });
      await this.setEdge(nid, "issued_by", fid, "firm", "issuer", {}, src, "sync");
    }
    const reports: { to: string; key: string; attrs: Record<string, unknown> }[] = [];
    for (const g of groups) reports.push({ to: await this.ensureAllergen(g), key: g, attrs: { basis: "reason text, lexicon" } });
    await this.syncScope(nid, "reports", "allergen", reports, src);
    if (gtin) {
      await this.setEdge(nid, "concerns", productId(gtin), "gtin", gtin, {
        transform: r.transform ?? null,
        raw_code: r.raw_code ?? null,
        extracted_by: r.extracted_by ?? null,
      }, src, "add");
    }
    return nid;
  }

  async ingestFsaAlert(f: FsaBundle): Promise<string> {
    const a = f.alert;
    const at = toIsoUtc(a.created) ?? UNKNOWN_AT;
    const src = provenance({ ...f.src.alert, url: a.alert_url ?? f.src.alert.url }, at);
    const nid = await this.upsert({
      type: "notice",
      externalKey: { system: "fsa", id: a.notation },
      name: a.title ?? a.notation,
      attrs: {
        source: "fsa",
        notation: a.notation,
        created: a.created ?? null,
        title: clip(a.title, 300),
        business: a.business ?? null,
        alert_url: a.alert_url ?? null,
        allergens_read: f.allergens !== null,
      },
      source: src,
    });
    if (a.business && a.business.trim()) {
      const fid = await this.upsert({ type: "firm", name: a.business.trim(), attrs: {}, source: src });
      await this.setEdge(nid, "issued_by", fid, "firm", "issuer", {}, src, "sync");
    }
    if (f.allergens !== null && f.src.allergens) {
      const asrc = provenance(f.src.allergens, at);
      const desired: { to: string; key: string; attrs: Record<string, unknown> }[] = [];
      for (const label of f.allergens) {
        for (const g of groupsOfLabel(label)) {
          if (desired.some((d) => d.key === g)) continue;
          desired.push({ to: await this.ensureAllergen(g), key: g, attrs: { label } });
        }
      }
      await this.syncScope(nid, "reports", "allergen", desired, asrc);
    }
    return nid;
  }

  /** Every catalogue product with its brand and the brand's aliases (merged spellings included). */
  catalogue(): CatalogueProduct[] {
    const shape = this.shape();
    const g = this.wm.view("graph");
    const namesByPrimary = new Map<string, Set<string>>();
    for (const e of shape.entities) {
      if (e.type !== "brand") continue;
      const primary = g.entity(e.id)?.id ?? e.id;
      const set = namesByPrimary.get(primary) ?? new Set<string>();
      for (const n of [e.name, ...e.aliases]) if (n) set.add(n);
      namesByPrimary.set(primary, set);
    }
    const out: CatalogueProduct[] = [];
    for (const e of shape.entities) {
      if (e.type !== "product") continue;
      const brandEdges = shape.relationships.filter((r) => r.from === e.id && r.type === "made_by" && !r.validTo && r.to !== RETRACTED);
      let brand: BrandCandidate | null = null;
      if (brandEdges.length) {
        const primaries = brandEdges.map((r) => g.entity(r.to)?.id ?? r.to);
        const names = new Set<string>();
        for (const p of primaries) for (const n of namesByPrimary.get(p) ?? []) names.add(n);
        brand = { brandId: primaries[0], names: [...names].sort() };
      }
      out.push({ gtin: String(e.attrs.gtin ?? e.id.split(":").pop()), name: e.name ?? null, brand });
    }
    return out.sort((a, b) => a.gtin.localeCompare(b.gtin));
  }

  /**
   * Name-matches FSA alerts against the catalogue (brand-token pre-filter, then the merge
   * bands). Every match is recorded as a `name_match` edge (a review item, never a status
   * change). A review-band spelling is upserted as a brand, which puts it in the reference
   * merge queue for the officer; an approved merge makes it an alias of the catalogue brand.
   */
  async linkNameMatches(noticeIds?: string[]): Promise<ProductMatch[]> {
    const catalogue = this.catalogue();
    const out: ProductMatch[] = [];
    const notices = this.shape().entities.filter(
      (e) => e.type === "notice" && e.attrs.source === "fsa" && (!noticeIds || noticeIds.includes(e.id)),
    );
    for (const n of notices) {
      const matches = matchNotice(
        { source: "fsa", id: String(n.attrs.notation), title: str(n.attrs.title), business: str(n.attrs.business) },
        catalogue,
      );
      for (const m of matches) {
        out.push(m);
        const src: Provenance = { ...n.source, by: "clearshelf:name-match" };
        if (m.brand.band === "review") {
          const known = catalogue.find((c) => c.gtin === m.gtin)?.brand?.names.some((x) => normalizeName(x) === normalizeName(m.brand.window));
          if (!known) await this.upsert({ type: "brand", name: m.brand.window, attrs: {}, source: src });
        }
        await this.setEdge(n.id, "name_match", productId(m.gtin), "gtin", m.gtin, {
          band: m.brand.band,
          brand_similarity: m.brand.similarity,
          alias: m.brand.alias,
          window: m.brand.window,
          field: m.field,
          name_similarity: m.nameSimilarity,
          shared_tokens: m.brand.sharedTokens,
        }, src, "add");
      }
    }
    return out;
  }

  /** Ingests one batch; the delta is empty when the same rows were ingested before. */
  async ingest(batch: CatalogueBatch): Promise<IngestDelta> {
    this.counts = { entities: 0, edges: 0, retractions: 0, kept: 0 };
    const eventsBefore = this.eventCount();
    const stateBefore = this.stateHash();
    for (const b of batch.products) await this.ingestProduct(b);
    for (const f of batch.fsa) await this.ingestFsaAlert(f);
    const nameMatches = await this.linkNameMatches();
    const stateAfter = this.stateHash();
    return {
      eventsBefore,
      eventsAfter: this.eventCount(),
      appended: this.eventCount() - eventsBefore,
      stateBefore,
      stateAfter,
      changed: stateBefore !== stateAfter,
      writes: { ...this.counts },
      nameMatches,
      mergeQueuePending: this.wm.mergeQueue().filter((p) => p.status === "pending").length,
    };
  }

  // ------------------------------------------------------------ decisions and snapshots

  /** A decision: the decision entity, `decides` edge, `clearance:<market>` fact, listing status, snapshot. */
  async recordDecision(d: DecisionInput): Promise<WorldSnapshot> {
    const at = toIsoUtc(d.decidedAt) ?? UNKNOWN_AT;
    const src: Provenance = {
      kind: "agent",
      by: d.actor,
      at,
      runId: d.runId,
      checksum: sha256Hex(canonicalJson({ ...d, decidedAt: at })),
      url: d.evidenceId ? `evidence:${d.evidenceId}` : undefined,
    };
    const pid = productId(d.gtin);
    const did = await this.upsert({
      type: "decision",
      externalKey: { system: "clearshelf", id: d.decisionId },
      name: `${d.status} ${d.gtin} ${d.market}`,
      attrs: {
        gtin: d.gtin,
        market: d.market,
        status: d.status,
        rules: d.rules,
        decided_at: at,
        actor: d.actor,
        run_id: d.runId ?? null,
        evidence_id: d.evidenceId ?? null,
        contract_id: d.contractId ?? null,
        statement: clip(d.statement ?? null, 400),
      },
      source: src,
    });
    await this.wm.relate({ from: did, type: "decides", to: pid, context: marketId(d.market), source: src });
    await this.wm.assertFact({ about: pid, predicate: `clearance:${d.market}`, value: d.status, confidence: 1, source: src });
    const mid = await this.ensureMarket(d.market);
    await this.setEdge(pid, "listed_in", mid, "market", d.market, { status: d.status, decision: d.decisionId }, src, "sync");
    return this.snapshot(d.gtin, { at, market: d.market, reason: `decision ${d.status} (${d.rules.join(", ") || "no rule"})`, decisionId: d.decisionId });
  }

  /**
   * One clearance run into the graph: the product, declared and recall rows the run read
   * through Zetaris (from its evidence records), then the decision with its snapshot.
   */
  async ingestClearResult(
    result: ClearResult,
    evidence: EvidenceStore,
    opts: { markets?: Market[]; decisionId?: string; actor?: string; status?: string; contractId?: string } = {},
  ): Promise<{ productId: string | null; snapshot: WorldSnapshot }> {
    const recs = result.evidence_ids.map((id) => evidence.get(id)).filter((r): r is EvidenceRecord => !!r);
    const ev = (t: string) => recs.find((r) => r.template_id === t);
    const productEv = ev("product");
    const declaredEv = ev("declared");
    const recallsEv = ev("recalls_by_gtin");
    const policyEv = [...recs].reverse().find((r) => r.kind === "policy");
    let pid: string | null = null;
    const row = evidenceRows(productEv)[0] as unknown as ProductRow | undefined;
    if (productEv && row) {
      pid = await this.ingestProduct({
        product: row,
        markets: opts.markets ?? [result.market],
        declared: evidenceRows(declaredEv) as unknown as DeclaredRow[],
        recalls: evidenceRows(recallsEv) as unknown as RecallLinkRow[],
        src: { product: metaOfEvidence(productEv), declared: declaredEv ? metaOfEvidence(declaredEv) : undefined, recalls: recallsEv ? metaOfEvidence(recallsEv) : undefined },
      });
    }
    const snapshot = await this.recordDecision({
      decisionId: opts.decisionId ?? `${result.run_id}:${result.gtin}:${result.market}`,
      gtin: result.gtin,
      market: result.market,
      status: opts.status ?? result.decision.status,
      rules: [...new Set(result.decision.firings.filter((f) => f.effect !== "INFO").map((f) => f.rule))],
      decidedAt: policyEv?.queried_at ?? result.started_at,
      actor: opts.actor ?? "clearshelf-policy",
      runId: result.run_id,
      evidenceId: policyEv?.id,
      contractId: opts.contractId,
      statement: result.statement?.text ?? null,
    });
    return { productId: pid, snapshot };
  }

  /** Materialises what the graph holds about one product now; idempotent per (gtin, market, at, decision). */
  snapshot(gtin: string, o: { at: string; market?: Market; reason: string; decisionId?: string }): WorldSnapshot {
    const at = toIsoUtc(o.at) ?? UNKNOWN_AT;
    const id = `snap_${sha256Hex(`${gtin}|${o.market ?? ""}|${at}|${o.decisionId ?? ""}`).slice(0, 16)}`;
    const existing = this.snapshots.find((s) => s.id === id);
    if (existing) return existing;
    const pid = productId(gtin);
    const shape = this.shape();
    const byId = new Map(shape.entities.map((e) => [e.id, e]));
    const product = byId.get(pid) ?? null;
    const edges: SnapshotEdge[] = [];
    const noticeIds = new Set<string>();
    for (const r of shape.relationships) {
      if (r.validTo || r.to === RETRACTED) continue;
      const dir = r.from === pid ? "out" : r.to === pid ? "in" : null;
      if (!dir) continue;
      const other = dir === "out" ? r.to : r.from;
      const oe = byId.get(other);
      if (oe?.type === "notice") noticeIds.add(other);
      edges.push({ type: r.type, dir, other, otherType: oe?.type ?? null, otherName: oe?.name ?? null, attrs: r.attrs ?? {}, validFrom: r.validFrom ?? null, context: r.context ?? null });
    }
    const snap: WorldSnapshot = {
      id,
      at,
      gtin,
      market: o.market ?? null,
      reason: o.reason,
      decisionId: o.decisionId ?? null,
      eventSeq: this.eventCount(),
      stateSha256: this.stateHash(),
      product: product ? { id: product.id, name: product.name ?? null, aliases: [...product.aliases], attrs: { ...product.attrs } } : null,
      edges: edges.sort((a, b) => a.type.localeCompare(b.type) || a.other.localeCompare(b.other)),
      facts: shape.facts
        .filter((f) => f.about === pid)
        .map((f) => ({ predicate: f.predicate, value: f.value, assertedAt: f.assertedAt, by: f.source.by ?? null, superseded: !!f.supersededBy }))
        .sort((a, b) => a.assertedAt.localeCompare(b.assertedAt) || a.predicate.localeCompare(b.predicate)),
      notices: [...noticeIds].sort().map((n) => ({ id: n, attrs: { ...(byId.get(n)?.attrs ?? {}) } })),
    };
    this.snapshots.push(snap);
    if (this.snapshotsFile) {
      mkdirSync(path.dirname(this.snapshotsFile), { recursive: true });
      appendFileSync(this.snapshotsFile, `${JSON.stringify(snap)}\n`, "utf8");
    }
    return snap;
  }

  snapshotsFor(gtin: string): WorldSnapshot[] {
    return this.snapshots.filter((s) => s.gtin === gtin).sort((a, b) => a.at.localeCompare(b.at));
  }

  /** What the agent knew about a product at a moment: the latest snapshot taken at or before it. */
  knewWhen(gtin: string, at: string, market?: Market): WorldSnapshot | null {
    const iso = toIsoUtc(at) ?? at;
    const list = this.snapshotsFor(gtin).filter((s) => s.at <= iso && (!market || s.market === market));
    return list.length ? list[list.length - 1]! : null;
  }

  /** What the sources said by a date (source time): the product, edges valid then, facts asserted by then. */
  asOf(gtin: string, at: string): { product: Entity | undefined; edges: Relationship[]; facts: Fact[] } {
    const iso = toIsoUtc(at.length === 10 ? `${at}T23:59:59.999Z` : at) ?? at;
    const pid = productId(gtin);
    const shape = this.shape();
    const valid = (r: Relationship) => (!r.validFrom || r.validFrom <= iso) && (!r.validTo || iso < r.validTo);
    return {
      product: this.wm.view("snapshot").entityAt(pid, iso),
      edges: shape.relationships.filter((r) => r.to !== RETRACTED && (r.from === pid || r.to === pid) && valid(r)),
      facts: shape.facts.filter((f) => f.about === pid && f.assertedAt <= iso),
    };
  }

  /** Source-time ordered events about a product and the notices that concern or name-match it. */
  timeline(gtin: string): TimelineLine[] {
    const pid = productId(gtin);
    const related = new Set<string>([pid]);
    for (const r of this.shape().relationships) {
      if (r.to === pid && (r.type === "concerns" || r.type === "name_match" || r.type === "decides")) related.add(r.from);
    }
    const label = (id: string) => {
      if (!id.startsWith("ent_")) return id;
      const e = this.entity(id);
      return e?.name ? `${e.type} "${e.name}"` : id;
    };
    const out: TimelineLine[] = [];
    for (const e of this.wm.events() as readonly WorldEvent[]) {
      const p = e.payload as unknown as Record<string, unknown>;
      let summary: string | null = null;
      if (e.kind === "upsertEntity" && related.has(String(p.id))) summary = `${p.type} ${p.id}${p.name ? ` "${p.name}"` : ""}`;
      else if (e.kind === "relate" && (related.has(String(p.from)) || related.has(String(p.to)))) {
        summary =
          p.to === RETRACTED
            ? `${label(String(p.from))} -${p.type}-> (earlier edge closed)`
            : `${label(String(p.from))} -${p.type}-> ${label(String(p.to))}${p.attrs && Object.keys(p.attrs as object).length ? ` ${canonicalJson(p.attrs)}` : ""}`;
      } else if (e.kind === "assertFact" && related.has(String(p.about))) summary = `${p.about}.${p.predicate} = ${canonicalJson(p.value)}`;
      if (summary) out.push({ seq: e.seq, at: e.at, kind: e.kind, summary });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
  }

  // ------------------------------------------------------------ operator surface

  mergeQueue(): readonly MergeProposal[] {
    return this.wm.mergeQueue();
  }

  approveMerge(proposalId: string, by = "officer"): Promise<void> {
    return this.wm.approveMerge(proposalId, by);
  }

  rejectMerge(proposalId: string, by = "officer"): Promise<void> {
    return this.wm.rejectMerge(proposalId, by);
  }

  /** The `world.lookup` tool: a GTIN gives the product and its neighbourhood; a name gives the best catalogue matches. */
  lookup(q: string): {
    kind: "gtin" | "name";
    product?: { id: string; name: string | null; attrs: Record<string, unknown> };
    edges?: { type: string; dir: "out" | "in"; other: string; otherName: string | null; attrs: Record<string, unknown> }[];
    matches?: { gtin: string; name: string | null; brand: string | null; score: number; via: string }[];
  } {
    const digits = q.replace(/\D/gu, "");
    if (digits.length >= 8 && digits.length <= 14 && digits.length === q.trim().length) {
      const gtin = digits.padStart(13, "0").slice(-13);
      const e = this.entity(productId(gtin));
      const shape = this.shape();
      const byId = new Map(shape.entities.map((x) => [x.id, x]));
      const pid = productId(gtin);
      const edges = shape.relationships
        .filter((r) => !r.validTo && r.to !== RETRACTED && (r.from === pid || r.to === pid))
        .map((r) => {
          const dir: "out" | "in" = r.from === pid ? "out" : "in";
          const other = dir === "out" ? r.to : r.from;
          return { type: r.type, dir, other, otherName: byId.get(other)?.name ?? null, attrs: r.attrs ?? {} };
        });
      return { kind: "gtin", product: e ? { id: e.id, name: e.name ?? null, attrs: e.attrs } : undefined, edges };
    }
    const tokens = new Set(brandTokens(q));
    const matches: { gtin: string; name: string | null; brand: string | null; score: number; via: string }[] = [];
    for (const p of this.catalogue()) {
      const brandNames = p.brand?.names ?? [];
      const hit = [...brandNames, p.name ?? ""].some((n) => brandTokens(n).some((t) => tokens.has(t)));
      if (!hit) continue;
      const byName = titleSimilarity(p.name, q);
      const byBrand = Math.max(0, ...brandNames.map((n) => titleSimilarity(n, q)));
      matches.push({ gtin: p.gtin, name: p.name, brand: brandNames[0] ?? null, score: Math.max(byName, byBrand), via: byBrand >= byName ? "brand" : "name" });
    }
    return { kind: "name", matches: matches.sort((a, b) => b.score - a.score || a.gtin.localeCompare(b.gtin)).slice(0, 5) };
  }

  /** Nodes, open and closed edges, and the merge queue, for GET /api/world/export. */
  exportGraph(): { nodes: { id: string; type: string; name: string | null; attrs: Record<string, unknown> }[]; edges: Relationship[]; mergeQueue: readonly MergeProposal[]; snapshots: number; events: number } {
    const shape = this.shape();
    return {
      nodes: shape.entities.map((e) => ({ id: e.id, type: e.type, name: e.name ?? null, attrs: e.attrs })),
      edges: shape.relationships,
      mergeQueue: this.wm.mergeQueue(),
      snapshots: this.snapshots.length,
      events: this.eventCount(),
    };
  }
}

function evidenceRows(rec: EvidenceRecord | undefined): Record<string, unknown>[] {
  if (!rec?.rows || !rec.columns) return [];
  const cols = rec.columns;
  return rec.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, (r as unknown[])[i] ?? null])));
}

function metaOfEvidence(rec: EvidenceRecord): SourceMeta {
  return {
    object: (rec.zetaris_object ?? "").replace(/^lightning\.metastore\.clearshelf\./u, ""),
    sqlSha256: rec.sql_sha256 ?? "",
    url: rec.source_url,
    evidenceId: rec.id,
  };
}

// ---------------------------------------------------------------- reading the rows through Zetaris

function metaOf(res: TemplateResult): SourceMeta {
  const raw = res.raw_objects[0] ?? "";
  return { object: (res.objects[0] ?? "").replace(/^lightning\.metastore\.clearshelf\./u, ""), sqlSha256: res.sql_sha256 ?? "", url: sourceFor(raw).url };
}

export interface FetchReport {
  batch: CatalogueBatch;
  calls: number;
  wallMs: number;
  missingProducts: string[];
  fsaUnread: string[];
}

/**
 * Reads the catalogue rows through the gateway: product, declared and recalls_by_gtin per
 * GTIN, recent FSA alerts and their allergens. One template call at a time.
 */
export async function fetchCatalogue(
  gateway: GatewayClient,
  opts: { skus: { gtin: string; markets: Market[] }[]; fsaSince?: string; log?: (s: string) => void },
): Promise<FetchReport> {
  const t0 = performance.now();
  const log = opts.log ?? (() => {});
  let calls = 0;
  const call = async (id: string, params: Record<string, string>) => {
    calls++;
    return gateway.template(id, params);
  };
  const products: ProductBundle[] = [];
  const missing: string[] = [];
  for (const s of opts.skus) {
    const pr = await call("product", { gtin: s.gtin });
    const row = rowsAsObjects(pr)[0] as unknown as ProductRow | undefined;
    if (!row) {
      missing.push(s.gtin);
      log(`  ${s.gtin}: no product row`);
      continue;
    }
    const dr = await call("declared", { gtin: s.gtin });
    const rr = await call("recalls_by_gtin", { gtin: s.gtin });
    products.push({
      product: row,
      markets: s.markets,
      declared: rowsAsObjects(dr) as unknown as DeclaredRow[],
      recalls: rowsAsObjects(rr) as unknown as RecallLinkRow[],
      src: { product: metaOf(pr), declared: metaOf(dr), recalls: metaOf(rr) },
    });
    log(`  ${s.gtin}: ${dr.row_count} declared, ${rr.row_count} recall link(s)`);
  }
  const fsa: FsaBundle[] = [];
  const unread: string[] = [];
  if (opts.fsaSince) {
    const fr = await call("fsa_recent", { since: opts.fsaSince });
    for (const a of rowsAsObjects(fr) as unknown as FsaAlertRow[]) {
      if (/^FSA-AA-\d+-\d{4}$/u.test(a.notation)) {
        const ar = await call("fsa_allergens", { notation: a.notation });
        fsa.push({
          alert: a,
          allergens: rowsAsObjects(ar).map((x) => String(x.allergen_label)),
          src: { alert: metaOf(fr), allergens: metaOf(ar) },
        });
      } else {
        unread.push(a.notation);
        fsa.push({ alert: a, allergens: null, src: { alert: metaOf(fr) } });
      }
    }
    log(`  FSA since ${opts.fsaSince}: ${fsa.length} alert(s), ${unread.length} without readable allergens`);
  }
  return { batch: { products, fsa }, calls, wallMs: Math.round(performance.now() - t0), missingProducts: missing, fsaUnread: unread };
}

/** Brand tag value for a product row, shared with the memory module. */
export { brandKey };

/** Adapter for the investigation loop's world port: `lookup` returns scored candidate products. */
export function worldPort(world: CatalogueWorld) {
  return {
    async lookup(nameOrGtin: string): Promise<{ candidates: { key: string; name: string; score: number }[] }> {
      const r = world.lookup(nameOrGtin);
      if (r.kind === "gtin") {
        return { candidates: r.product ? [{ key: r.product.id, name: r.product.name ?? r.product.id, score: 1 }] : [] };
      }
      return { candidates: (r.matches ?? []).map((m) => ({ key: productId(m.gtin), name: `${m.name ?? m.gtin}${m.brand ? ` (${m.brand})` : ""}`, score: m.score })) };
    },
  };
}
