// G8 bench cases. Source texts are NOT stored here: Open Food Facts ingredient text
// must not be committed, so the bench reads the texts from data/bench/ (gitignored),
// fetched once at dev time. This file holds only identifiers and what each text
// plainly says, read by hand from the fetched text and kept deliberately literal.
//
// Scoring treats wheat and gluten_cereal as one group (wheat is a gluten cereal and
// the prompt asks for wheat where the text names it). "optional" groups are neither
// rewarded nor penalised because the text is ambiguous about them.

import type { AllergenGroup, ChainKind } from "./schemas.ts";

export interface IngredientCase {
  id: string;
  gtin: string;
  lang: string;
  contains: AllergenGroup[];
  may_contain: AllergenGroup[];
  optional: AllergenGroup[];
  /** Words in the text that look like allergens but are not. */
  traps: string[];
  note: string;
}

export const INGREDIENT_CASES: IngredientCase[] = [
  {
    id: "off:4056489125846",
    gtin: "4056489125846",
    lang: "fr",
    contains: ["gluten_cereal", "milk", "soy"],
    may_contain: [],
    optional: ["egg", "tree_nut"],
    traps: ["coco"],
    note: "Lidl shortbread (H-1275-2026). Mostly French, with label boilerplate in five languages mixed in. Egg appears only as a scanning error before '***'; coconut is the FDA/Edition 5 rule conflict.",
  },
  {
    id: "off:4088600132334",
    gtin: "4088600132334",
    lang: "en",
    contains: [],
    may_contain: [],
    optional: [],
    traps: ["cocoa butter", "lecithins"],
    note: "UK 85% dark chocolate. Cocoa butter, and an emulsifier with no source named.",
  },
  {
    id: "off:5011835104028",
    gtin: "5011835104028",
    lang: "en",
    contains: ["soy"],
    may_contain: [],
    optional: [],
    traps: ["cocoa butter"],
    note: "UK dark chocolate with coffee; soya lecithin with underscores marking the allergen.",
  },
  {
    id: "off:5011835100624",
    gtin: "5011835100624",
    lang: "en",
    contains: ["soy"],
    may_contain: ["tree_nut", "milk"],
    optional: [],
    traps: ["cocoa butter"],
    note: "UK 60% dark chocolate: cocoa butter plus 'MAY CONTAIN NUTS, MILK' (scenario E5 shape).",
  },
  {
    id: "off:4014051000427",
    gtin: "4014051000427",
    lang: "de",
    contains: ["gluten_cereal", "milk", "soy", "egg"],
    may_contain: ["tree_nut"],
    optional: [],
    traps: [],
    note: "German butter biscuits; text includes scanned nutrition-panel noise and a precautionary nut statement.",
  },
  {
    id: "off:4014051002193",
    gtin: "4014051002193",
    lang: "de",
    contains: ["gluten_cereal", "milk", "soy"],
    may_contain: [],
    optional: [],
    traps: [],
    note: "German spelt butter biscuits.",
  },
  {
    id: "off:20042905",
    gtin: "20042905",
    lang: "fr",
    contains: ["gluten_cereal", "milk"],
    may_contain: [],
    optional: [],
    traps: [],
    note: "French petit beurre.",
  },
  {
    id: "off:8076809500302",
    gtin: "8076809500302",
    lang: "it",
    contains: ["gluten_cereal", "milk", "soy", "egg", "tree_nut"],
    may_contain: [],
    optional: [],
    traps: ["burro di cacao"],
    note: "Italian cocoa biscuits with hazelnuts; cocoa butter inside the chocolate sub-list.",
  },
  {
    id: "off:8003170062030",
    gtin: "8003170062030",
    lang: "it",
    contains: ["gluten_cereal", "egg", "milk", "tree_nut"],
    may_contain: [],
    optional: [],
    traps: ["girasole"],
    note: "Italian shortbread; emulsifier is sunflower lecithin (not soy).",
  },
  {
    id: "off:8076809536721",
    gtin: "8076809536721",
    lang: "en",
    contains: ["gluten_cereal", "milk", "egg", "tree_nut"],
    may_contain: [],
    optional: [],
    traps: [],
    note: "Italian biscuits, English translation with garbled words; almonds and apricot kernels.",
  },
];

export interface NoticeCase {
  id: string;
  recall_number: string;
  /** Digits as they appear in the notice, spaces removed; not filtered by check digit. */
  upcs: string[];
  allergens: AllergenGroup[];
  lots: string[];
  reason_type: "undeclared_allergen" | "other";
  note: string;
}

