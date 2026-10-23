/**
 * ClearShelf manifest curation. Dev-time tool, NOT part of the agent.
 *
 * At runtime the agent reads Open Food Facts (OFF), openFDA and the UK FSA only through Zetaris.
 * This script is the one documented exception: a developer runs it to choose which real barcodes
 * go into the intake manifest and to derive their reference labels from recall texts and
 * documented label rules (see LABEL_RULES below). It never invents a label by hand.
 *
 * Run from the repo root with the agent's tsx:
 *   agent/node_modules/.bin/tsx scripts/curate-manifest.ts <step> [--max N]
 *
 * Steps
 *   fda        parse the saved openFDA page (fetched once; --refetch to fetch again), extract UPCs
 *   off-scan   look each recall UPC up on the OFF product endpoint, >= 2.5 s apart, resumable
 *   search     search.openfoodfacts.org pools (UK dark chocolate, DE/FR/IT biscuits, traps, brands)
 *   confirm    OFF product endpoint for the shortlisted search hits, >= 2.5 s apart
 *   fetch      OFF product endpoint for GTINs named on the command line (editorial shortlist)
 *   summary    print scan statistics and candidate tables (no network)
 *   build      write data/manifest/skus.json from the picks below (no network)
 *
 * Raw responses stay in data/curation/ (gitignored). The committed manifest holds GTINs, markets,
 * reference labels and provenance only: no OFF ingredient text (only a sha256 prefix of it).
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CUR = join(ROOT, "data", "curation");
const RAW_FDA = join(CUR, "raw", "fda_enforcement_undeclared.json");
const RAW_FSA = join(CUR, "raw", "fsa_allergy_alerts.json");
const FDA_UPCS = join(CUR, "fda_upcs.json");
const OFF_DIR = join(CUR, "off");
const SEARCH_DIR = join(CUR, "search");
const NET_LOG = join(CUR, "net_log.jsonl");
const LOCK = join(CUR, ".net.lock");
const MANIFEST = join(ROOT, "data", "manifest", "skus.json");

const FDA_URL =
  "https://api.fda.gov/food/enforcement.json?search=reason_for_recall:undeclared&sort=report_date:desc&limit=1000";
const FSA_URL = "https://data.food.gov.uk/food-alerts/id?type=AA&_sort=-created&_limit=200";
const OFF_FIELDS =
  "code,product_name,brands,lang,ingredients_text,ingredients_text_en,allergens_tags,traces_tags,labels_tags,countries_tags,last_modified_t";
const offProductUrl = (gtin: string) =>
  `https://world.openfoodfacts.org/api/v2/product/${gtin}.json?fields=${OFF_FIELDS}`;
const SEARCH_BASE = "https://search.openfoodfacts.org/search";
const SEARCH_FIELDS = OFF_FIELDS + ",unique_scans_n";

// No contact address until the owner supplies one; never invent one. An unfilled
// "<placeholder>" value from .env.local.example falls back to the bare product token.
const UA_ENV = (process.env.CLEARSHELF_USER_AGENT ?? "").trim();
const USER_AGENT = UA_ENV && !UA_ENV.includes("<") ? UA_ENV : "ClearShelf/0.1";
// 5 s by default: 3 s spacing drew HTTP 429 on about 10% of calls on 23 Oct (spec G5 fallback).
const OFF_GAP_MS = Math.max(2500, Number(process.env.OFF_GAP_MS || 5000));

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const nowIso = () => new Date().toISOString();

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function readJson<T = any>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8"));
}

function writeJsonAtomic(p: string, data: unknown) {
  ensureDir(dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
}

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

/** GS1 check digit (works for GTIN-8/12/13/14). */
export function gs1Valid(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const d = code.split("").map(Number);
  const check = d.pop()!;
  let sum = 0;
  d.reverse().forEach((x, i) => (sum += x * (i % 2 === 0 ? 3 : 1)));
  return (10 - (sum % 10)) % 10 === check;
}

type Upc = { raw: string; gtin: string; transform: string };

/** openFDA YYYYMMDD to YYYY-MM-DD; null when the field is empty (e.g. no termination yet). */
const isoDate = (v: unknown): string | null => {
  const d = String(v ?? "");
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
};

/**
 * Pull barcodes out of free recall text. A candidate must follow a UPC/GTIN/EAN/barcode keyword
 * (within 600 characters), may be written with spaces or dashes, and must pass the GS1 check digit.
 */
export function extractUpcs(text: string): Upc[] {
  const out = new Map<string, Upc>();
  const kw = /\b(?:UPC|GTIN|EAN|barcode)s?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = kw.exec(text))) {
    const win = text.slice(m.index, m.index + 600);
    for (const g of win.match(/\d(?:[ \-]?\d){6,16}/g) ?? []) {
      const d = g.replace(/[ \-]/g, "");
      let gtin = "";
      let transform = "";
      if (d.length === 12 && gs1Valid(d)) [gtin, transform] = ["0" + d, "upc12_pad13"];
      else if (d.length === 13 && gs1Valid(d)) [gtin, transform] = [d, "ean13"];
      else if (d.length === 14 && gs1Valid(d))
        [gtin, transform] = d[0] === "0" ? [d.slice(1), "gtin14_strip0"] : [d, "gtin14_case"];
      else if (d.length === 11 && gs1Valid("0" + d)) [gtin, transform] = ["00" + d, "upc11_pad13"];
      if (gtin && !out.has(gtin)) out.set(gtin, { raw: g.trim(), gtin, transform });
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------
// Allergen groups and recall-reason parsing
// ---------------------------------------------------------------------------------------------

export const GROUPS = [
  "milk", "egg", "fish", "crustacean", "mollusc", "tree_nut", "peanut", "gluten_cereal",
  "wheat", "soy", "sesame", "celery", "mustard", "lupin", "sulphite",
] as const;
export type Group = (typeof GROUPS)[number];
type Rel = "contains" | "may_contain" | "none";

/** English recall-reason vocabulary (openFDA texts are English). */
const RECALL_TERMS: [Group, RegExp][] = [
  ["milk", /\b(?:(?<!coconut |almond |oat |soy |soya |rice |cashew )milk|dairy|whey|casein\w*|cheese|lactose|(?<!peanut |cocoa |nut |shea )butter|(?<!coconut )cream)\b/i],
  ["egg", /\beggs?\b/i],
  ["fish", /\b(?:fish|anchov\w*|tuna|salmon|cod|pollock|tilapia|catfish|sardines?|mackerel|swai|whitefish|haddock)\b/i],
  ["crustacean", /\b(?:shrimp|crabs?|lobster|crustacean\w*|prawns?|crayfish|shellfish)\b/i],
  ["mollusc", /\b(?:mollus\w+|clams?|oysters?|mussels?|squid|scallops?|octopus)\b/i],
  ["tree_nut", /\b(?:tree ?nuts?|almonds?|cashews?|pecans?|walnuts?|hazelnuts?|filberts?|pistachios?|macadamia|brazil nuts?|pine ?nuts?|coconut)\b/i],
  ["peanut", /\bpeanuts?\b/i],
  ["wheat", /\bwheat\b/i],
  ["gluten_cereal", /\b(?:wheat|gluten|barley|rye|oats?)\b/i],
  ["soy", /\b(?:soy|soya|soybeans?)\b/i],
  ["sesame", /\bsesame\b/i],
  ["celery", /\bcelery\b/i],
  ["mustard", /\bmustard\b/i],
  ["lupin", /\blupin[e]?\b/i],
  ["sulphite", /\bsul(?:f|ph)(?:ites?|ur dioxide)\b|\bmetabisul(?:f|ph)ite\b/i],
];

export function parseRecallReason(fullReason: string) {
  // Read from the first "undeclared" onwards, so product names before it ("Milk may contain
  // undeclared almond") are not taken as the undeclared allergen; fall back to the whole text.
  const at = fullReason.search(/undeclared/i);
  const scoped = at >= 0 ? fullReason.slice(at) : fullReason;
  const find = (t: string) => RECALL_TERMS.filter(([, re]) => re.test(t)).map(([g]) => g);
  let groups: Group[] = find(scoped);
  let reason = scoped;
  if (!groups.length) [groups, reason] = [find(fullReason), fullReason];
  const treeNutTerms = reason.match(/\b(?:tree ?nuts?|almonds?|cashews?|pecans?|walnuts?|hazelnuts?|filberts?|pistachios?|macadamia|brazil nuts?|pine ?nuts?|coconut)\b/gi) ?? [];
  const coconutOnly =
    groups.includes("tree_nut") &&
    treeNutTerms.every((t) => /coconut|tree ?nuts?/i.test(t)) &&
    treeNutTerms.some((t) => /coconut/i.test(t));
  return {
    reason_type: groups.length ? "undeclared_allergen" : "other",
    groups,
    tree_nut_is_coconut_only: coconutOnly,
  };
}

// ---------------------------------------------------------------------------------------------
// Network (single process, one shared limiter for all openfoodfacts.org hosts)
// ---------------------------------------------------------------------------------------------

let lastOffCall = 0;

function takeLock() {
  ensureDir(CUR);
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive) throw new Error(`another curation run holds the network lock (pid ${pid})`);
  }
  writeFileSync(LOCK, String(process.pid));
  // Carry the spacing across runs: start the clock from the last logged openfoodfacts.org call.
  if (existsSync(NET_LOG)) {
    const last = readFileSync(NET_LOG, "utf8").trim().split("\n").reverse().find((l) => l.includes("openfoodfacts.org"));
    if (last) lastOffCall = Math.max(lastOffCall, Date.parse(JSON.parse(last).at));
  }
  process.on("exit", () => {
    try {
      unlinkSync(LOCK);
    } catch {}
  });
}

