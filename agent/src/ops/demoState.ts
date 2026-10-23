// Demo state: a named snapshot of the runtime stores that a rehearsal changes, and a reset
// that puts them back, so every rehearsal starts from the same state (taken after
// `npm run warmup`) and nothing done while testing becomes demo history.
//
//   npm run demo:snapshot -- --name post-warmup [--force]
//   npm run demo:reset -- --name post-warmup        restore that snapshot
//   npm run demo:reset -- --fresh                   empty stores (run `npm run warmup` after)
//
// A reset first saves the current state as data/demo/_before-reset-<time>/, so it can be
// restored the same way. Kept as they are on a reset: the used-contract lists (a contract that
// was used stays used), evidence files, loop reports, sweep records, eval results and the
// recall links (onboarding writes them). Run it with the server stopped: it takes
// data/agent.lock like every command that opens the stores.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The stores a rehearsal changes, relative to the repository root. */
export const DEMO_PATHS = [
  "data/ops/decisions.json",
  "data/ops/extractions.json",
  "data/approvals/queue.json",
  "data/hmem",
  "data/world",
  "data/watch/state.json",
  "data/runs",
  "data/contracts/verifier-agent-ops.jsonl",
  "data/contracts/verifier-gateway.jsonl",
] as const;

export const DEMO_DIR = "data/demo";

/** Ops files Zetaris reads over HTTP: an empty one keeps its sentinel row, never a missing file. */
const EMPTY_OPS: Record<string, unknown> = {
  "data/ops/decisions.json": {
    data: [
      { decision_id: "__schema__", gtin: "string", market: "string", status: "string", statement: "string", decided_at: "string", decided_date: "string", actor: "string", contract_id: "string", reason: "string" },
    ],
  },
  "data/ops/extractions.json": {
    data: [{ extracted_key: "__schema__", gtin: "string", market_code: "string", relation: "string", evidence_text: "string", verifier: "string", run_id: "string" }],
  },
};

export interface DemoManifest {
  name: string;
  created_at: string;
  /** sha256 of every file in the snapshot, by repository-relative path. */
  files: Record<string, string>;
  /** Demo paths that did not exist when the snapshot was taken (a reset removes them). */
  absent: string[];
  note?: string;
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,60}$/u;

function filesUnder(root: string, rel: string): string[] {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [rel];
  return readdirSync(abs).flatMap((f) => filesUnder(root, `${rel}/${f}`));
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export function snapshotDir(root: string, name: string): string {
  if (!NAME.test(name)) throw new Error(`snapshot name must match ${NAME.source}`);
  return path.join(root, DEMO_DIR, name);
}

/** Copies the demo stores into data/demo/<name>/. Refuses to overwrite unless `force`. */
export function snapshotDemo(root: string, name: string, o: { force?: boolean; note?: string } = {}): DemoManifest {
  const dir = snapshotDir(root, name);
  if (existsSync(dir)) {
    if (!o.force) throw new Error(`snapshot "${name}" exists (${dir}); pass --force to replace it`);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  const absent: string[] = [];
  for (const rel of DEMO_PATHS) {
    const src = path.join(root, rel);
    if (!existsSync(src)) {
      absent.push(rel);
      continue;
    }
    cpSync(src, path.join(dir, rel), { recursive: true });
    for (const f of filesUnder(root, rel)) files[f] = sha(path.join(root, f));
  }
  const m: DemoManifest = { name, created_at: new Date().toISOString(), files, absent, ...(o.note ? { note: o.note } : {}) };
  writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(m, null, 1)}\n`, "utf8");
  return m;
}

export function listSnapshots(root: string): DemoManifest[] {
  const base = path.join(root, DEMO_DIR);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((n) => existsSync(path.join(base, n, "manifest.json")))
    .map((n) => JSON.parse(readFileSync(path.join(base, n, "manifest.json"), "utf8")) as DemoManifest)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export interface ResetResult {
  /** Where the state before the reset was saved. */
  archived: string;
  from: string;
  restored: number;
  removed: string[];
  /** Files whose sha256 after the copy differs from the snapshot's manifest (should be none). */
  mismatched: string[];
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:.Z]/gu, "");
}

/**
 * Puts the demo stores back to snapshot `name` (or empty stores with `fresh`), after saving
 * the current state as _before-reset-<time>. Every restored file is checked against the
 * snapshot's sha256.
 */
export function resetDemo(root: string, from: { name: string } | { fresh: true }): ResetResult {
  const src = "name" in from ? snapshotDir(root, from.name) : null;
  if (src && !existsSync(path.join(src, "manifest.json"))) throw new Error(`no snapshot "${"name" in from ? from.name : ""}" in ${path.join(root, DEMO_DIR)}`);
  const manifest = src ? (JSON.parse(readFileSync(path.join(src, "manifest.json"), "utf8")) as DemoManifest) : null;
  const archivedName = `_before-reset-${stamp()}`;
  snapshotDemo(root, archivedName, { note: `state before a reset to ${src ? `"${manifest!.name}"` : "fresh stores"}` });
  const removed: string[] = [];
  let restored = 0;
  for (const rel of DEMO_PATHS) {
    const dst = path.join(root, rel);
    if (existsSync(dst)) {
      rmSync(dst, { recursive: true, force: true });
      removed.push(rel);
    }
    if (src) {
      const from = path.join(src, rel);
      if (existsSync(from)) {
        mkdirSync(path.dirname(dst), { recursive: true });
        cpSync(from, dst, { recursive: true });
        restored += filesUnder(root, rel).length;
      }
    } else if (EMPTY_OPS[rel]) {
      mkdirSync(path.dirname(dst), { recursive: true });
      writeFileSync(dst, `${JSON.stringify(EMPTY_OPS[rel], null, 1)}\n`, "utf8");
      restored += 1;
    }
  }
  const mismatched = manifest ? Object.entries(manifest.files).filter(([f, h]) => !existsSync(path.join(root, f)) || sha(path.join(root, f)) !== h).map(([f]) => f) : [];
  return { archived: archivedName, from: src ? manifest!.name : "fresh", restored, removed, mismatched };
}
