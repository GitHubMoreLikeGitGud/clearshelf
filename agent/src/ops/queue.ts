// The officer's approval queue (data/approvals/queue.json, runtime state, not served to
// Zetaris). It holds what the agent may not do alone: proposed CLEAR and
// CLEAR_WITH_STATEMENT decisions (pending a signed approval) and name-only recall matches
// (review items that change no status). The server, the recall watch and the CLI share it;
// writes are atomic.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REPO_ROOT_URL } from "../config.ts";
import type { Decision, Market } from "../policy/decide.ts";

export type QueueKind = "proposal" | "name_match";
export type QueueState = "pending" | "approved" | "rejected" | "executed" | "superseded";

export interface QueueItem {
  id: string;
  kind: QueueKind;
  state: QueueState;
  gtin: string;
  market: Market;
  /** proposal: the policy's proposed status; name_match: the status the SKU would be held at if the officer confirms. */
  status: Decision;
  statement: string | null;
  summary: string;
  reasons: string[];
  evidence_ids: string[];
  run_id: string;
  source: "clear" | "sweep";
  notice_id?: string;
  similarity?: number;
  replay: { as_of: string; banner: string } | null;
  /** proposal: the decision row that was current for the SKU when the proposal was made ("" for none). */
  over_decision?: string;
  created_at: string;
  updated_at: string;
  resolution?: { by: string; reason: string; contract_id?: string; decision_id?: string; at: string };
}

export class ApprovalQueue {
  readonly path: string;

  constructor(dir: string = fileURLToPath(new URL("data/approvals/", REPO_ROOT_URL))) {
    mkdirSync(dir, { recursive: true });
    this.path = `${dir.replace(/[\\/]$/u, "")}/queue.json`;
  }

  all(): QueueItem[] {
    if (!existsSync(this.path)) return [];
    const doc = JSON.parse(readFileSync(this.path, "utf8")) as { items?: QueueItem[] };
    return Array.isArray(doc.items) ? doc.items : [];
  }

  pending(): QueueItem[] {
    return this.all().filter((i) => i.state === "pending");
  }

  get(id: string): QueueItem | undefined {
    return this.all().find((i) => i.id === id);
  }

  private save(items: QueueItem[]): void {
    const tmp = `${this.path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ items }, null, 1)}\n`, "utf8");
    renameSync(tmp, this.path);
  }

  /**
   * Adds an item. A newer proposal for the same gtin and market supersedes an older pending
   * one; a name match already pending for the same notice and SKU is not added twice.
   */
  add(item: Omit<QueueItem, "id" | "state" | "created_at" | "updated_at">): QueueItem {
    const items = this.all();
    const now = new Date().toISOString();
    if (item.kind === "name_match") {
      const dup = items.find((i) => i.kind === "name_match" && i.state === "pending" && i.gtin === item.gtin && i.market === item.market && i.notice_id === item.notice_id);
      if (dup) return dup;
    } else {
      for (const i of items) {
        if (i.kind === "proposal" && i.state === "pending" && i.gtin === item.gtin && i.market === item.market) {
          i.state = "superseded";
          i.updated_at = now;
        }
      }
    }
    const full: QueueItem = { ...item, id: `q-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, state: "pending", created_at: now, updated_at: now };
    items.push(full);
    this.save(items);
    return full;
  }

  resolve(id: string, state: Exclude<QueueState, "pending">, resolution: Omit<NonNullable<QueueItem["resolution"]>, "at">): QueueItem {
    const items = this.all();
    const it = items.find((i) => i.id === id);
    if (!it) throw new Error(`no queue item ${id}`);
    it.state = state;
    it.updated_at = new Date().toISOString();
    it.resolution = { ...resolution, at: it.updated_at };
    this.save(items);
    return it;
  }

  /**
   * A HOLD or BLOCK written after a proposal outranks it: every pending proposal for the
   * SKU and market is marked superseded, so it can no longer be signed. Returns those items.
   */
  supersedeProposals(gtin: string, market: Market, by: { decision_id: string; status: string; reason: string }): QueueItem[] {
    const items = this.all();
    const now = new Date().toISOString();
    const out: QueueItem[] = [];
    for (const i of items) {
      if (i.kind !== "proposal" || i.state !== "pending" || i.gtin !== gtin || i.market !== market) continue;
      i.state = "superseded";
      i.updated_at = now;
      i.resolution = { by: "clearshelf-agent", reason: `superseded by ${by.status} ${by.decision_id}: ${by.reason}`.slice(0, 400), decision_id: by.decision_id, at: now };
      out.push(i);
    }
    if (out.length) this.save(items);
    return out;
  }

  /** The pending proposal for a SKU and market, if any. */
  proposalFor(gtin: string, market: Market): QueueItem | undefined {
    return this.pending().find((i) => i.kind === "proposal" && i.gtin === gtin && i.market === market);
  }
}
