// First-boot seed for H-MEM, so source-access knowledge shows up as cited memories when
// the agent picks tools:
//   - the Zetaris getting-started `open_data/manifest.json`: one fact per source (id, kind,
//     status, summary), parsed rather than mined because the file is structured;
//   - every `known_to_fail/ISSUE*.md` in that repository, mined with the reference
//     mineDocument contract (Nemotron when available, the model-free path otherwise);
//   - `docs/source-notes.md` when it exists, mined the same way;
//   - ClearShelf's own measured source findings (below), each with the gate that measured it.
// Every memory carries provenance origin "document" and refs [file, sha256]. Seeding is
// idempotent: a document whose sha256 is already recorded in seed.json is skipped.
// Run it directly (from agent/): npx tsx src/memory/seed.ts [--no-model]

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.ts";
import { OllamaClient } from "../llm/ollama.ts";
import { openMemory, type HMEM } from "./hmemFacade.ts";

export interface SourceFinding {
  id: string;
  source: "off" | "fda" | "fsa" | "zetaris" | "rules";
  text: string;
  /** Where and when it was measured. */
  label: string;
  refs: string[];
}

/** Measured on Day 0 and Day 1 (23 Oct 2026) against the live sources and the local Zetaris. */
export const SOURCE_FINDINGS: readonly SourceFinding[] = [
  {
    id: "off-search-503",
    source: "off",
    text: "Open Food Facts /api/v2/search returned HTTP 503, so ClearShelf reads products only through the product endpoint /api/v2/product/<gtin>.json, at least 2.5 s apart, with the ClearShelf User-Agent.",
    label: "source note, build spec section 4",
    refs: ["SPEC:4"],
  },
  {
    id: "off-429-spacing",
    source: "off",
    text: "Open Food Facts product endpoint: 10 of 549 curation calls got HTTP 429, all within three minutes at about 3 s spacing; none after the spacing was raised to 5 s.",
    label: "Day-0 gate G10 (manifest curation), measured 2026-10-23",
    refs: ["gate:G10", "data/curation/net_log.jsonl"],
  },
  {
    id: "fda-search-limit",
    source: "fda",
    text: "openFDA food enforcement: an unquoted single-term search works (search=reason_for_recall:undeclared) and limit is at most 1000 per request; Zetaris counts 1,000 rows, the same as curl, with report dates 2023-12-20 to 2026-10-14.",
    label: "Day-0 gate G2, measured 2026-10-23",
    refs: ["gate:G2", "data/evidence/sql_log.jsonl"],
  },
  {
    id: "fsa-no-gtin",
    source: "fsa",
    text: "UK FSA allergy alerts carry no GTIN, so an FSA alert can only be matched to a catalogue product by brand or business name: a review item, never an automatic HOLD.",
    label: "source note, build spec section 4",
    refs: ["SPEC:4"],
  },
  {
    id: "fsa-counts",
    source: "fsa",
    text: "The FSA allergy-alert table holds 200 alerts (2024-07-08 to 2026-10-21) and 349 alert-allergen rows after the double explode; reportingBusiness is null on 15 of the 200 alerts.",
    label: "Day-0 gate G3, measured 2026-10-23",
    refs: ["gate:G3", "data/evidence/sql_log.jsonl"],
  },
  {
    id: "fsa-update-notations",
    source: "fsa",
    text: "FSA update notices carry notations like FSA-AA-45-2026-update-1; the fsa_allergens template accepts only ^FSA-AA-\\d+-\\d{4}$, so the allergens of an update notice are not read.",
    label: "Day-1 clearance pipeline run, 2026-10-23",
    refs: ["gateway/templates.py"],
  },
  {
    id: "coconut-edition5",
    source: "rules",
    text: "FDA's food allergen Q&A, Edition 5, removed coconut from the tree nuts; UK law never listed it, so a notice that calls coconut a tree nut is a rule-against-rule conflict, not an undeclared tree nut.",
    label: "source note, build spec section 4; reference table data/reference/market_allergens.json",
    refs: ["data/reference/market_allergens.json"],
  },
  {
    id: "zetaris-cache-driver-wide",
    source: "zetaris",
    text: "Zetaris CACHE TABLE is driver-wide, not per session: a second JDBC connection hit the cached openFDA table in 111 ms right after another connection cached it.",
    label: "Day-0 gate G2, measured 2026-10-23",
    refs: ["gate:G2"],
  },
  {
    id: "zetaris-rest-bind-parameter",
    source: "zetaris",
    text: "JayDeBeApi prepares every statement, and the Zetaris driver then reads the '?' in a REST endpoint URL as a bind parameter ('Parameter #1 is unset'); REST statements are sent as a plain java.sql.Statement.",
    label: "Day-0 gate G1, measured 2026-10-23",
    refs: ["gate:G1", "gateway/jdbc.py"],
  },
  {
    id: "zetaris-usl-key-coalesce",
    source: "zetaris",
    text: "A USL key built with concat() is nullable, and ACTIVATE fails with 'nullable -> NOT NULL' unless the key expression is wrapped in COALESCE.",
    label: "Day-0 gate G6, measured 2026-10-23",
    refs: ["gate:G6", "zetaris/sql/11_clearance_usl_activate_create.sql"],
  },
  {
    id: "zetaris-run-dq",
    source: "zetaris",
    text: "RUN DQ on clearance_usl never hung: every run finished in under 2 s; the runner bounds RUN and SHOW DQ at 120 s.",
    label: "Day-0 gate G6, measured 2026-10-23",
    refs: ["gate:G6", "data/evidence/sql_log.jsonl"],
  },
];