async function getJson(url: string, host: "off" | "other") {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (host === "off") {
      const wait = lastOffCall + OFF_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastOffCall = Date.now();
    }
    const t0 = Date.now();
    let status = 0;
    let body: any = null;
    let error: string | null = null;
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
      status = res.status;
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
        error = `non-JSON body (${text.length} bytes)`;
      }
    } catch (e: any) {
      error = String(e?.message ?? e);
    }
    appendFileSync(NET_LOG, JSON.stringify({ at: nowIso(), url, status, ms: Date.now() - t0, attempt, error }) + "\n");
    if (status === 429 || status === 503 || status >= 500 || (status === 0 && error)) {
      if (host === "off") lastOffCall = Date.now() + 5000 * attempt; // back off >= 5 s, then retry twice
      await sleep(5000 * (attempt + 1));
      continue;
    }
    return { status, body, error };
  }
  return { status: -1, body: null, error: "gave up after 3 attempts" };
}

// ---------------------------------------------------------------------------------------------
// Step: fda
// ---------------------------------------------------------------------------------------------

type FdaRec = {
  recall_number: string;
  report_date: string;
  recall_initiation_date: string | null;
  termination_date: string | null;
  classification: string;
  status: string;
  firm: string;
  distribution: string;
  reason: string;
  product_description_head: string;
  reason_type: string;
  groups: Group[];
  tree_nut_is_coconut_only: boolean;
  upcs: Upc[];
};

async function stepFda() {
  if (!existsSync(RAW_FDA) || process.argv.includes("--refetch")) {
    takeLock();
    const r = await getJson(FDA_URL, "other");
    if (r.status !== 200) throw new Error(`openFDA fetch failed: ${r.status} ${r.error}`);
    writeJsonAtomic(RAW_FDA, r.body);
  }
  const raw = readJson(RAW_FDA);
  const recs: FdaRec[] = raw.results.map((r: any) => {
    const rr = parseRecallReason(r.reason_for_recall ?? "");
    return {
      recall_number: r.recall_number,
      report_date: isoDate(r.report_date)!,
      recall_initiation_date: isoDate(r.recall_initiation_date),
      termination_date: isoDate(r.termination_date),
      classification: r.classification,
      status: r.status,
      firm: r.recalling_firm,
      distribution: String(r.distribution_pattern ?? "").slice(0, 300),
      reason: r.reason_for_recall,
      product_description_head: String(r.product_description ?? "").replace(/\s+/g, " ").slice(0, 200),
      ...rr,
      upcs: extractUpcs(`${r.product_description ?? ""}\n${r.code_info ?? ""}`),
    };
  });
  const byGtin = new Map<string, string[]>();
  for (const r of recs) for (const u of r.upcs) byGtin.set(u.gtin, [...(byGtin.get(u.gtin) ?? []), r.recall_number]);
  const out = {
    source_url: FDA_URL,
    meta: raw.meta,
    records: recs.length,
    records_with_upc_keyword: raw.results.filter((r: any) => /\b(?:UPC|GTIN|EAN|barcode)s?\b/i.test(`${r.product_description} ${r.code_info}`)).length,
    records_with_valid_upc: recs.filter((r) => r.upcs.length).length,
    unique_gtins: byGtin.size,
    transforms: Object.fromEntries(
      [...new Set(recs.flatMap((r) => r.upcs.map((u) => u.transform)))].map((t) => [
        t,
        recs.flatMap((r) => r.upcs).filter((u) => u.transform === t).length,
      ]),
    ),
    reason_types: {
      undeclared_allergen: recs.filter((r) => r.reason_type === "undeclared_allergen").length,
      other: recs.filter((r) => r.reason_type === "other").length,
    },
    recs,
  };
  writeJsonAtomic(FDA_UPCS, out);
  const { recs: _r, meta: _m, ...stats } = out;
  console.log(JSON.stringify(stats, null, 2));
}

// ---------------------------------------------------------------------------------------------
// Step: off-scan / confirm
// ---------------------------------------------------------------------------------------------

const SPEC_FIRST = ["0816929000119", "0850041392103", "4056489125839", "4056489125846"];

async function fetchOff(gtin: string, why: string) {
  const p = join(OFF_DIR, `${gtin}.json`);
  if (existsSync(p)) return "cached";
  const url = offProductUrl(gtin);
  const r = await getJson(url, "off");
  writeJsonAtomic(p, { gtin, why, url, fetched_at: nowIso(), http_status: r.status, error: r.error, body: r.body });
  return r.status;
}

async function stepOffScan() {
  takeLock();
  ensureDir(OFF_DIR);
  const fda = readJson(FDA_UPCS);
  const recs: FdaRec[] = [...fda.recs].sort((a: FdaRec, b: FdaRec) => b.report_date.localeCompare(a.report_date));
  const order: string[] = [...SPEC_FIRST];
  for (const r of recs)
    for (const u of r.upcs) if (u.transform !== "gtin14_case" && !order.includes(u.gtin)) order.push(u.gtin);
  const max = argNum("--max", Infinity);
  let calls = 0;
  const started = Date.now();
  const tally: Record<string, number> = {};
  for (const g of order) {
    if (calls >= max) break;
    const s = await fetchOff(g, "fda-upc-scan");
    if (s === "cached") continue;
    calls++;
    tally[String(s)] = (tally[String(s)] ?? 0) + 1;
    if (calls % 25 === 0) console.log(`${calls} calls, ${((Date.now() - started) / 1000).toFixed(0)} s, ${JSON.stringify(tally)}`);
  }
  console.log(`off-scan done: ${calls} calls in ${((Date.now() - started) / 1000).toFixed(0)} s, statuses ${JSON.stringify(tally)}, queue ${order.length}`);
}

// ---------------------------------------------------------------------------------------------
// Step: search (search.openfoodfacts.org, dev-time curation only)
// ---------------------------------------------------------------------------------------------

const DONE = `states_tags:"en:ingredients-completed"`;
const SEARCHES: Record<string, string> = {
  uk_dark_choc_traces_milk: `categories_tags:"en:dark-chocolates" AND countries_tags:"en:united-kingdom" AND lang:"en" AND traces_tags:"en:milk" AND ${DONE}`,
  biscuits_de_nuts: `categories_tags:"en:biscuits" AND countries_tags:"en:germany" AND lang:"de" AND allergens_tags:"en:nuts" AND ${DONE}`,
  biscuits_fr_nuts: `categories_tags:"en:biscuits" AND countries_tags:"en:france" AND lang:"fr" AND allergens_tags:"en:nuts" AND ${DONE}`,
  biscuits_it_nuts: `categories_tags:"en:biscuits" AND countries_tags:"en:italy" AND lang:"it" AND allergens_tags:"en:nuts" AND ${DONE}`,
  brand_lambertz: `brands_tags:"lambertz" AND ${DONE}`,
  brand_full_on: `brands_tags:"full-on-flapjacks"`,
  brand_skinny_crunch: `brands_tags:"skinny-crunch"`,
  trap_coconut_milk_uk: `ingredients_tags:"en:coconut-milk" AND countries_tags:"en:united-kingdom" AND lang:"en" AND ${DONE}`,
  trap_buckwheat_uk: `ingredients_tags:"en:buckwheat" AND countries_tags:"en:united-kingdom" AND lang:"en" AND ${DONE}`,
  trap_nutmeg_uk: `ingredients_tags:"en:nutmeg" AND countries_tags:"en:united-kingdom" AND lang:"en" AND ${DONE}`,
  trap_cream_of_tartar: `ingredients_tags:"en:e336" AND lang:"en" AND countries_tags:"en:united-kingdom" AND ${DONE}`,
  uk_free_from_no_ingredients: `countries_tags:"en:united-kingdom" AND (labels_tags:"en:gluten-free" OR labels_tags:"en:vegan") AND states_tags:"en:ingredients-to-be-completed"`,
};