export const NOTICE_CASES: NoticeCase[] = [
  { id: "fda:H-1328-2026", recall_number: "H-1328-2026", upcs: ["816929000119"], allergens: ["milk"], lots: [], reason_type: "undeclared_allergen", note: "Frankie's puffs, milk found by testing." },
  { id: "fda:H-0011-2027", recall_number: "H-0011-2027", upcs: ["850041392103"], allergens: ["milk"], lots: ["26078"], reason_type: "undeclared_allergen", note: "Donutful; UPC repeated; firm address inside the description." },
  { id: "fda:H-1275-2026", recall_number: "H-1275-2026", upcs: ["4056489125846"], allergens: ["gluten_cereal", "soy", "milk", "egg", "tree_nut"], lots: ["260315"], reason_type: "undeclared_allergen", note: "Lidl; notice itself says 'tree nut (coconut)'." },
  { id: "fda:H-1335-2026", recall_number: "H-1335-2026", upcs: ["50040360530"], allergens: ["tree_nut"], lots: ["L2755"], reason_type: "undeclared_allergen", note: "UPC printed with 11 digits (fails the check digit; the host drops it)." },
  { id: "fda:H-1198-2026", recall_number: "H-1198-2026", upcs: ["8809342366186"], allergens: ["gluten_cereal", "soy", "sesame"], lots: [], reason_type: "undeclared_allergen", note: "UPC printed with spaces; colours listed beside allergens." },
  { id: "fda:H-1325-2026", recall_number: "H-1325-2026", upcs: [], allergens: [], lots: [], reason_type: "other", note: "Colour only (FD&C Red No. 40)." },
  { id: "fda:H-0016-2027", recall_number: "H-0016-2027", upcs: ["7708075247094"], allergens: [], lots: ["F090824LN16", "F170325LN19", "300326LN28"], reason_type: "other", note: "Drug adulteration, not an allergen; three lots." },
  {
    id: "fda:H-1172-2026",
    recall_number: "H-1172-2026",
    upcs: [
      "827912008593", "710594511867", "710594511850", "710594511560", "827912008456", "8279120084732",
      "710594511829", "71059511812", "827912008487", "827912008548", "710594511836", "827912008531",
      "827912008494", "827912008449", "710594511362", "710594511225",
    ],
    allergens: ["milk", "tree_nut"],
    lots: [],
    reason_type: "undeclared_allergen",
    note: "Sixteen codes in code_info, two of them malformed; precautionary wording ('may contain undeclared').",
  },
  { id: "fda:H-0941-2026", recall_number: "H-0941-2026", upcs: ["099482502065"], allergens: ["crustacean"], lots: ["1762181"], reason_type: "undeclared_allergen", note: "Shrimp; a 6-digit case code that is not a UPC." },
  { id: "fda:H-1383-2026", recall_number: "H-1383-2026", upcs: [], allergens: ["sulphite"], lots: [], reason_type: "undeclared_allergen", note: "Sulfites in coconut flakes; a ZIP code that is not a UPC." },
];

// Planner cases are CONSTRUCTED investigation states (synthetic bench input). The
// product fields, FDA/FSA rows and counts quoted in the summaries come from the
// fetched records; the tool results around them (guard and verifier outcomes, DQ
// invalid records, "no officer rulings", FSA counts by brand, policy proposals) were
// written by hand to put the planner at each checklist step, because no pipeline
// existed yet. Only 3 FSA alerts were fetched, so "0 FSA alerts" for a brand is part
// of the constructed state, not a search result.
export interface PlannerCase {
  id: string;
  chain: ChainKind;
  subject: string;
  market?: "UK" | "US";
  noticeSource?: "fda" | "fsa";
  checklist: Record<string, boolean>;
  evidence: Array<{ id: string; tool: string; summary: string }>;
  memory: string[];
  /** Expected identifier in action.input for the tool's key (substring match for names). */
  expectInput: { gtin?: string; notice_id?: string; nameToken?: string };
  expectContradiction: boolean;
}

const SKU_FALSE = {
  product_fetched: false,
  guard_scanned: false,
  ingredients_extracted: false,
  verifier_run: false,
  recall_check_gtin: false,
  recall_check_brand: false,
  dq_checked: false,
  memory_checked: false,
  policy_proposed: false,
};
const SWEEP_FALSE = {
  notice_parsed: false,
  gtin_matches_checked: false,
  name_candidates_checked: false,
  memory_checked: false,
  actions_proposed: false,
  recheck_cleared_vs_new_recalls: false,
};

const SOURCE_NOTES = [
  "source note: FSA alerts carry no GTIN, so they match by name only",
  "source note: openFDA coverage is the latest 1,000 'undeclared' reports",
  "source note: FDA Q&A Edition 5 removed coconut from the tree-nut list",
];

