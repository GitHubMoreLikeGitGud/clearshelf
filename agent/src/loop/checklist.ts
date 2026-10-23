// The checklist of required checks for one investigation, owned by the host. The model
// sees it but never changes it: a tool result resolves an item, and the deterministic
// fallback step is always "the tool for the first open item". Items can be added while
// the chain runs (a recall linked to the GTIN adds `notices_parsed`), so the checks a
// SKU needs depend on what the earlier checks found.
//
// Status of an item:
//   pending      not done yet
//   done         a tool completed it (evidence ids attached)
//   na           does not apply to this SKU (no product row, no ingredient text, no brand token)
//   unavailable  the component is not wired in this build (recorded as a gap, never silently passed)
//   failed       the tool failed twice; the policy holds the SKU (R0)

import type { ToolName } from "../llm/schemas.ts";

export type ItemStatus = "pending" | "done" | "na" | "unavailable" | "failed";

export interface ItemDef {
  id: string;
  /** What the check establishes, in a few words (shown to the model and on the timeline). */
  label: string;
  /** Tools that can complete it; the first one is the fallback step. */
  tools: ToolName[];
}

export interface ChecklistItem extends ItemDef {
  status: ItemStatus;
  note: string | null;
  evidenceIds: string[];
  /** Failed tool attempts so far; the second failure resolves the item as failed. */
  failures: number;
}

/**
 * Required checks for SKU clearance (SPEC 7.1), in the order the fallback works through
 * them. `declared_checked` is a ClearShelf refinement: the declared allergen tags feed the
 * source-against-source checks, so the policy must not run before they are read.
 * `notices_parsed` is added only when the exact-GTIN recall check finds linked recalls.
 */
export const SKU_ITEMS: readonly ItemDef[] = [
  // At intake a missing row may be registered first (registrar.register_off), then read again.
  { id: "product_fetched", label: "product row read from the Zetaris model", tools: ["zetaris.product", "registrar.register_off"] },
  { id: "guard_scanned", label: "untrusted product text scanned for injection", tools: ["zetaris.product"] },
  { id: "declared_checked", label: "declared allergen tags read", tools: ["zetaris.declared"] },
  { id: "ingredients_extracted", label: "ingredient text read by Nemotron", tools: ["extract.ingredients"] },
  { id: "verifier_run", label: "lexicon verifier run on the extraction", tools: ["extract.ingredients"] },
  { id: "recall_check_gtin", label: "FDA recalls linked to this exact GTIN checked", tools: ["zetaris.recalls_by_gtin"] },
  { id: "recall_check_brand", label: "FDA and FSA notices naming the brand checked", tools: ["zetaris.recalls_by_name"] },
  { id: "dq_checked", label: "Zetaris DQ gate run for the GTIN", tools: ["zetaris.dq_gate"] },
  { id: "memory_checked", label: "earlier decisions and memory checked", tools: ["memory.recall"] },
  { id: "policy_proposed", label: "deterministic policy decision proposed", tools: ["policy.propose"] },
];

export const NOTICES_PARSED: ItemDef = {
  id: "notices_parsed",
  label: "every linked FDA notice parsed and its UPCs checked",
  tools: ["extract.notice"],
};

/** The item that must be last; it may run only when every other item is resolved. */
export const FINAL_ITEM = "policy_proposed";

export class Checklist {
  private readonly items: ChecklistItem[];

  constructor(defs: readonly ItemDef[]) {
    this.items = defs.map((d) => ({ ...d, tools: [...d.tools], status: "pending", note: null, evidenceIds: [], failures: 0 }));
  }

  static sku(): Checklist {
    return new Checklist(SKU_ITEMS);
  }

  all(): readonly ChecklistItem[] {
    return this.items;
  }

  has(id: string): boolean {
    return this.items.some((i) => i.id === id);
  }

  get(id: string): ChecklistItem {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error(`checklist has no item ${id}`);
    return item;
  }

  /** Adds an item before `beforeId` (or at the end); a no-op when it is already there. */
  add(def: ItemDef, beforeId?: string): void {
    if (this.has(def.id)) return;
    const item: ChecklistItem = { ...def, tools: [...def.tools], status: "pending", note: null, evidenceIds: [], failures: 0 };
    const at = beforeId ? this.items.findIndex((i) => i.id === beforeId) : -1;
    if (at < 0) this.items.push(item);
    else this.items.splice(at, 0, item);
  }

  set(id: string, status: ItemStatus, note: string | null = null, evidenceIds: string[] = []): void {
    const item = this.get(id);
    item.status = status;
    item.note = note;
    if (evidenceIds.length) item.evidenceIds = [...new Set([...item.evidenceIds, ...evidenceIds])];
  }

  /** Records a failed attempt; the second failure resolves the item as failed. Returns the new status. */
  fail(id: string, error: string): ItemStatus {
    const item = this.get(id);
    item.failures += 1;
    if (item.failures >= 2) {
      item.status = "failed";
      item.note = error;
    } else {
      item.note = `attempt ${item.failures} failed: ${error}`;
    }
    return item.status;
  }

  isResolved(id: string): boolean {
    return this.get(id).status !== "pending";
  }

  pending(): ChecklistItem[] {
    return this.items.filter((i) => i.status === "pending");
  }

  /** Every item except the final one is resolved, so the policy may run. */
  readyForFinal(): boolean {
    return this.items.every((i) => i.id === FINAL_ITEM || i.status !== "pending");
  }

  /** Every item is resolved and the final item is done. */
  complete(): boolean {
    return this.items.every((i) => i.status !== "pending") && (!this.has(FINAL_ITEM) || this.get(FINAL_ITEM).status === "done");
  }

  /** The first open item, in checklist order: what the deterministic fallback step works on. */
  firstPending(): ChecklistItem | undefined {
    return this.items.find((i) => i.status === "pending" && (i.id !== FINAL_ITEM || this.readyForFinal()));
  }

  /** The model's view: resolved items are true. */
  booleans(): Record<string, boolean> {
    return Object.fromEntries(this.items.map((i) => [i.id, i.status !== "pending"]));
  }

  /** Compact status for the carryover state: "done", "todo", or the status with its note. */
  compact(): Record<string, string> {
    return Object.fromEntries(
      this.items.map((i) => {
        if (i.status === "pending") return [i.id, i.failures ? `todo (${i.note ?? "retry"})`.slice(0, 90) : "todo"];
        if (i.status === "done") return [i.id, "done"];
        return [i.id, `${i.status === "na" ? "n/a" : i.status}: ${i.note ?? ""}`.slice(0, 90)];
      }),
    );
  }

  /** Lines explaining the items that are resolved without being done. */
  notes(): string[] {
    return this.items.filter((i) => i.status !== "pending" && i.status !== "done").map((i) => `${i.id} ${i.status === "na" ? "n/a" : i.status}: ${i.note ?? ""}`);
  }

  /** Items that ended unavailable or failed: they are reported as gaps on the card. */
  unresolvedGaps(): ChecklistItem[] {
    return this.items.filter((i) => i.status === "unavailable" || i.status === "failed" || i.status === "pending");
  }

  snapshot(): Array<Pick<ChecklistItem, "id" | "status" | "note" | "evidenceIds">> {
    return this.items.map((i) => ({ id: i.id, status: i.status, note: i.note, evidenceIds: [...i.evidenceIds] }));
  }
}
