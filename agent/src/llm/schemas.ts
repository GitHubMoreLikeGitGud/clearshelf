// JSON schemas for every structured Nemotron job, their TypeScript shapes, and a
// small validator for the schema subset we use. Ollama's `format` constrains decoding
// with the same schema, but the host still validates: constrained decoding can stop
// early (num_predict) and an older Ollama build may ignore keywords it does not support.

export type JsonSchema = { [key: string]: unknown };

export const ALLERGEN_GROUPS = [
  "milk",
  "egg",
  "fish",
  "crustacean",
  "mollusc",
  "tree_nut",
  "peanut",
  "gluten_cereal",
  "wheat",
  "soy",
  "sesame",
  "celery",
  "mustard",
  "lupin",
  "sulphite",
  "none",
] as const;
export type AllergenGroup = (typeof ALLERGEN_GROUPS)[number];

export const SPAN_RELATIONS = ["contains", "may_contain", "free_from_claim", "not_allergen"] as const;
export type SpanRelation = (typeof SPAN_RELATIONS)[number];

export const LABEL_LANGUAGES = ["en", "de", "fr", "it", "es", "nl", "pt", "el", "mixed", "unknown"] as const;
export type LabelLanguage = (typeof LABEL_LANGUAGES)[number];

// ---------- Job 1: ingredient extraction ----------

export interface ExtractionSpan {
  evidence_text: string;
  allergen_group: AllergenGroup;
  relation: SpanRelation;
  lang: LabelLanguage;
}
export interface IngredientExtraction {
  spans: ExtractionSpan[];
  label_language: LabelLanguage;
  unparsed_fragments: string[];
}

// evidence_text comes first so the model quotes the text before it classifies it.
export const extractionSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["spans", "label_language", "unparsed_fragments"],
  properties: {
    spans: {
      type: "array",
      // 32 spans fit inside num_predict 1536 even pretty-printed, so a reply that
      // starts repeating itself still closes as valid JSON (seen on a multilingual label).
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidence_text", "allergen_group", "relation", "lang"],
        properties: {
          evidence_text: { type: "string", minLength: 1, maxLength: 160 },
          allergen_group: { enum: [...ALLERGEN_GROUPS] },
          relation: { enum: [...SPAN_RELATIONS] },
          lang: { enum: [...LABEL_LANGUAGES] },
        },
      },
    },
    label_language: { enum: [...LABEL_LANGUAGES] },
    unparsed_fragments: { type: "array", maxItems: 10, items: { type: "string", maxLength: 200 } },
  },
};

// ---------- Job 2: notice extraction ----------

export const NOTICE_ALLERGENS = ALLERGEN_GROUPS.filter((g) => g !== "none");
export const REASON_TYPES = ["undeclared_allergen", "other"] as const;

export interface NoticeExtraction {
  product_names: string[];
  brands: string[];
  upcs: string[];
  lots: string[];
  allergens: Exclude<AllergenGroup, "none">[];
  reason_type: (typeof REASON_TYPES)[number];
}

export const noticeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["product_names", "brands", "upcs", "lots", "allergens", "reason_type"],
  properties: {
    product_names: { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 200 } },
    brands: { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 80 } },
    upcs: { type: "array", maxItems: 30, items: { type: "string", pattern: "^[0-9]{8,14}$" } },
    lots: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 40 } },
    allergens: { type: "array", maxItems: 15, items: { enum: [...NOTICE_ALLERGENS] } },
    reason_type: { enum: [...REASON_TYPES] },
  },
};

// ---------- Job 3: planner (one Markovian step) ----------

export const SKU_CHECKLIST = [
  "product_fetched",
  "guard_scanned",
  "ingredients_extracted",
  "verifier_run",
  "recall_check_gtin",
  "recall_check_brand",
  "dq_checked",
  "memory_checked",
  "policy_proposed",
] as const;

export const SWEEP_CHECKLIST = [
  "notice_parsed",
  "gtin_matches_checked",
  "name_candidates_checked",
  "memory_checked",
  "actions_proposed",
  "recheck_cleared_vs_new_recalls",
] as const;

export type ChainKind = "sku" | "sweep";

export const TOOL_NAMES = [
  "zetaris.product",
  "zetaris.declared",
  "zetaris.recalls_by_gtin",
  "zetaris.recalls_by_name",
  "zetaris.fsa_recent",
  "zetaris.fsa_allergens",
  "zetaris.market_list",
  "zetaris.prior_decisions",
  "zetaris.dq_gate",
  "zetaris.recheck_cleared",
  "extract.ingredients",
  "extract.notice",
  "memory.recall",
  "world.lookup",
  "registrar.register_off",
  "policy.propose",
  "draft.supplier_query",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface PlannerAction {
  tool: ToolName;
  input: {
    gtin?: string;
    market?: "UK" | "US";
    notice_id?: string;
    brand?: string;
    name?: string;
    query?: string;
    since?: string;
  };
}
export interface PlannerState {
  sku?: string;
  notice?: string;
  hypotheses: string[];
  evidence_ids: string[];
  open_contradictions: string[];
  checklist: Record<string, boolean>;
  next: string;
}
export interface PlannerOutput {
  thought: string;
  action: PlannerAction | null;
  state: PlannerState;
  done: boolean;
}

export const THOUGHT_MAX_WORDS = 60;

const plannerInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    gtin: { type: "string", pattern: "^[0-9]{13}$" },
    market: { enum: ["UK", "US"] },
    notice_id: { type: "string", maxLength: 24 },
    brand: { type: "string", maxLength: 40 },
    name: { type: "string", maxLength: 80 },
    query: { type: "string", maxLength: 120 },
    since: { type: "string", maxLength: 10 },
  },
};