const PUFFS_PRODUCT =
  "Frankie's Organic Plant-Based Puffs Vegan Cheddar; brand Frankie's; label language fr; labels en:vegan, en:vegan-action; declared allergens: none; ingredient text: absent";
const PUFFS_RECALL =
  "1 row: H-1328-2026, Class I, status Terminated, reported 2026-09-09, firm Marina Del Rey Foods inc., reason 'Product tested positive for undeclared milk.'";
const LIDL_PRODUCT =
  "Aprikosenkekse mit Kokosraspeln (Lidl); label language de; ingredient text present (997 characters, mostly French with packaging text in other languages); declared allergens: gluten, milk, soybeans";
const LIDL_EXTRACTION =
  "spans: wheat contains (fr), milk contains (fr), soy contains (fr), coconut not_allergen; verifier agrees on wheat, milk and soy; 1 unparsed fragment next to '3%' that may hide egg";
const LIDL_RECALL =
  "1 row: H-1275-2026, Class II, status Ongoing, reported 2026-09-02, firm Lidl US TRADING, reason 'The firm discovered that certain units shipped to the U.S. retail stores only has \"foreign languages\" on the label. Product has undeclared wheat, soy, milk, eggs and tree nut (coconut).'";

export const PLANNER_CASES: PlannerCase[] = [
  {
    id: "plan:sku-puffs-start",
    chain: "sku",
    subject: "0816929000119",
    market: "UK",
    checklist: { ...SKU_FALSE },
    evidence: [],
    memory: SOURCE_NOTES,
    expectInput: { gtin: "0816929000119" },
    expectContradiction: false,
  },
  {
    id: "plan:sku-puffs-fetched",
    chain: "sku",
    subject: "0816929000119",
    market: "UK",
    checklist: { ...SKU_FALSE, product_fetched: true, guard_scanned: true, ingredients_extracted: true, verifier_run: true },
    evidence: [
      { id: "ev-p2-01", tool: "zetaris.product", summary: PUFFS_PRODUCT },
      { id: "ev-p2-02", tool: "extract.ingredients", summary: "skipped by host: the source has no ingredient text; claim tester UNTESTED" },
    ],
    memory: SOURCE_NOTES,
    expectInput: { gtin: "0816929000119" },
    expectContradiction: false,
  },
  {
    id: "plan:sku-puffs-recall-found",
    chain: "sku",
    subject: "0816929000119",
    market: "UK",
    checklist: { ...SKU_FALSE, product_fetched: true, guard_scanned: true, ingredients_extracted: true, verifier_run: true, recall_check_gtin: true },
    evidence: [
      { id: "ev-p3-01", tool: "zetaris.product", summary: PUFFS_PRODUCT },
      { id: "ev-p3-02", tool: "extract.ingredients", summary: "skipped by host: the source has no ingredient text; claim tester UNTESTED" },
      { id: "ev-p3-03", tool: "zetaris.recalls_by_gtin", summary: PUFFS_RECALL },
    ],
    memory: SOURCE_NOTES,
    expectInput: { nameToken: "frankie" },
    expectContradiction: true,
  },
  {
    id: "plan:sku-lidl-us-fetched",
    chain: "sku",
    subject: "4056489125846",
    market: "US",
    checklist: { ...SKU_FALSE, product_fetched: true, guard_scanned: true },
    evidence: [{ id: "ev-p4-01", tool: "zetaris.product", summary: LIDL_PRODUCT }],
    memory: SOURCE_NOTES,
    expectInput: { gtin: "4056489125846" },
    expectContradiction: false,
  },
  {
    id: "plan:sku-lidl-us-extracted",
    chain: "sku",
    subject: "4056489125846",
    market: "US",
    checklist: { ...SKU_FALSE, product_fetched: true, guard_scanned: true, ingredients_extracted: true, verifier_run: true },
    evidence: [
      { id: "ev-p5-01", tool: "zetaris.product", summary: LIDL_PRODUCT },
      { id: "ev-p5-02", tool: "extract.ingredients", summary: LIDL_EXTRACTION },
    ],
    memory: SOURCE_NOTES,
    expectInput: { gtin: "4056489125846" },
    expectContradiction: false,
  },
  {
    id: "plan:sku-lidl-us-dq-pending",
    chain: "sku",
    subject: "4056489125846",
    market: "US",
    checklist: {
      ...SKU_FALSE,
      product_fetched: true,
      guard_scanned: true,
      ingredients_extracted: true,
      verifier_run: true,
      recall_check_gtin: true,
      recall_check_brand: true,
    },
    evidence: [
      { id: "ev-p6-01", tool: "zetaris.product", summary: LIDL_PRODUCT },
      { id: "ev-p6-02", tool: "extract.ingredients", summary: LIDL_EXTRACTION },
      { id: "ev-p6-03", tool: "zetaris.recalls_by_gtin", summary: LIDL_RECALL },
      { id: "ev-p6-04", tool: "zetaris.recalls_by_name", summary: "brand 'lidl': 2 FDA rows (H-1274-2026, H-1275-2026), 0 FSA alerts" },
    ],
    memory: SOURCE_NOTES,
    expectInput: { gtin: "4056489125846" },
    expectContradiction: true,
  },
  {
    id: "plan:sku-puffs-policy",
    chain: "sku",
    subject: "0816929000119",
    market: "UK",
    checklist: {
      product_fetched: true,
      guard_scanned: true,
      ingredients_extracted: true,
      verifier_run: true,
      recall_check_gtin: true,
      recall_check_brand: true,
      dq_checked: true,
      memory_checked: true,
      policy_proposed: false,
    },
    evidence: [
      { id: "ev-p7-01", tool: "zetaris.product", summary: PUFFS_PRODUCT },
      { id: "ev-p7-02", tool: "extract.ingredients", summary: "skipped by host: the source has no ingredient text; claim tester UNTESTED" },
      { id: "ev-p7-03", tool: "zetaris.recalls_by_gtin", summary: PUFFS_RECALL },
      { id: "ev-p7-04", tool: "zetaris.recalls_by_name", summary: "brand 'frankie': 1 FDA row (H-1328-2026), 0 FSA alerts" },
      { id: "ev-p7-05", tool: "zetaris.dq_gate", summary: "2 invalid records for this GTIN: has_ingredients (no ingredient text), english_label (label language fr)" },
      { id: "ev-p7-06", tool: "memory.recall", summary: "no officer rulings for this GTIN; source note: Open Food Facts data is crowd-sourced" },
    ],
    memory: SOURCE_NOTES,
    expectInput: { gtin: "0816929000119" },
    expectContradiction: true,
  },
  {
    id: "plan:sku-puffs-complete",
    chain: "sku",
    subject: "0816929000119",
    market: "UK",
    checklist: {
      product_fetched: true,
      guard_scanned: true,
      ingredients_extracted: true,
      verifier_run: true,
      recall_check_gtin: true,
      recall_check_brand: true,
      dq_checked: true,
      memory_checked: true,
      policy_proposed: true,
    },
    evidence: [
      { id: "ev-p8-03", tool: "zetaris.recalls_by_gtin", summary: PUFFS_RECALL },
      { id: "ev-p8-05", tool: "zetaris.dq_gate", summary: "2 invalid records for this GTIN: has_ingredients, english_label" },
      { id: "ev-p8-07", tool: "policy.propose", summary: "HOLD proposed: R1 exact-GTIN recall Terminated within 24 months; R3 DQ has_ingredients; R4 vegan claim NOT SUPPORTED" },
    ],
    memory: SOURCE_NOTES,
    expectInput: {},
    expectContradiction: true,
  },
  {
    id: "plan:sweep-fda-donutful-start",
    chain: "sweep",
    subject: "H-0011-2027",
    noticeSource: "fda",
    checklist: { ...SWEEP_FALSE },
    evidence: [
      {
        id: "ev-p9-01",
        tool: "watch",
        summary: "new FDA notice H-0011-2027 (as-of replay): The Better Bakehouse Snack Company, Donutful Chocolate Dipped Vanilla Cake Donuts, Class I, Ongoing, reported 2026-10-14, reason 'Undeclared Milk.'",
      },
    ],
    memory: SOURCE_NOTES,
    expectInput: { notice_id: "H-0011-2027" },
    expectContradiction: false,
  },
  {
    id: "plan:sweep-fsa-flapjacks-names",
    chain: "sweep",
    subject: "FSA-AA-48-2026",
    noticeSource: "fsa",
    checklist: { ...SWEEP_FALSE, notice_parsed: true, gtin_matches_checked: true },
    evidence: [
      {
        id: "ev-p10-01",
        tool: "zetaris.fsa_allergens",
        summary: "FSA-AA-48-2026, created 2026-10-21, 'Full On Flapjacks recalls various Flapjack products because of undeclared allergens'; allergens: Almond, Gluten, Nuts, Soya, Wheat; 5 products (Bakewell, Raspberry Yoghurt, White Chocolate, Blueberry Swirl and Caramel Flapjack); no GTINs",
      },
      { id: "ev-p10-02", tool: "host", summary: "GTIN match not applicable: FSA alerts carry no GTIN" },
    ],
    memory: SOURCE_NOTES,
    expectInput: { nameToken: "flapjack" },
    expectContradiction: false,
  },
];
