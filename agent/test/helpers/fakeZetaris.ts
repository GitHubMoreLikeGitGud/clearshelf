// A fake gateway for the ops, watch and server tests. Every row is SYNTHETIC. The ops
// tables are read from a temp data/ops directory on every query, as Zetaris reads the
// uncached ops REST tables, so a decision the OpsStore writes shows up in prior_decisions
// and recheck_cleared exactly as the closed loop needs.

import { existsSync, readFileSync } from "node:fs";
import { GatewayClient } from "../../src/zetaris/client.ts";
import { OllamaClient } from "../../src/llm/ollama.ts";

const U = "lightning.metastore.clearshelf.clearance_usl";

export interface FakeProduct {
  gtin: string;
  name: string;
  brand: string;
  lang?: string;
  text?: string | null;
  labels?: string | null;
}

export interface FakeFda {
  recall_number: string;
  report_date: string;
  classification: string;
  status: string;
  firm: string;
  distribution: string;
  product_description: string;
  reason: string;
  code_info: string;
}

export interface FakeFsa {
  notation: string;
  created: string;
  title: string;
  business: string;
  allergens: string[];
}

export interface FakeWorld {
  opsDir: string;
  products: FakeProduct[];
  fda: FakeFda[];
  fsa: FakeFsa[];
  /** GTINs with an invalid has_ingredients DQ record. */
  noIngredients?: string[];
  calls: { template_id: string; params: Record<string, string> }[];
}

function readOps(dir: string, name: string): Record<string, string>[] {
  const p = `${dir}/${name}`;
  if (!existsSync(p)) return [];
  const rows = (JSON.parse(readFileSync(p, "utf8")) as { data: Record<string, string>[] }).data;
  return rows.filter((r) => !Object.values(r).includes("__schema__"));
}

function body(template_id: string, columns: string[], rows: unknown[][], objects: string[], raw: string[]) {
  return {
    template_id,
    role: "reader",
    columns,
    rows,
    row_count: rows.length,
    truncated: false,
    elapsed_ms: 2,
    sql: `-- synthetic ${template_id}`,
    sql_sha256: "0".repeat(64),
    objects,
    raw_objects: raw,
    executed_at: "2026-10-25T12:00:00+08:00",
    cache_state: "hit",
    cache_detail: {},
    source_cached_at: {},
    error: null,
  };
}

const DECISION_COLS = ["decision_id", "gtin", "market", "status", "statement", "decided_at", "decided_date", "actor", "contract_id", "reason"];
const FDA_COLS = ["recall_number", "report_date", "classification", "status", "firm", "distribution", "product_description", "reason", "code_info"];

