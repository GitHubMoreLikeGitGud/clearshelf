// What the planner is told about each tool, which checklist items each tool
// completes, and the dynamic tool enum for a chunk. The host runs the tools; this
// file only describes them to the model.

import { SKU_CHECKLIST, SWEEP_CHECKLIST, type ChainKind, type ToolName } from "./schemas.ts";
import type { ToolSpec } from "./prompts.ts";

interface CatalogEntry {
  description: string;
  input: string;
  inputKey: "gtin" | "notice_id" | "brand" | "name" | "query" | "since" | "market" | null;
  completes: { sku: string[]; sweep: string[] };
}

export const TOOL_CATALOG: Partial<Record<ToolName, CatalogEntry>> = {
  "zetaris.product": {
    description: "Read the product row (name, brand, language, labels, whether ingredient text exists) from the Zetaris model; the host scans its text for injection on read.",
    input: "gtin",
    inputKey: "gtin",
    completes: { sku: ["product_fetched", "guard_scanned"], sweep: ["gtin_matches_checked"] },
  },
  "zetaris.declared": {
    description: "Read the allergens the product data declares for the GTIN.",
    input: "gtin",
    inputKey: "gtin",
    completes: { sku: [], sweep: [] },
  },
  "zetaris.recalls_by_gtin": {
    description: "Find FDA recalls linked to this exact GTIN.",
    input: "gtin",
    inputKey: "gtin",
    completes: { sku: ["recall_check_gtin"], sweep: ["gtin_matches_checked"] },
  },
  "zetaris.recalls_by_name": {
    description: "Search FDA recall firms and descriptions and FSA alert titles by brand token.",
    input: "brand (lowercase words)",
    inputKey: "brand",
    completes: { sku: ["recall_check_brand"], sweep: ["name_candidates_checked"] },
  },
  "zetaris.fsa_recent": {
    description: "List recent FSA allergy alerts.",
    input: "since (YYYY-MM-DD)",
    inputKey: "since",
    completes: { sku: [], sweep: [] },
  },
  "zetaris.fsa_allergens": {
    description: "Read the allergens and products listed on one FSA alert.",
    input: "notice_id",
    inputKey: "notice_id",
    completes: { sku: [], sweep: ["notice_parsed"] },
  },
  "zetaris.market_list": {
    description: "Read the market's statutory allergen list with citations.",
    input: "market",
    inputKey: "market",
    completes: { sku: [], sweep: [] },
  },
  "zetaris.prior_decisions": {
    description: "Read earlier clearance decisions for a GTIN.",
    input: "gtin",
    inputKey: "gtin",
    completes: { sku: [], sweep: ["gtin_matches_checked"] },
  },
  "zetaris.dq_gate": {
    description: "Run the Zetaris data-quality gate for the GTIN and list invalid records.",
    input: "gtin",
    inputKey: "gtin",
    completes: { sku: ["dq_checked"], sweep: [] },
  },
  "zetaris.recheck_cleared": {
    description: "Re-check every cleared catalogue SKU against all recalls (closed loop).",
    input: "none",
    inputKey: null,
    completes: { sku: [], sweep: ["recheck_cleared_vs_new_recalls"] },
  },
  "extract.ingredients": {
    description: "Read the product's ingredient text with Nemotron, then run the lexicon verifier and return the agreement table.",
    input: "gtin",
    inputKey: "gtin",
    completes: { sku: ["ingredients_extracted", "verifier_run"], sweep: [] },
  },
  "extract.notice": {
    description: "Parse one FDA notice (UPCs, allergens, lots), check UPC digits and link it to catalogue GTINs.",
    input: "notice_id",
    inputKey: "notice_id",
    completes: { sku: [], sweep: ["notice_parsed"] },
  },
  "memory.recall": {
    description: "Retrieve officer rulings, approved invariants and source notes from memory.",
    input: "query",
    inputKey: "query",
    completes: { sku: ["memory_checked"], sweep: ["memory_checked"] },
  },
  "world.lookup": {
    description: "Look up a brand, firm or product name in the catalogue graph; returns candidate products with match scores.",
    input: "name",
    inputKey: "name",
    completes: { sku: [], sweep: ["name_candidates_checked"] },
  },
  "policy.propose": {
    description: "Run the deterministic decision policy for the subject and record its proposal.",
    input: "gtin and market for a SKU, notice_id for a sweep",
    inputKey: null,
    completes: { sku: ["policy_proposed"], sweep: ["actions_proposed"] },
  },
  "draft.supplier_query": {
    description: "Draft a supplier query from a template (never sent).",
    input: "gtin",
    inputKey: "gtin",
    completes: { sku: [], sweep: [] },
  },
};

const SKU_TOOLS: ToolName[] = [
  "zetaris.product",
  "zetaris.declared",
  "zetaris.recalls_by_gtin",
  "zetaris.recalls_by_name",
  "zetaris.market_list",
  "zetaris.prior_decisions",
  "zetaris.dq_gate",
  "extract.ingredients",
  "memory.recall",
  "world.lookup",
  "policy.propose",
  "draft.supplier_query",
];

const SWEEP_TOOLS: ToolName[] = [
  "extract.notice",
  "zetaris.fsa_allergens",
  "zetaris.product",
  "zetaris.prior_decisions",
  "zetaris.recalls_by_gtin",
  "zetaris.recalls_by_name",
  "world.lookup",
  "memory.recall",
  "policy.propose",
  "zetaris.recheck_cleared",
];

export function checklistItems(chain: ChainKind): readonly string[] {
  return chain === "sku" ? SKU_CHECKLIST : SWEEP_CHECKLIST;
}

/** The dynamic enum: tools the host accepts for this chunk, given the checklist. */
export function allowedTools(chain: ChainKind, checklist: Record<string, boolean>, noticeSource?: "fda" | "fsa"): ToolName[] {
  if (chain === "sku") {
    const othersDone = SKU_CHECKLIST.filter((i) => i !== "policy_proposed").every((i) => checklist[i]);
    return SKU_TOOLS.filter((t) => {
      if (t === "extract.ingredients") return checklist.product_fetched === true;
      if (t === "policy.propose") return othersDone;
      return true;
    });
  }
  const beforeActions = ["notice_parsed", "gtin_matches_checked", "name_candidates_checked", "memory_checked"];
  return SWEEP_TOOLS.filter((t) => {
    if (t === "extract.notice") return noticeSource !== "fsa";
    if (t === "zetaris.fsa_allergens") return noticeSource === "fsa";
    if (t === "policy.propose") return beforeActions.every((i) => checklist[i]);
    if (t === "zetaris.recheck_cleared") return checklist.actions_proposed === true;
    return true;
  });
}

export function toolSpecs(chain: ChainKind, tools: readonly ToolName[]): ToolSpec[] {
  return tools.map((name) => {
    const entry = TOOL_CATALOG[name];
    if (!entry) throw new Error(`no catalog entry for ${name}`);
    return { name, description: entry.description, input: entry.input, completes: entry.completes[chain] };
  });
}

/** Checklist items a tool call would complete in this chain. */
export function completedBy(chain: ChainKind, tool: ToolName): string[] {
  return TOOL_CATALOG[tool]?.completes[chain] ?? [];
}
