// Clearance results ("runs") by run id, and the latest run per GTIN and market: what the
// officer UI's SKU card shows next to the current decision. Every path that clears a SKU
// saves here (the server's intake, the command line, the recall watch's sweeps and the
// scenario eval), each run labelled with where it came from and whether its decision was
// applied, queued for signature or not applied at all.
//
//   data/runs/<runId>.json     one ClearResult plus `saved`
//   data/runs/index.json       { "<gtin>|<market>": "<latest runId>" }

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REPO_ROOT_URL } from "../config.ts";
import type { ClearResult } from "../pipeline.ts";

export interface RunOrigin {
  /** Which path ran the clearance. */
  source: "server" | "cli" | "watch" | "eval";
  /** true: the HOLD/BLOCK was written; false: nothing written (queued, dry run or eval); null: unknown. */
  applied: boolean | null;
  decision_id?: string | null;
  queue_id?: string | null;
  sweep_id?: string | null;
  /** The replay label when the clearance was an as-of replay. */
  replay?: string | null;
  note?: string;
}

export type SavedRun = ClearResult & { saved?: RunOrigin & { at: string } };

export const RUNS_DIR = fileURLToPath(new URL("data/runs/", REPO_ROOT_URL));

export class RunStore {
  readonly dir: string | null;
  private readonly mem = new Map<string, SavedRun>();
  private readonly idx = new Map<string, string>();

  /** `dir` null keeps runs in memory only (tests). */
  constructor(dir: string | null = RUNS_DIR) {
    this.dir = dir ? dir.replace(/[\\/]$/u, "") : null;
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      this.reloadIndex();
    }
  }

  private get indexPath(): string | null {
    return this.dir ? `${this.dir}/index.json` : null;
  }

  private reloadIndex(): void {
    const p = this.indexPath;
    if (!p || !existsSync(p)) return;
    try {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(p, "utf8")) as Record<string, string>)) this.idx.set(k, v);
    } catch {
      // an unreadable index is rebuilt from the next saves
    }
  }

  private write(path: string, text: string): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  }

  /** Saves the run and makes it the latest for its GTIN and market. */
  save(r: ClearResult, origin: RunOrigin): SavedRun {
    const run: SavedRun = { ...r, saved: { ...origin, at: new Date().toISOString() } };
    this.mem.set(r.run_id, run);
    // Another process (the CLI, the eval) may have saved since this store opened: merge first.
    this.reloadIndex();
    this.idx.set(`${r.gtin}|${r.market}`, r.run_id);
    if (this.dir) {
      this.write(`${this.dir}/${r.run_id}.json`, `${JSON.stringify(run)}\n`);
      this.write(this.indexPath!, `${JSON.stringify(Object.fromEntries(this.idx), null, 1)}\n`);
    }
    return run;
  }

  load(id: string): SavedRun | null {
    const m = this.mem.get(id);
    if (m) return m;
    if (!this.dir) return null;
    const p = `${this.dir}/${id}.json`;
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as SavedRun) : null;
  }

  latestId(gtin: string, market: string): string | null {
    return this.idx.get(`${gtin}|${market}`) ?? null;
  }

  latest(gtin: string, market: string): SavedRun | null {
    const id = this.latestId(gtin, market);
    return id ? this.load(id) : null;
  }

  /** The in-memory runs of this process (tests). */
  get runs(): Map<string, SavedRun> {
    return this.mem;
  }
}