async function stepSearch() {
  takeLock();
  ensureDir(SEARCH_DIR);
  const only = process.argv.slice(3).filter((a) => !a.startsWith("--"));
  for (const [id, q] of Object.entries(SEARCHES)) {
    if (only.length && !only.includes(id)) continue;
    const p = join(SEARCH_DIR, `${id}.json`);
    if (existsSync(p) && !process.argv.includes("--refetch")) continue;
    const url = `${SEARCH_BASE}?${new URLSearchParams({ q, page_size: "100", fields: SEARCH_FIELDS, sort_by: "-unique_scans_n" })}`;
    const r = await getJson(url, "off");
    writeJsonAtomic(p, { id, q, url, fetched_at: nowIso(), http_status: r.status, error: r.error, body: r.body });
    console.log(`${id}: HTTP ${r.status}, count ${r.body?.count ?? "?"}, hits ${r.body?.hits?.length ?? 0}`);
  }
}

/** Deterministic shortlist rules for each search pool (applied to search hits, then confirmed). */
const SHORTLIST: Record<string, { n: number; keep: (h: any) => boolean }> = {
  uk_dark_choc_traces_milk: { n: 10, keep: (h) => !(h.allergens_tags ?? []).includes("en:milk") },
  biscuits_de_nuts: { n: 5, keep: (h) => (h.allergens_tags ?? []).includes("en:gluten") },
  biscuits_fr_nuts: { n: 5, keep: (h) => (h.allergens_tags ?? []).includes("en:gluten") },
  biscuits_it_nuts: { n: 5, keep: (h) => (h.allergens_tags ?? []).includes("en:gluten") },
  brand_lambertz: { n: 5, keep: (h) => (h.countries_tags ?? []).includes("en:united-kingdom") || h.lang === "de" },
  brand_full_on: { n: 3, keep: () => true },
  brand_skinny_crunch: { n: 3, keep: () => true },
  trap_coconut_milk_uk: { n: 4, keep: () => true },
  trap_buckwheat_uk: { n: 4, keep: () => true },
  trap_nutmeg_uk: { n: 4, keep: () => true },
  trap_cream_of_tartar: { n: 4, keep: () => true },
  uk_free_from_no_ingredients: { n: 4, keep: (h) => /granola|pitta|kebab|chips|bar|biscuit|cookie|crisps|bread/i.test(h.product_name ?? "") },
};

function shortlist(id: string): any[] {
  const p = join(SEARCH_DIR, `${id}.json`);
  if (!existsSync(p)) return [];
  const hits: any[] = readJson(p).body?.hits ?? [];
  const rule = SHORTLIST[id];
  return hits.filter((h) => gs1Valid(String(h.code)) && String(h.code).length === 13 && rule.keep(h)).slice(0, rule.n);
}

async function stepConfirm() {
  takeLock();
  ensureDir(OFF_DIR);
  let calls = 0;
  for (const id of Object.keys(SHORTLIST)) {
    for (const h of shortlist(id)) {
      const s = await fetchOff(String(h.code), `search:${id}`);
      if (s !== "cached") calls++;
    }
  }
  console.log(`confirm done: ${calls} product calls`);
}

/** Product endpoint for explicitly named GTINs (editorial shortlist; labels still come from the rules). */
async function stepFetch() {
  takeLock();
  ensureDir(OFF_DIR);
  const gtins = process.argv.slice(3).filter((a) => /^\d{13}$/.test(a) && gs1Valid(a));
  let calls = 0;
  for (const g of gtins) if ((await fetchOff(g, "editorial-shortlist")) !== "cached") calls++;
  console.log(`fetch done: ${calls} product calls for ${gtins.length} GTINs`);
}

// ---------------------------------------------------------------------------------------------
// Reference-label rules (pass A: label text; pass B: OFF tags; deterministic adjudication)
// ---------------------------------------------------------------------------------------------

/** Letter-boundary helpers (JS \b is ASCII-only, so use Unicode letter look-arounds). */
const W = (alts: string) => `(?<!\\p{L})(?:${alts})(?!\\p{L})`; // whole word
const P = (alts: string) => `(?<!\\p{L})(?:${alts})`; // word start, any ending (plurals, compounds)
const S = (alts: string) => `(?:${alts})`; // substring (German compounds)

type GroupLex = { pos: string[]; neg: string[] };