export interface SeedDocReport {
  file: string;
  sha12: string;
  via: "parsed" | "model" | "model-free" | "listed";
  memories: number;
  dropped: number;
  skipped: boolean;
  wallMs: number;
}

export interface SeedReport {
  documents: SeedDocReport[];
  missing: string[];
  totalMemories: number;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function findIssues(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) findIssues(p, out);
    else if (/^ISSUE.*\.md$/u.test(name) && path.basename(dir) === "known_to_fail") out.push(p);
  }
  return out;
}

export interface SeedOptions {
  /** Root of the Zetaris getting-started repository (env ZETARIS_GETTING_STARTED_DIR). */
  gettingStartedDir?: string | null;
  /** The ClearShelf repository root, for docs/source-notes.md. */
  repoRoot: string;
  log?: (line: string) => void;
}

/** Seeds H-MEM once; documents already seeded with the same content are skipped. */
export async function seedMemory(hmem: HMEM, opts: SeedOptions): Promise<SeedReport> {
  const log = opts.log ?? (() => {});
  const gs = opts.gettingStartedDir ?? process.env.ZETARIS_GETTING_STARTED_DIR ?? null;
  const reports: SeedDocReport[] = [];
  const missing: string[] = [];
  const seeded = hmem.seededDocs();

  const already = (key: string, sha12: string) => seeded[key]?.sha12 === sha12;

  // 1. The getting-started manifest, one fact per source.
  if (gs && existsSync(path.join(gs, "open_data", "manifest.json"))) {
    const file = path.join(gs, "open_data", "manifest.json");
    const text = readFileSync(file, "utf8");
    const key = "zetaris-getting-started/open_data/manifest.json";
    const sha12 = sha256(text).slice(0, 12);
    const t0 = performance.now();
    if (already(key, sha12)) {
      reports.push({ file: key, sha12, via: "parsed", memories: seeded[key]!.memoryIds.length, dropped: 0, skipped: true, wallMs: 0 });
    } else {
      const manifest = JSON.parse(text) as { sources?: { id: string; kind?: string; status?: string; summary?: string; replaced_by?: string; requires?: string[] }[] };
      const ids: string[] = [];
      for (const s of manifest.sources ?? []) {
        const m = hmem.add({
          content: `Zetaris getting-started source "${s.id}" (${s.kind ?? "unknown kind"}) is ${s.status ?? "unknown"}${s.replaced_by ? `, replaced by ${s.replaced_by}` : ""}${s.requires?.length ? `, requires ${s.requires.join(", ")}` : ""}: ${s.summary ?? ""}`.trim(),
          type: "factual",
          layer: "working",
          tags: ["document", `file:${key}`, "via:parsed", "source:zetaris", `zetaris-source:${s.id}`, `status:${s.status ?? "unknown"}`],
          confidence: 0.8,
          source: `document:${key}`,
          provenance: { origin: "document", learnedAt: hmem.clock(), label: `parsed from ${key}`, refs: [key, sha256(text)] },
        });
        ids.push(m.id);
      }
      hmem.markSeeded(key, { sha12, memoryIds: ids, via: "parsed" });
      reports.push({ file: key, sha12, via: "parsed", memories: ids.length, dropped: 0, skipped: false, wallMs: Math.round(performance.now() - t0) });
      log(`  ${key}: ${ids.length} source facts (parsed)`);
    }
  } else {
    missing.push("zetaris-getting-started/open_data/manifest.json (set ZETARIS_GETTING_STARTED_DIR)");
  }

  // 2. Known-to-fail issue reports and 3. our source notes, mined.
  const docs: { key: string; file: string; tags: string[] }[] = [];
  if (gs) {
    for (const f of findIssues(path.join(gs, "open_data"))) {
      docs.push({ key: `zetaris-getting-started/${path.relative(gs, f).replace(/\\/gu, "/")}`, file: f, tags: ["source:zetaris", "known_to_fail"] });
    }
  }
  const notes = path.join(opts.repoRoot, "docs", "source-notes.md");
  if (existsSync(notes)) docs.push({ key: "docs/source-notes.md", file: notes, tags: ["source-notes"] });
  else missing.push("docs/source-notes.md (the built-in findings below stand in for it)");

  for (const d of docs) {
    const text = readFileSync(d.file, "utf8").replace(/\r\n/gu, "\n");
    const sha12 = sha256(text).slice(0, 12);
    if (already(d.key, sha12)) {
      reports.push({ file: d.key, sha12, via: seeded[d.key]!.via as SeedDocReport["via"], memories: seeded[d.key]!.memoryIds.length, dropped: 0, skipped: true, wallMs: 0 });
      continue;
    }
    const t0 = performance.now();
    const r = await hmem.mineSourceDocument(d.key, text, { tags: d.tags, label: `mined from ${d.key}` });
    hmem.markSeeded(d.key, { sha12, memoryIds: r.memories.map((m) => m.id), via: r.via });
    reports.push({ file: d.key, sha12, via: r.via, memories: r.memories.length, dropped: r.dropped.length, skipped: false, wallMs: Math.round(performance.now() - t0) });
    log(`  ${d.key}: ${r.memories.length} memories (${r.via}${r.dropped.length ? `, ${r.dropped.length} ungrounded dropped` : ""})`);
  }

  // 4. Our measured source findings.
  const fkey = "clearshelf/source-findings";
  const fsha = sha256(JSON.stringify(SOURCE_FINDINGS)).slice(0, 12);
  if (already(fkey, fsha)) {
    reports.push({ file: fkey, sha12: fsha, via: "listed", memories: seeded[fkey]!.memoryIds.length, dropped: 0, skipped: true, wallMs: 0 });
  } else {
    const ids: string[] = [];
    for (const f of SOURCE_FINDINGS) {
      const existing = hmem.store.all().find((m) => m.tags.includes(`finding:${f.id}`));
      if (existing) {
        ids.push(existing.id);
        continue;
      }
      ids.push(
        hmem.add({
          content: f.text,
          type: "factual",
          layer: "long_term",
          tags: ["kind:source_note", `finding:${f.id}`, `source:${f.source}`],
          confidence: 0.85,
          source: "document:clearshelf-source-findings",
          provenance: { origin: "document", learnedAt: hmem.clock(), label: f.label, refs: f.refs },
        }).id,
      );
    }
    hmem.markSeeded(fkey, { sha12: fsha, memoryIds: ids, via: "listed" });
    reports.push({ file: fkey, sha12: fsha, via: "listed", memories: ids.length, dropped: 0, skipped: false, wallMs: 0 });
    log(`  ${fkey}: ${ids.length} findings`);
  }

  return { documents: reports, missing, totalMemories: hmem.store.all().length };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ollama = process.argv.includes("--no-model") ? null : new OllamaClient({ baseUrl: cfg.ollamaUrl, model: cfg.model });
  const hmem = openMemory({ ollama });
  console.log(`H-MEM ${hmem.persistDir} (${hmem.store.all().length} memories on load), miner ${ollama ? ollama.model : "model-free"}`);
  const t0 = performance.now();
  const r = await seedMemory(hmem, { repoRoot: cfg.repoRoot, log: (l) => console.log(l) });
  for (const d of r.documents) console.log(`${d.skipped ? "skip" : "seed"} ${d.file} via ${d.via}: ${d.memories} memories${d.dropped ? `, ${d.dropped} dropped` : ""}, ${d.wallMs} ms`);
  for (const m of r.missing) console.log(`missing: ${m}`);
  for (const c of hmem.modelCalls) console.log(`model ${c.job}: ok ${c.ok}, attempts ${c.attempts}, items ${c.items}, prompt ${c.promptTokens} tok, output ${c.evalTokens} tok, ${c.tokensPerSecond?.toFixed(1) ?? "n/a"} tok/s, ${c.wallMs} ms (measured)`);
  console.log(`total memories ${r.totalMemories}, ledger entries ${hmem.ledger.all().length}, ${Math.round(performance.now() - t0)} ms`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