export function fakeGateway(w: FakeWorld): GatewayClient {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { template_id, params } = JSON.parse(String(init?.body)) as { template_id: string; params: Record<string, string> };
    w.calls.push({ template_id, params });
    const links = readOps(w.opsDir, "recall_links.json");
    const decisions = readOps(w.opsDir, "decisions.json");
    const fdaRow = (f: FakeFda) => FDA_COLS.map((c) => f[c as keyof FakeFda]);
    let b;
    switch (template_id) {
      case "product": {
        const p = w.products.find((x) => x.gtin === params.gtin);
        b = body(
          template_id,
          ["gtin", "product_name", "brand", "lang", "ingredients_text", "ingredients_text_en", "labels", "vegan_claim", "last_modified", "source_url"],
          p ? [[p.gtin, p.name, p.brand, p.lang ?? "en", p.text ?? null, null, p.labels ?? null, null, "2026-09-01", "synthetic"]] : [],
          [`${U}.product`],
          ["clearshelf_off.off_*"],
        );
        break;
      }
      case "declared":
        b = body(template_id, ["declared_key", "market_code", "relation", "source_tag", "display_name"], [], [`${U}.declared_allergen`, `${U}.market_allergen`], ["clearshelf_off.off_*", "clearshelf_ops.market_allergens"]);
        break;
      case "recalls_by_gtin": {
        const rows = links
          .filter((l) => l.gtin === params.gtin)
          .flatMap((l) => w.fda.filter((f) => f.recall_number === l.recall_number).map((f) => [l.link_key, l.raw_code, l.transform, l.extracted_by, ...fdaRow(f)]))
          .sort((a, b) => String(b[5]).localeCompare(String(a[5])));
        b = body(template_id, ["link_key", "raw_code", "transform", "extracted_by", ...FDA_COLS], rows, [`${U}.recall_product_link`, `${U}.fda_recall`], ["clearshelf_ops.recall_links", "clearshelf_fda.enforcement_undeclared"]);
        break;
      }
      case "recalls_by_name": {
        const t = params.brand!;
        const rows = [
          ...w.fda.filter((f) => f.firm.toLowerCase().includes(t) || f.product_description.toLowerCase().includes(t)).map((f) => ["fda", f.recall_number, f.report_date, f.firm, f.product_description.slice(0, 400)]),
          ...w.fsa.filter((a) => a.title.toLowerCase().includes(t) || a.business.toLowerCase().includes(t)).map((a) => ["fsa", a.notation, a.created, a.business, a.title]),
        ];
        b = body(template_id, ["source", "notice_id", "notice_date", "business", "title"], rows, [`${U}.fda_recall`, `${U}.fsa_alert`], ["clearshelf_fda.enforcement_undeclared", "clearshelf_fsa.allergy_alerts"]);
        break;
      }
      case "fda_notice":
        b = body(template_id, FDA_COLS, w.fda.filter((f) => f.recall_number === params.recall_number).map(fdaRow), [`${U}.fda_recall`], ["clearshelf_fda.enforcement_undeclared"]);
        break;
      case "fda_recent":
        b = body(
          template_id,
          ["recall_number", "report_date", "classification", "status", "firm"],
          w.fda.filter((f) => f.report_date >= params.since!).map((f) => [f.recall_number, f.report_date, f.classification, f.status, f.firm]),
          [`${U}.fda_recall`],
          ["clearshelf_fda.enforcement_undeclared"],
        );
        break;
      case "fsa_recent":
        b = body(
          template_id,
          ["notation", "created", "title", "business", "alert_url"],
          w.fsa.filter((a) => a.created >= params.since!).map((a) => [a.notation, a.created, a.title, a.business, `https://example.invalid/${a.notation}`]),
          [`${U}.fsa_alert`],
          ["clearshelf_fsa.allergy_alerts"],
        );
        break;
      case "fsa_allergens":
        b = body(template_id, ["notation", "allergen_label"], (w.fsa.find((a) => a.notation === params.notation)?.allergens ?? []).map((x) => [params.notation, x]), [`${U}.fsa_alert_allergen`], ["clearshelf_fsa.allergy_alerts"]);
        break;
      case "prior_decisions":
        b = body(template_id, DECISION_COLS, decisions.filter((d) => d.gtin === params.gtin).map((d) => DECISION_COLS.map((c) => d[c] ?? null)), [`${U}.decision`], ["clearshelf_ops.decisions"]);
        break;
      case "recheck_cleared": {
        // As the gateway template: the current decision per (gtin, market) only, recalls reported on or after it.
        const latest = new Map<string, string>();
        for (const d of decisions) {
          const k = `${d.gtin}|${d.market}`;
          if (!latest.has(k) || String(d.decided_at) > latest.get(k)!) latest.set(k, String(d.decided_at));
        }
        const rows: unknown[][] = [];
        for (const d of decisions) {
          if (d.status !== "CLEAR" && d.status !== "CLEAR_WITH_STATEMENT") continue;
          if (latest.get(`${d.gtin}|${d.market}`) !== String(d.decided_at)) continue;
          for (const l of links.filter((x) => x.gtin === d.gtin)) {
            for (const f of w.fda.filter((x) => x.recall_number === l.recall_number && x.report_date >= d.decided_date!)) {
              rows.push([d.gtin, d.market, d.status, d.decided_at, d.decided_date, f.recall_number, f.report_date, f.classification, f.status]);
            }
          }
        }
        b = body(
          template_id,
          ["gtin", "market", "status", "decided_at", "decided_date", "recall_number", "report_date", "classification", "recall_status"],
          rows,
          [`${U}.decision`, `${U}.recall_product_link`, `${U}.fda_recall`],
          ["clearshelf_ops.decisions", "clearshelf_ops.recall_links", "clearshelf_fda.enforcement_undeclared"],
        );
        break;
      }
      case "join_map":
        b = body(template_id, ["transform", "links", "in_catalogue"], [], [`${U}.recall_product_link`, `${U}.product`], ["clearshelf_ops.recall_links", "clearshelf_off.off_*"]);
        break;
      default:
        if (template_id === "dq_invalid_has_ingredients") {
          b = body(template_id, ["gtin"], (w.noIngredients ?? []).map((g) => [g]), [`${U}.product`], ["clearshelf_off.off_*"]);
          break;
        }
        if (template_id.startsWith("dq_invalid_")) {
          b = body(template_id, ["gtin", "market_code"], [], [`${U}.product`], ["clearshelf_off.off_*"]);
          break;
        }
        return new Response(JSON.stringify({ error: `unexpected template ${template_id}` }), { status: 400 });
    }
    return new Response(JSON.stringify(b), { status: 200 });
  }) as typeof fetch;
  return new GatewayClient({ fetchImpl, warmRetries: 0 });
}

/** A stub model: notice extraction returns `upcs` (as given); ingredient extraction returns no spans. Counts calls. */
export function stubModel(noticeUpcs: string[] = [], counter = { calls: 0 }): OllamaClient {
  return new OllamaClient({
    baseUrl: "http://127.0.0.1:11434",
    model: "stub",
    ramGuard: false,
    fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
      counter.calls++;
      const req = String(init?.body ?? "");
      const notice = req.includes('"upcs"');
      const content = notice
        ? JSON.stringify({ upcs: noticeUpcs, allergens: ["milk"], product_names: [], brands: [], lots: [], reason_type: "undeclared_allergen" })
        : JSON.stringify({ spans: [], label_language: "en", unparsed_fragments: [] });
      return new Response(JSON.stringify({ message: { content }, eval_count: 20, eval_duration: 1e8, prompt_eval_count: 300, done_reason: "stop" }), { status: 200 });
    }) as typeof fetch,
  });
}