/**
 * Builds the planner schema for one chunk. `tools` is the dynamic enum: only the
 * tools the host will accept at this point of the chain. `evidenceIds` is the same
 * idea for citations: the model can only cite ids the host has recorded.
 */
export function plannerSchema(chain: ChainKind, tools: readonly string[], evidenceIds: readonly string[] = []): JsonSchema {
  if (tools.length === 0) throw new Error("plannerSchema: at least one tool is required");
  for (const t of tools) {
    if (!(TOOL_NAMES as readonly string[]).includes(t)) throw new Error(`plannerSchema: unknown tool ${t}`);
  }
  const items = chain === "sku" ? SKU_CHECKLIST : SWEEP_CHECKLIST;
  const subjectKey = chain === "sku" ? "sku" : "notice";
  const checklistProps: Record<string, JsonSchema> = {};
  for (const item of items) checklistProps[item] = { type: "boolean" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["thought", "action", "state", "done"],
    properties: {
      thought: { type: "string", minLength: 1, maxLength: 420 },
      action: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["tool", "input"],
            properties: { tool: { enum: [...tools] }, input: plannerInputSchema },
          },
          { type: "null" },
        ],
      },
      state: {
        type: "object",
        additionalProperties: false,
        required: [subjectKey, "hypotheses", "evidence_ids", "open_contradictions", "checklist", "next"],
        properties: {
          [subjectKey]: { type: "string", minLength: 1, maxLength: 40 },
          hypotheses: { type: "array", maxItems: 5, items: { type: "string", maxLength: 200 } },
          evidence_ids:
            evidenceIds.length > 0
              ? { type: "array", maxItems: evidenceIds.length, items: { enum: [...evidenceIds] } }
              : { type: "array", maxItems: 0, items: { type: "string" } },
          open_contradictions: { type: "array", maxItems: 6, items: { type: "string", maxLength: 240 } },
          checklist: {
            type: "object",
            additionalProperties: false,
            required: [...items],
            properties: checklistProps,
          },
          next: { type: "string", maxLength: 240 },
        },
      },
      done: { type: "boolean" },
    },
  };
}

// ---------- Job 4: adjudication brief ----------

export interface AdjudicationBrief {
  brief: string;
  escalate_to: "HOLD" | "BLOCK" | null;
}

export const briefSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["brief", "escalate_to"],
  properties: {
    brief: { type: "string", minLength: 1, maxLength: 1200 },
    escalate_to: { anyOf: [{ enum: ["HOLD", "BLOCK"] }, { type: "null" }] },
  },
};

// ---------- Job 5: H-MEM minerFn ----------

// The vendored H-MEM reference parses the miner's reply with parseStrictJsonArray,
// so the miner returns a bare JSON array of short memory statements.
export const minerSchema: JsonSchema = {
  type: "array",
  maxItems: 12,
  items: { type: "string", minLength: 1, maxLength: 300 },
};

// ---------- Validator (the subset of JSON Schema used above) ----------

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === "number") return actual === "number" || actual === "integer";
  return actual === t;
}

/** Returns a list of error strings; an empty list means the value is valid. */
export function validate(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as JsonSchema[];
    const ok = branches.some((b) => validate(b, value, path).length === 0);
    if (!ok) errors.push(`${path}: matches no allowed shape`);
    return errors;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join("|")}, got ${typeOf(value)}`);
      return errors;
    }
  }

  if (Array.isArray(schema.enum)) {
    if (!(schema.enum as unknown[]).some((e) => e === value)) {
      errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
      return errors;
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern as string, "u").test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, i) => errors.push(...validate(schema.items as JsonSchema, item, `${path}[${i}]`)));
    }
  }

  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in obj)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, v] of Object.entries(obj)) {
      if (key in props) {
        errors.push(...validate(props[key], v, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validate(schema.additionalProperties as JsonSchema, v, `${path}.${key}`));
      }
    }
  }

  return errors;
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/u).length;
}

/** Semantic checks the schema cannot express. */
export function plannerSemanticErrors(out: PlannerOutput): string[] {
  const errors: string[] = [];
  if (wordCount(out.thought) > THOUGHT_MAX_WORDS) errors.push(`thought: more than ${THOUGHT_MAX_WORDS} words`);
  if (out.done && out.action !== null) errors.push("done is true but an action is set");
  return errors;
}