/** Documented lexicon for the reference-label rules R-NAME/R-EMPH/R-CONTAINS/R-PREC. */
export const LEXICON: Record<Group, GroupLex> = {
  milk: {
    pos: [
      P("milk|butter|cream|cheese|whey|casein|lactose|yogh?urt|ghee|curds?|lactalbumin|lactoglobulin|skimmed milk|buttermilk|cheddar|parmesan|mozzarella|gouda|emmental|brie|feta|paneer|ricotta|mascarpone"),
      W("lait|laits|beurre|crème|creme|fromages?|lactosérum|lactoserum|petit-lait|caséines?|caséinates?|lactose|yaourts?|babeurre"),
      S("milch|butter|sahne|rahm|molke|käse|joghurt|quark|laktose|lactose|kasein"),
      W("latte|burro|panna|formaggi|formaggio|siero di latte|lattosio|caseina|caseinato|yogurt|ricotta|mascarpone|mozzarella|parmigiano"),
      W("leche|mantequilla|nata|queso|suero de leche|lactosa|caseína|yogur"),
    ],
    neg: [
      "cocoa butter|cacao butter|shea butter|peanut butter|nut butter|almond butter|cashew butter|butternut|creamed coconut",
      "(?:vegan|plant[- ]based|dairy[- ]free|non[- ]dairy) (?:white )?(?:cheddar|cheese|mozzarella|parmesan|cream cheese|butter)",
      "coconut milk|coconut cream|almond milk|oat milk|rice milk|soya milk|soy milk|cashew milk|pea milk|hemp milk|hazelnut milk|cream of tartar|salad cream|lactic acid|lactate",
      "beurre de cacao|beurre de karité|lait de coco|crème de coco|creme de coco|lait d'amande|lait de soja|lait d'avoine|lait de riz|crème de tartre|acide lactique|ferments lactiques",
      "kakaobutter|erdnussbutter|sheabutter|kokosmilch|kokosnussmilch|mandelmilch|hafermilch|sojamilch|reismilch|milchsäure|kokoscreme",
      "burro di cacao|burro di arachidi|latte di cocco|latte di mandorla|latte di soia|acido lattico|fermenti lattici",
      "manteca de cacao|mantequilla de cacahuete|mantequilla de cacao|leche de coco|leche de almendras?|leche de soja|ácido láctico",
    ],
  },
  egg: {
    pos: [
      P("eggs?|egg yolk|egg white|albumen|ovalbumin|lysozyme"),
      W("œufs?|oeufs?|ovoproduits?"),
      W("ei|eier") , S("hühnerei|trockenei|flüssigei|vollei|eigelb|eiklar|eipulver|eiernudel|freilandei"),
      W("uova|uovo|tuorlo"),
      W("huevos?|yema"),
    ],
    neg: ["eggplant"],
  },
  fish: {
    pos: [
      P("fish|anchov|tuna|salmon|cod|haddock|pollock|sardines?|mackerel|trout|herring|hake"),
      W("poissons?|anchois|thon|saumon|cabillaud|morue|sardines?|maquereau"),
      S("fisch|sardelle|(?<!f)lachs|kabeljau|hering|makrele"),
      W("pesce|acciughe|alici|tonno|salmone|merluzzo"),
      W("pescado|anchoas?|atún|salmón|bacalao"),
    ],
    neg: ["shellfish"],
  },
  crustacean: {
    pos: [
      P("crustacean|shrimp|prawn|crab|lobster|crayfish|langoustine|krill"),
      W("crustacés?|crevettes?|crabes?|homards?|langoustes?"),
      S("krebstier|garnele|krabbe|hummer|languste"),
      W("crostacei|gamberi|gamberetti|granchio|aragosta"),
      W("crustáceos|gambas?|camarones?|cangrejo|langosta"),
    ],
    neg: [],
  },
  mollusc: {
    pos: [
      P("mollus|mussel|oyster|clam|scallop|squid|octopus|cuttlefish|snail|whelk|cockle|calamari"),
      W("mollusques?|moules?|huîtres?|calmars?|poulpes?|escargots?"),
      S("weichtier|muschel|auster|tintenfisch"),
      W("molluschi|cozze|ostriche|vongole|polpo"),
      W("moluscos|mejillones|ostras?|almejas?|calamares|pulpo"),
    ],
    neg: [],
  },
  tree_nut: {
    pos: [
      P("almond|hazelnut|filbert|walnut|cashew|pecan|brazil nut|pistachio|macadamia|queensland nut|marzipan"),
      W("nuts?|tree nuts?|pine nuts?"),
      W("amandes?|noisettes?|noix(?! d[eu'’])|noix de cajou|noix de p[ée]can|noix de macadamia|noix du br[ée]sil|noix de grenoble|cajou|pistaches?|pécans?|macadamia|fruits à coque|massepain|pignons?"),
      S("mandel|haselnuss|haselnüss|walnuss|walnüss|cashew|pistazie|pekannuss|paranuss|macadamia|marzipan|schalenfrücht"),
      W("nuss|nüsse"),
      W("mandorle|mandorla|nocciole|nocciola|noci|noce|anacardi|anacardo|pistacchi|pistacchio|frutta a guscio|pinoli"),
      W("almendras?|avellanas?|nuez|nueces|anacardos?|pistachos?|frutos de cáscara|frutos secos"),
    ],
    neg: [
      "coconut|nutmeg|butternut|peanuts?|groundnuts?|shea nut|cola nut|kola nut",
      "noix de coco|noix de muscade|muscade",
      "kokosnuss|kokos|muskatnuss|erdnuss|erdnüsse",
      "noce di cocco|noce moscata|cocco",
      "nuez moscada|nuez de coco|coco",
      "doughnuts?|donuts?",
    ],
  },
  peanut: {
    pos: [
      P("peanut|groundnut"),
      W("arachides?|cacahuètes?|cacahuetes?|cacahouètes?"),
      S("erdnuss|erdnüss"),
      W("arachidi|arachide"),
      W("cacahuetes?|maní"),
    ],
    neg: [],
  },
  gluten_cereal: {
    pos: [
      P("wheat|rye|barley|oats?|oatmeal|spelt|kamut|khorasan|triticale|durum|semolina|couscous|bulgur|farro|gluten|malt|cereals containing gluten"),
      W("blé|ble|froment|seigle|orge|avoine|épeautre|epeautre|semoule|gluten|malt"),
      S("weizen|roggen|gerste|hafer|dinkel|emmer|einkorn|grünkern|gluten|malz"),
      W("frumento|grano|segale|orzo|avena|farro|semola|glutine|malto"),
      W("trigo|centeno|cebada|espelta|sémola|malta"),
    ],
    neg: [
      "buckwheat|maltodextrin|maltose|maltitol|gluten[ -]free|free from gluten",
      "sarrasin|maltodextrine|sans gluten",
      "buchweizen|maltodextrin|glutenfrei|weizenfrei",
      "grano saraceno|maltodestrine?|senza glutine",
      "trigo sarraceno|maltodextrina|sin gluten",
    ],
  },
  wheat: {
    pos: [
      P("wheat|spelt|kamut|khorasan|durum|semolina|couscous|bulgur|einkorn|emmer"),
      W("blé|ble|froment|épeautre|epeautre|semoule"),
      S("weizen|dinkel|emmer|einkorn|grünkern"),
      W("frumento|grano duro|grano tenero|semola|farro"),
      W("trigo|espelta|sémola"),
    ],
    neg: ["buckwheat|sarrasin|buchweizen|grano saraceno|trigo sarraceno|weizenfrei|wheat[ -]free"],
  },
  soy: {
    pos: [P("soy|soya|soybeans?|edamame|tofu|tempeh|miso"), W("soja|soia")],
    neg: [],
  },
  sesame: {
    pos: [P("sesame|tahini|tahina"), W("sésame|sesame"), S("sesam"), W("sesamo|sésamo|ajonjolí")],
    neg: [],
  },
  celery: { pos: [P("celery|celeriac"), W("céleri|celeri"), S("sellerie"), W("sedano|apio")], neg: [] },
  mustard: { pos: [P("mustard"), W("moutarde"), P("senf"), W("senape|mostaza")], neg: [] },
  lupin: { pos: [P("lupin"), W("lupins?"), S("lupine|lupinen"), W("lupino|lupini|altramuz")], neg: [] },
  sulphite: {
    pos: [
      P("sulphite|sulfite|sulphur dioxide|sulfur dioxide|metabisulphite|metabisulfite|bisulphite|bisulfite"),
      W("e ?22[0-8]"),
      W("sulfites?|anhydride sulfureux|disulfites?"),
      S("sulfit|schwefeldioxid|disulfit"),
      W("solfiti|anidride solforosa|solfito"),
      W("sulfitos?|dióxido de azufre"),
    ],
    neg: [],
  },
};

/** Trap vocabulary: words that a naive keyword rule mistakes for an allergen (for the trap metric). */
export const TRAPS: Record<string, string> = {
  cocoa_butter: "cocoa butter|cacao butter|beurre de cacao|kakaobutter|burro di cacao|manteca de cacao",
  coconut: "coconut|noix de coco|kokos|cocco|(?<!\\p{L})coco(?!\\p{L})",
  coconut_milk: "coconut milk|coconut cream|lait de coco|kokosmilch|latte di cocco|leche de coco",
  plant_milk: "almond milk|oat milk|rice milk|soya milk|soy milk|cashew milk|pea milk|hemp milk|oat drink|lait d'amande|mandelmilch|hafermilch",
  buckwheat: "buckwheat|sarrasin|buchweizen|grano saraceno|trigo sarraceno",
  nutmeg: "nutmeg|muscade|muskatnuss|noce moscata|nuez moscada",
  cream_of_tartar: "cream of tartar|crème de tartre|weinstein|cremor tartaro|potassium bitartrate|e ?336",
  lactic_acid: "lactic acid|acide lactique|milchsäure|acido lattico|ácido láctico|lactate",
  peanut_butter_not_milk: "peanut butter|erdnussbutter|beurre de cacahuète",
  maltodextrin: "maltodextrin",
  shea: "shea",
};

const PRECAUTION_TRIGGERS = [
  "may (?:also )?contain",
  "may be present",
  "(?<!\\p{L})traces? of",
  "(?:made|produced|manufactured|packed|prepared|baked) (?:in|on|at) (?:a |the )?(?:factory|facility|site|premises|bakery|equipment|line|environment)",
  "not suitable for",
  "kann (?:auch )?(?:spuren|anteile)",
  "kann [^.;]{0,100}?enthalten",
  "spuren von",
  "(?:hergestellt|produziert) in einem betrieb",
  "peut contenir",
  "(?:présence|presence) éventuelle",
  "(?<!\\p{L})traces? (?:éventuelles? )?(?:de|d')",
  "fabriqué dans (?:un atelier|une usine)",
  "può contenere",
  "tracce di",
  "prodotto in uno stabilimento",
  "puede contener",
  "trazas de",
];
const CONTAINS_TRIGGERS = ["(?<!may )(?<!may also )contains?:", "enthält:", "contient:", "contiene:"];
const BOILERPLATE = [
  "for allergens[^.]*?\\bbold\\b",
  "allergens? (?:are )?(?:highlighted|shown|listed|emphasi[sz]ed|in bold)[^.]*",
  "allergy advice:?",
  "allergene (?:sind )?(?:fett|hervorgehoben)[^.]*",
  "allerg[eè]nes? (?:sont )?(?:indiqués? )?en gras[^.]*",
  "allergeni (?:sono )?(?:in grassetto|evidenziati)[^.]*",
  "al[eé]rgenos (?:en negrita|destacados)[^.]*",
  "(?:gluten|milk|dairy|egg|nut|peanut|soya?|lactose|wheat|sesame|mustard|celery)[ -]free",
];

function mask(text: string, alts: string[]): string {
  let t = text;
  for (const a of alts) t = t.replace(new RegExp(a, "giu"), (m) => " ".repeat(m.length));
  return t;
}

function spans(text: string, alts: string[]): [number, number][] {
  const out: [number, number][] = [];
  for (const a of alts) {
    const re = new RegExp(a, "giu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const end = text.slice(m.index).search(/[.;](?=\s|$)|\n/);
      out.push([m.index, end < 0 ? text.length : m.index + end + 1]);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out;
}

const inside = (pos: number, ranges: [number, number][]) => ranges.some(([a, b]) => pos >= a && pos < b);

export type PassA = Record<Group, { rel: Rel; rules: string[]; hits: number }>;

/** Pass A: documented label-text rules applied to an ingredients text. */
export function labelFromText(text: string): { groups: PassA; traps: string[] } {
  const base = mask(text, BOILERPLATE);
  const prec = spans(base, PRECAUTION_TRIGGERS);
  const contains = spans(base, CONTAINS_TRIGGERS);
  const emph: [number, number][] = [];
  for (const m of base.matchAll(/_([^_]{1,80})_/gu)) emph.push([m.index!, m.index! + m[0].length]);
  const groups = {} as PassA;
  for (const g of GROUPS) {
    const lex = LEXICON[g];
    const t = mask(base, lex.neg);
    let inList = 0;
    let inPrec = 0;
    const rules = new Set<string>();
    for (const alt of lex.pos) {
      for (const m of t.matchAll(new RegExp(alt, "giu"))) {
        const pos = m.index!;
        if (inside(pos, prec)) {
          inPrec++;
          rules.add("R-PREC");
        } else {
          inList++;
          rules.add(inside(pos, contains) ? "R-CONTAINS" : inside(pos, emph) ? "R-EMPH" : "R-NAME");
        }
      }
    }
    groups[g] = { rel: inList ? "contains" : inPrec ? "may_contain" : "none", rules: [...rules].sort(), hits: inList + inPrec };
  }
  // A labelled wheat ingredient is also a cereal containing gluten (Annex II item 1).
  if (groups.wheat.rel === "contains" && groups.gluten_cereal.rel !== "contains")
    groups.gluten_cereal = { rel: "contains", rules: [...new Set([...groups.gluten_cereal.rules, "R-WHEAT-IS-GLUTEN"])].sort(), hits: groups.gluten_cereal.hits };
  const traps = Object.entries(TRAPS)
    .filter(([, re]) => new RegExp(re, "iu").test(base))
    .map(([k]) => k);
  return { groups, traps };
}

const OFF_TAG_GROUP: Record<string, Group> = {
  "en:milk": "milk", "en:eggs": "egg", "en:fish": "fish", "en:crustaceans": "crustacean",
  "en:molluscs": "mollusc", "en:nuts": "tree_nut", "en:peanuts": "peanut", "en:gluten": "gluten_cereal",
  "en:soybeans": "soy", "en:sesame-seeds": "sesame", "en:celery": "celery", "en:mustard": "mustard",
  "en:lupin": "lupin", "en:sulphur-dioxide-and-sulphites": "sulphite",
};

/** Pass B: OFF allergens_tags / traces_tags (crowd- and parser-derived second opinion). */
export function labelFromTags(allergens: string[] = [], traces: string[] = []) {
  const groups = {} as Record<Group, Rel | "n/a">;
  for (const g of GROUPS) groups[g] = g === "wheat" ? "n/a" : "none";
  for (const t of traces) if (OFF_TAG_GROUP[t]) groups[OFF_TAG_GROUP[t]] = "may_contain";
  for (const t of allergens) if (OFF_TAG_GROUP[t]) groups[OFF_TAG_GROUP[t]] = "contains";
  const unmapped = [...new Set([...allergens, ...traces].filter((t) => !OFF_TAG_GROUP[t]))];
  return { groups, unmapped };
}

const TRAP_FOR_GROUP: Partial<Record<Group, string[]>> = {
  milk: ["cocoa_butter", "coconut_milk", "plant_milk", "lactic_acid", "cream_of_tartar", "peanut_butter_not_milk", "shea"],
  tree_nut: ["coconut", "nutmeg", "shea"],
  gluten_cereal: ["buckwheat", "maltodextrin"],
  wheat: ["buckwheat"],
};

type Adj = { label: Rel | "unscored"; basis: string; text: Rel; tags: Rel | "n/a"; rules: string[] };

/** Deterministic adjudication of pass A (text) against pass B (tags). Label text governs. */
export function adjudicate(a: PassA, b: Record<Group, Rel | "n/a">, traps: string[]): Record<Group, Adj> {
  const out = {} as Record<Group, Adj>;
  for (const g of GROUPS) {
    const A = a[g].rel;
    const B = b[g];
    const base = { text: A, tags: B, rules: a[g].rules };
    if (B === "n/a") out[g] = { label: A, basis: "ADJ-TEXT-ONLY", ...base };
    else if (A === B) out[g] = { label: A, basis: "ADJ-AGREE", ...base };
    else if (A === "contains")
      out[g] = { label: "contains", basis: a[g].rules.some((r) => r === "R-EMPH" || r === "R-CONTAINS") ? "ADJ-TEXT-DECLARED" : "ADJ-TEXT-NAME", ...base };
    else if (A === "may_contain") out[g] = { label: "may_contain", basis: "ADJ-TEXT-PRECAUTION", ...base };
    else if (B === "contains" && (TRAP_FOR_GROUP[g] ?? []).some((t) => traps.includes(t))) out[g] = { label: "none", basis: "ADJ-TRAP", ...base };
    else out[g] = { label: "unscored", basis: "ADJ-DISPUTED", ...base };
  }
  return out;
}

export const LABEL_RULES = {
  version: "2026-10-23.1",
  scope:
    "Reference labels per allergen group (contains | may_contain | none; 'unscored' when the rules disagree). They are derived only from recall texts and the documented rules below, never typed by hand.",
  groups: GROUPS,
  recall_rules: {
    "R-RECALL":
      "An openFDA enforcement report whose reason_for_recall names an allergen as undeclared makes that group 'contains' in product_truth (regulator or lab ground truth). Matching uses RECALL_TERMS in scripts/curate-manifest.ts on the reason text from its first 'undeclared' onwards (whole reason if that finds nothing); plant milks and cocoa butter are not milk.",
    "R-RECALL-COCONUT":
      "A recall reason whose only tree-nut term is coconut is recorded as a rule-against-rule conflict and does not set tree_nut: coconut is not in FDA Q&A Edition 5 Table 1 (Jan 2025) and is not an Annex II nut.",
  },
  text_rules: {
    "R-NAME":
      "An ingredient name in the label text that the lexicon maps to a group (EN/DE/FR/IT/ES; statutory definitions: Reg. (EU) 1169/2011 Annex II, FD&C Act 201(qq), FDA Q&A Ed. 5) makes it 'contains'. Trap phrases are masked first per group (e.g. cocoa butter for milk, coconut and nutmeg for tree_nut, buckwheat for gluten).",
    "R-EMPH":
      "An allergen emphasised in the ingredient list (Reg. (EU) 1169/2011 Art. 21(1)(b); rendered by Open Food Facts as _word_) makes it 'contains'.",
    "R-CONTAINS": "A 'Contains:' statement (FD&C Act 403(w)(1)(A)) or its DE/FR/IT/ES equivalent makes the named groups 'contains'.",
    "R-PREC":
      "A group named only inside a precautionary clause ('may contain', 'traces of', 'kann Spuren ... enthalten', 'peut contenir', 'può contenere', 'puede contener', 'made in a factory that...') is 'may_contain'.",
    "R-WHEAT-IS-GLUTEN": "Wheat 'contains' implies gluten_cereal 'contains' (Annex II item 1 names wheat as a cereal containing gluten).",
    boilerplate:
      "Allergy-advice boilerplate (UK lines that refer the reader to the allergens printed in bold) and free-from claims (e.g. gluten-free) are masked before matching.",
  },
  second_pass: "Pass B maps the Open Food Facts allergens_tags (contains) and traces_tags (may_contain); it has no wheat signal.",
  adjudication: {
    "ADJ-AGREE": "Pass A and pass B agree.",
    "ADJ-TEXT-ONLY": "Wheat: pass B has no wheat signal, so pass A stands.",
    "ADJ-TEXT-DECLARED": "Text says contains via emphasis or a Contains statement, tags disagree: the label declaration governs.",
    "ADJ-TEXT-NAME": "Text says contains via an ingredient name, tags disagree: the ingredient list governs.",
    "ADJ-TEXT-PRECAUTION": "Text names the group only precautionarily, tags disagree: the label wording governs (may_contain).",
    "ADJ-TRAP": "Tags say contains, the text names nothing for the group but holds a documented trap word for it (e.g. cocoa butter for milk): none.",
    "ADJ-DISPUTED": "Tags say contains or may_contain and the text rules find nothing explainable (e.g. a precautionary statement printed outside the ingredient text): the group is unscored.",
  },
  limits: [
    "Pass A is a rule-based reader; a lexicon gap shows up as ADJ-DISPUTED (unscored), not as a silent 'none'.",
    "Recall-derived positives describe the product, not its printed label: an undeclared allergen is by definition absent from the label text, so extraction is scored against label_text and the recall check is scored separately.",
    "Open Food Facts text is crowd-sourced and may lag the physical label.",
  ],
};

// ---------------------------------------------------------------------------------------------
// Step: summary
// ---------------------------------------------------------------------------------------------

function loadOff(gtin: string): any | null {
  const p = join(OFF_DIR, `${gtin}.json`);
  return existsSync(p) ? readJson(p) : null;
}

function offProduct(rec: any): any | null {
  const b = rec?.body;
  if (!b || rec.http_status !== 200 || !(b.status === 1 || b.status === "success" || b.product)) return null;
  return b.product ?? null;
}

function recallIndex(): Map<string, FdaRec[]> {
  const idx = new Map<string, FdaRec[]>();
  if (!existsSync(FDA_UPCS)) return idx;
  for (const r of readJson(FDA_UPCS).recs as FdaRec[]) for (const u of r.upcs) idx.set(u.gtin, [...(idx.get(u.gtin) ?? []), r]);
  return idx;
}

function stepSummary() {
  const idx = recallIndex();
  const files = existsSync(OFF_DIR) ? readdirSync(OFF_DIR).filter((f) => f.endsWith(".json")) : [];
  const stats = { scanned: 0, http: {} as Record<string, number>, found: 0, with_text: 0, with_en_text: 0, recall_scanned: 0, recall_found: 0, recall_with_text: 0 };
  const rows: string[] = [];
  for (const f of files) {
    const rec = readJson(join(OFF_DIR, f));
    stats.scanned++;
    stats.http[rec.http_status] = (stats.http[rec.http_status] ?? 0) + 1;
    const isRecall = String(rec.why).startsWith("fda");
    if (isRecall) stats.recall_scanned++;
    const p = offProduct(rec);
    if (!p) continue;
    stats.found++;
    if (isRecall) stats.recall_found++;
    const text = (p.ingredients_text ?? "").trim();
    if (text) stats.with_text++;
    if (text && isRecall) stats.recall_with_text++;
    if ((p.ingredients_text_en ?? "").trim() || (p.lang === "en" && text)) stats.with_en_text++;
    const recs = idx.get(rec.gtin) ?? [];
    const la = text ? labelFromText(text) : null;
    const contains = la ? GROUPS.filter((g) => la.groups[g].rel === "contains").join("+") : "-";
    const may = la ? GROUPS.filter((g) => la.groups[g].rel === "may_contain").join("+") : "-";
    rows.push(
      [
        rec.gtin, rec.why, p.lang ?? "?", text ? `txt${text.length}` : "notxt", (p.ingredients_text_en ?? "").trim() ? "en" : "-",
        `[${(p.allergens_tags ?? []).join(",")}]`, `tr[${(p.traces_tags ?? []).join(",")}]`,
        `A:${contains}|${may}`, la ? `traps:${la.traps.join(",")}` : "",
        (p.labels_tags ?? []).filter((l: string) => /vegan|gluten-free|dairy-free|nut-free|lactose-free|milk-free/.test(l)).join(","),
        recs.map((r) => `${r.recall_number}/${r.report_date}/${r.classification}/${r.status}/${r.groups.join("+")}`).join(";"),
        `${(p.brands ?? "").slice(0, 25)} :: ${(p.product_name ?? "").slice(0, 45)}`,
      ].join(" | "),
    );
  }
  console.log(JSON.stringify(stats));
  const filter = process.argv[3];
  for (const r of rows) if (!filter || r.includes(filter)) console.log(r);
}

// ---------------------------------------------------------------------------------------------
// Step: build (picks are filled in after the scan; see PICKS)
// ---------------------------------------------------------------------------------------------

type Pick = {
  gtin: string;
  role: "demo" | "eval_only";
  markets: ("UK" | "US")[];
  scenarios?: string[];
  why: string;
};

/**
 * Curated picks, each with the reason it was chosen. Choosing a SKU is editorial; its reference
 * labels are not: buildEntry() derives them from the recall texts and LABEL_RULES only.
 */
const PICKS: Pick[] = [
  // --- Spec scenarios (section 9.1) ---
  { gtin: "0816929000119", role: "demo", markets: ["UK"], scenarios: ["E1"], why: "FDA H-1328-2026 (milk, Class I, Terminated) vs OFF vegan label and no allergens; no ingredient text in OFF." },
  { gtin: "0850041392103", role: "demo", markets: ["UK"], scenarios: ["E2", "AS_OF_REPLAY"], why: "FDA H-0011-2027 (milk, Class I, Ongoing, reported 2026-10-14, after the 2026-10-10 as-of date); no ingredient text in OFF." },
  { gtin: "4056489125846", role: "demo", markets: ["UK", "US"], scenarios: ["E3", "E4"], why: "FDA H-1275-2026 (Class II, Ongoing, US-only distribution): German-language label, 'tree nut (coconut)' in the recall text, OFF tag de:blé." },
  { gtin: "4056489125839", role: "demo", markets: ["UK"], why: "Sibling SKU of H-1275 under H-1274-2026: same recall reason, German-only label." },
  { gtin: "5000169566558", role: "demo", markets: ["UK"], scenarios: ["E5"], why: "UK dark chocolate 90%: cocoa butter among the ingredients and a precautionary statement naming milk (also peanuts and nuts); no contains-level allergen." },
  { gtin: "5059319005492", role: "demo", markets: ["UK"], scenarios: ["E6"], why: "OFF vegan label with no ingredient text (state ingredients-to-be-completed); not in any recall." },
  { gtin: "4006894512205", role: "demo", markets: ["UK"], scenarios: ["E7"], why: "German-only biscuit label (no English text) with wheat, milk, hazelnut, egg, soya; brand Lambertz matches FSA-AA-44-2026 (allergens not declared in English)." },
  { gtin: "5056315500204", role: "demo", markets: ["UK"], scenarios: ["E9_NAME_MATCH"], why: "Brand Skinny Crunch matches FSA-AA-45-2026 (Halo Foods, Skinny Crunch Light Peanut Butter Bars, created 2026-10-13, inside the replay window). Different product: name-only review item, never an auto-HOLD." },
  // --- Demo catalogue: more chocolates, traps, multilingual ---
  { gtin: "5000128691369", role: "demo", markets: ["UK"], why: "UK dark chocolate: cocoa butter plus a precautionary allergy-advice statement naming nuts, peanuts and milk." },
  { gtin: "8717677339990", role: "demo", markets: ["UK"], why: "Dark chocolate 70%: soya lecithin (contains) plus a precautionary statement naming milk among five groups." },
  { gtin: "4006894554106", role: "demo", markets: ["UK"], why: "Second Lambertz SKU (German-only label, coconut trap, FSA-AA-44 brand match)." },
  { gtin: "5060100601861", role: "demo", markets: ["UK"], why: "Trap: coconut milk drink sold as 'milk'; no statutory allergen in the label text." },
  { gtin: "4088600526065", role: "demo", markets: ["UK"], why: "Trap: buckwheat in a gluten-free-labelled rice cake; no statutory allergen in the label text." },
  { gtin: "5029396003346", role: "demo", markets: ["UK"], why: "Trap: cream of tartar in a ginger beer; no statutory allergen in the label text." },
  { gtin: "5015285811734", role: "demo", markets: ["UK"], why: "Trap: 'Egg replacer' with cream of tartar and no egg; gluten-free label." },
  { gtin: "5060132285190", role: "demo", markets: ["UK"], why: "Traps: shea-nut butter and coconut-milk powder next to real peanut, cashew and hazelnut." },
  { gtin: "5050974505259", role: "demo", markets: ["UK"], why: "Trap: buckwheat next to real rye and sesame (upper-case emphasis)." },
  { gtin: "8076809580748", role: "demo", markets: ["UK"], why: "Italian biscuit (burro di cacao trap, emphasis absent) with an English text also on file." },
  { gtin: "8000500310427", role: "demo", markets: ["UK"], why: "French label with upper-case emphasis (NOISETTES, LAIT, SOJA, FROMENT) and an English text on file." },
  { gtin: "7622210445346", role: "demo", markets: ["UK"], why: "Trap: crushed buckwheat inside a wheat/oat/barley/spelt cereal list." },
  // --- Demo catalogue: recall-matched SKUs (openFDA UPC resolves in OFF, product name checked against the recall text) ---
  { gtin: "0099482502065", role: "demo", markets: ["UK", "US"], why: "FDA H-0941-2026: undeclared shrimp in a minestrone soup, Class I, Ongoing, US distribution only; label text has no crustacean." },
  { gtin: "0810001560768", role: "demo", markets: ["UK"], why: "FDA H-0903-2026: undeclared egg, Class I, Terminated, reported 2026-06-10; OFF vegan label (claim contradicted by the recall)." },
  { gtin: "0850031990074", role: "demo", markets: ["UK"], why: "FDA H-0027-2026: undeclared milk, Class I, Completed, reported 2025-10-01; OFF vegan label (claim contradicted by the recall)." },
  { gtin: "0044000882105", role: "demo", markets: ["UK", "US"], why: "FDA H-0326-2025: undeclared peanut due to mispackaging, Class II, Ongoing; peanut already named on this label." },
  { gtin: "0024739120006", role: "demo", markets: ["UK"], why: "FDA H-0063-2025: undeclared milk, Class I, Ongoing; label text has wheat and soy but no milk." },
  { gtin: "0850073087008", role: "demo", markets: ["UK"], why: "FDA H-1143-2026: undeclared soy, Class II, Terminated, reported 2026-07-15; cocoa butter trap in the label text." },
  { gtin: "0074570306053", role: "demo", markets: ["UK"], why: "FDA H-0227-2026: undeclared wheat, Class II, Completed, reported 2025-12-10; label has a US 'Contains' statement without wheat." },
  { gtin: "0072992042603", role: "demo", markets: ["UK"], why: "FDA F-0636-2025: undeclared almonds in a macadamia product, Class I, Terminated, reported 2025-03-19." },
  { gtin: "0857394006220", role: "demo", markets: ["UK"], why: "FDA F-0637-2025: wrong dressing, undeclared fish and wheat, Class I, Terminated, reported 2025-03-19." },
  { gtin: "8690766086473", role: "demo", markets: ["UK"], why: "FDA F-0631-2025: undeclared egg, Class I, Terminated, reported 2025-03-19; emphasised allergens in the label text." },
  // --- Eval-only (never in the demo catalogue) ---
  { gtin: "4088600132327", role: "eval_only", markets: ["UK"], why: "Allergy-advice boilerplate that refers to the bold allergens, plus a precautionary statement naming milk, peanuts and nuts." },
  { gtin: "5019503023022", role: "eval_only", markets: ["UK"], why: "Trap: nutmeg next to real egg white, wheat and milk." },
  { gtin: "5013803001070", role: "eval_only", markets: ["UK"], why: "Traps: shredded coconut and buckwheat next to real oats and almonds (emphasised)." },
  { gtin: "5052675030009", role: "eval_only", markets: ["UK"], why: "Coconut-milk powder trap next to real dairy milk powder, cashew and mustard (emphasised)." },
  { gtin: "4008400551920", role: "eval_only", markets: ["UK"], why: "German-only label (no English text), upper-case emphasis, Kakaobutter trap." },
  { gtin: "3251491787810", role: "eval_only", markets: ["UK"], why: "French-only label (blé, soja, protéines de lait); OFF traces not in the text stay unscored." },
  { gtin: "0041383090738", role: "eval_only", markets: ["UK"], why: "FDA F-0054-2025: lactose-free milk with undeclared almond (from almond milk), Class I, Terminated, reported 2024-10-30." },
  { gtin: "0036800469648", role: "eval_only", markets: ["UK"], why: "FDA F-1702-2024: coconut-milk frozen dessert with undeclared cashews; coconut-milk trap; OFF vegan label." },
  { gtin: "0072700200387", role: "eval_only", markets: ["UK"], why: "FDA F-0608-2024: dark chocolate coins with undeclared milk (mispackaging); cocoa butter trap." },
  { gtin: "0099482518707", role: "eval_only", markets: ["UK"], why: "FDA F-0776-2024: vegan pizza with undeclared milk, Class III, Terminated, reported 2024-01-31; pea milk and lactic acid traps." },
];

const MARKET_NOTE = "Target market(s) for the intake manifest; the jurisdiction module maps groups to market codes (UK:<group>, US:<group>).";

function buildEntry(pk: Pick, idx: Map<string, FdaRec[]>) {
  const rec = loadOff(pk.gtin);
  const p = offProduct(rec);
  const text = (p?.ingredients_text ?? "").trim();
  const textEn = (p?.ingredients_text_en ?? "").trim();
  const recs = (idx.get(pk.gtin) ?? []).sort((a, b) => b.report_date.localeCompare(a.report_date));
  const la = text ? labelFromText(text) : null;
  const lb = p ? labelFromTags(p.allergens_tags ?? [], p.traces_tags ?? []) : null;
  const adj = la && lb ? adjudicate(la.groups, lb.groups, la.traps) : null;

  const labelText = adj ? Object.fromEntries(GROUPS.map((g) => [g, adj[g].label])) : null;
  const productTruth: Record<string, Rel | "unscored"> = {};
  const basis: Record<string, string[]> = {};
  const ruleConflicts: any[] = [];
  for (const g of GROUPS) {
    productTruth[g] = adj ? adj[g].label : "unscored";
    basis[g] = adj ? [adj[g].basis, ...adj[g].rules] : ["NO-LABEL-TEXT"];
  }
  for (const r of recs) {
    if (r.reason_type !== "undeclared_allergen") continue;
    for (const g of r.groups) {
      if (g === "tree_nut" && r.tree_nut_is_coconut_only) {
        ruleConflicts.push({
          group: "tree_nut",
          source: `fda:${r.recall_number}`,
          source_says: "tree nut (coconut)",
          rule: "FDA Q&A Edition 5 (Jan 2025) Table 1 omits coconut; Reg. (EU) 1169/2011 Annex II item 8 does not list coconut",
          effect: "tree_nut not set from this recall; coconut stays an ingredient-list fact",
        });
        continue;
      }
      if (productTruth[g] !== "contains") productTruth[g] = "contains";
      basis[g] = [...new Set([...(basis[g] ?? []), `R-RECALL:${r.recall_number}`])];
    }
  }
  const scoredGroups = adj ? GROUPS.filter((g) => adj[g].label !== "unscored").length : 0;
  return {
    gtin: pk.gtin,
    role: pk.role,
    markets: pk.markets,
    scenarios: pk.scenarios ?? [],
    why: pk.why,
    display_name: String(p?.product_name ?? "").trim() || recs[0]?.product_description_head?.split(/[,.]/)[0] || null,
    brand: String(p?.brands ?? "").split(",")[0].trim() || null,
    off_snapshot: p
      ? {
          source_url: offProductUrl(pk.gtin),
          fetched_at: rec.fetched_at,
          last_modified_t: p.last_modified_t ?? null,
          lang: p.lang ?? null,
          has_ingredients_text: !!text,
          has_ingredients_text_en: !!textEn,
          ingredients_sha256_12: text ? sha256(text).slice(0, 12) : null,
          allergens_tags: p.allergens_tags ?? [],
          traces_tags: p.traces_tags ?? [],
          claim_labels: (p.labels_tags ?? []).filter((l: string) => /vegan|vegetarian|gluten-free|dairy-free|nut-free|lactose-free|milk-free|no-gluten/.test(l)),
          unmapped_allergen_tags: lb?.unmapped ?? [],
          licence: "Open Food Facts, ODbL 1.0 (attribution). Only tags and flags kept here; no ingredient text.",
        }
      : { source_url: offProductUrl(pk.gtin), fetched_at: rec?.fetched_at ?? null, found: false, http_status: rec?.http_status ?? null },
    recalls: recs.map((r) => ({
      recall_number: r.recall_number,
      report_date: r.report_date,
      recall_initiation_date: r.recall_initiation_date ?? null,
      termination_date: r.termination_date ?? null,
      classification: r.classification,
      status: r.status,
      firm: r.firm,
      reason: r.reason,
      reason_groups: r.groups,
      upc_as_published: r.upcs.find((u) => u.gtin === pk.gtin)?.raw ?? null,
      transform: r.upcs.find((u) => u.gtin === pk.gtin)?.transform ?? null,
      licence: "openFDA, public domain / CC0; no FDA endorsement",
    })),
    reference_labels: {
      product_truth: productTruth,
      label_text: labelText,
      basis,
      traps_present: la?.traps ?? [],
      rule_conflicts: ruleConflicts,
      scored_groups_label_text: scoredGroups,
      in_extraction_eval: !!adj,
    },
  };
}

const SCENARIO_NOTES: Record<string, string> = {
  AS_OF_REPLAY:
    "The curated page holds 10 openFDA reports dated after 2026-10-10 (all reported 2026-10-14). Only H-0011-2027 (Donutful) carries a UPC that resolves in Open Food Facts; the UPCs of H-0015-2027 (Queso Palmita, 0094922980045), H-0016-2027 and the four Saint Francis Apizza reports (H-0021..0024-2027) return 404, and H-0009, H-0017 and H-0025-2027 yield no check-digit-valid UPC. No SKU cleared before its recall exists, so the spec default (Donutful: HOLD on has_ingredients, then BLOCK after the poll) stands.",
  E9:
    "FSA-AA-48-2026 (Full On Flapjacks) has no Open Food Facts product (search.openfoodfacts.org brand query returned 0 hits), so its replay ends in 'no catalogue match' with the notice ingested. The name-only review path is shown by FSA-AA-45-2026 (Skinny Crunch, created 2026-10-13, inside the replay window) against 5056315500204, and by FSA-AA-44-2026 (Lambertz, 2026-10-03) against the two Lambertz SKUs.",
  E8: "Synthetic injection fixtures are eval-only and live with the guard tests, not in this manifest.",
};

type WhyCheck = { gtin: string; why: string; recalls: { recall_number: string; report_date: string; status: string; classification: string }[] };

/** Hand-written 'why' text must agree with the recall rows it names (class, status, report date). */
export function whyDrift(skus: WhyCheck[]): string[] {
  const out: string[] = [];
  for (const s of skus) {
    for (const n of s.why.match(/(?<![\w-])[FH]-\d{4}-\d{4}\b/g) ?? []) {
      const r = s.recalls.find((x) => x.recall_number === n);
      if (!r) {
        out.push(`${s.gtin}: ${n} is not among its recalls`);
        continue;
      }
      const cls = s.why.match(/\bClass (I{1,3})\b/)?.[1];
      if (cls && `Class ${cls}` !== r.classification) out.push(`${s.gtin}: Class ${cls} vs ${r.classification}`);
      const st = s.why.match(/\b(Ongoing|Terminated|Completed)\b/)?.[1];
      if (st && st !== r.status) out.push(`${s.gtin}: ${st} vs ${r.status}`);
      for (const d of s.why.matchAll(/reported (\d{4}-\d{2}-\d{2})/g)) if (d[1] !== r.report_date) out.push(`${s.gtin}: reported ${d[1]} vs ${r.report_date}`);
      if (/\b(?:Terminated|Completed),? \d{4}-\d{2}-\d{2}/.test(s.why)) out.push(`${s.gtin}: a date right after the status reads as a termination date; write 'reported <date>'`);
    }
  }
  return out;
}

/** Measured scan statistics, recomputed from the cached responses in data/curation/ (no network). */
function curationStats() {
  if (!existsSync(FDA_UPCS)) return null;
  const fda = readJson(FDA_UPCS);
  const byGtin = new Map<string, FdaRec[]>();
  for (const r of fda.recs as FdaRec[]) for (const u of r.upcs) if (u.transform !== "gtin14_case") byGtin.set(u.gtin, [...(byGtin.get(u.gtin) ?? []), r]);
  let scanned = 0, found = 0, withText = 0, withEnglish = 0, allergenFound = 0, allergenWithText = 0;
  for (const [g, recs] of byGtin) {
    const rec = loadOff(g);
    if (!rec) continue;
    scanned++;
    const p = offProduct(rec);
    if (!p) continue;
    found++;
    const t = String(p.ingredients_text ?? "").trim();
    if (t) withText++;
    if (t && (p.lang === "en" || String(p.ingredients_text_en ?? "").trim())) withEnglish++;
    if (recs.some((r) => r.reason_type === "undeclared_allergen")) {
      allergenFound++;
      if (t) allergenWithText++;
    }
  }
  return {
    openfda_page: { records: fda.records, first_report_date: fda.recs.at(-1)?.report_date, last_report_date: fda.recs[0]?.report_date, total_matching: fda.meta?.results?.total ?? null },
    records_with_upc_keyword: fda.records_with_upc_keyword,
    records_with_check_digit_valid_upc: fda.records_with_valid_upc,
    reason_types: fda.reason_types,
    unique_gtins: fda.unique_gtins,
    unique_gtins_scannable: byGtin.size,
    transforms: fda.transforms,
    off_product_lookups: { scanned, found, with_ingredients_text: withText, with_english_text: withEnglish, allergen_recall_found: allergenFound, allergen_recall_with_text: allergenWithText },
    label: "measured",
  };
}

/** Any 20-character window of a picked SKU's OFF ingredient text that appears in the output. */
function offTextLeaks(out: string, gtins: string[]): string[] {
  const hay = out.toLowerCase().replace(/\s+/g, " ");
  const leaks: string[] = [];
  for (const g of gtins) {
    const p = offProduct(loadOff(g));
    for (const f of ["ingredients_text", "ingredients_text_en"]) {
      const t = String(p?.[f] ?? "").toLowerCase().replace(/\s+/g, " ");
      for (let i = 0; i + 20 <= t.length; i++) {
        const w = t.slice(i, i + 20);
        if (hay.includes(JSON.stringify(w).slice(1, -1))) {
          leaks.push(`${g}:${f}`);
          break;
        }
      }
    }
  }
  return leaks;
}

function stepBuild() {
  if (!PICKS.length) throw new Error("PICKS is empty: run the scan and fill in the picks first");
  const idx = recallIndex();
  const fda = existsSync(FDA_UPCS) ? readJson(FDA_UPCS) : null;
  const skus = PICKS.map((pk) => buildEntry(pk, idx));
  const missing = skus.filter((s) => (s.off_snapshot as any).found === false).map((s) => s.gtin);
  const manifest = {
    schema: "clearshelf.manifest.v1",
    generated_at: nowIso(),
    generator: "scripts/curate-manifest.ts build",
    notes: [
      "Real public products only. GTINs are GTIN-13 (UPC-A padded with a leading zero).",
      "No Open Food Facts ingredient text is stored here: only tags, flags and a sha256 prefix of the text seen at curation time.",
      "product_truth = label_text adjudicated, then raised to 'contains' by openFDA undeclared-allergen recalls (R-RECALL).",
      "label_text = what the printed label text declares under the documented rules; score extraction against this.",
      "role 'eval_only' SKUs never enter the demo catalogue: warm-up and onboarding read role 'demo' only; the eval runner registers or replays eval-only SKUs itself.",
      "recalls[] dates are openFDA's, as YYYY-MM-DD: report_date, recall_initiation_date and termination_date (null until terminated). FDA recall numbers start with H- or F-.",
      MARKET_NOTE,
    ],
    sources: {
      openfda: { url: FDA_URL, fetched_meta: fda?.meta ?? null, licence: "public domain / CC0; no FDA endorsement" },
      open_food_facts: { product_endpoint: offProductUrl("<gtin13>"), search: SEARCH_BASE + " (dev-time curation only)", licence: "ODbL 1.0" },
      fsa: { url: FSA_URL, licence: "Open Government Licence v3.0" },
    },
    label_rules: LABEL_RULES,
    counts: {
      total: skus.length,
      demo: skus.filter((s) => s.role === "demo").length,
      eval_only: skus.filter((s) => s.role === "eval_only").length,
      with_label_text: skus.filter((s) => s.reference_labels.in_extraction_eval).length,
      recall_matched: skus.filter((s) => s.recalls.length).length,
      not_found_in_off: missing,
    },
    scenario_picks: {} as Record<string, string[]>,
    scenario_notes: SCENARIO_NOTES,
    curation_stats: curationStats(),
    skus,
  };
  for (const s of skus) for (const sc of s.scenarios) (manifest.scenario_picks[sc] ??= []).push(s.gtin);
  for (const gtin of manifest.scenario_picks.E5 ?? []) {
    const lt = skus.find((s) => s.gtin === gtin)!.reference_labels.label_text ?? {};
    const groupsWith = (rel: string) => GROUPS.filter((g) => lt[g] === rel);
    manifest.scenario_notes = {
      ...manifest.scenario_notes,
      E5: `Derived from label_text for ${gtin}: contains [${groupsWith("contains").join(", ")}], may_contain [${groupsWith("may_contain").join(", ")}]. The precautionary statement names more groups than spec section 9.1's "May contain: milk", so the expected UK statement must list every may_contain group.`,
    };
  }
  const drift = whyDrift(skus);
  if (drift.length) throw new Error(`'why' text disagrees with the recall data: ${JSON.stringify(drift)}`);
  // Product names may legitimately repeat words of the label; everything else must not.
  const checked = { ...manifest, skus: skus.map(({ display_name, brand, ...rest }) => rest) };
  const leaks = offTextLeaks(JSON.stringify(checked), PICKS.map((p) => p.gtin));
  if (leaks.length) throw new Error(`manifest would contain Open Food Facts ingredient text: ${JSON.stringify(leaks.slice(0, 5))}`);
  writeJsonAtomic(MANIFEST, manifest);
  console.log(JSON.stringify(manifest.counts), JSON.stringify(manifest.scenario_picks));
}

// ---------------------------------------------------------------------------------------------

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const step = process.argv[2];
  const steps: Record<string, () => unknown> = {
    fda: stepFda,
    "off-scan": stepOffScan,
    search: stepSearch,
    confirm: stepConfirm,
    fetch: stepFetch,
    summary: stepSummary,
    build: stepBuild,
  };
  if (!steps[step]) {
    console.error(`usage: tsx scripts/curate-manifest.ts <${Object.keys(steps).join("|")}>`);
    process.exit(2);
  }
  Promise.resolve(steps[step]()).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
