// SPEC 9.2 extraction measurement: systems K (keyword baseline), N (Nemotron's grounded spans)
// and N+V (the spans the lexicon verifier agrees with), scored against the manifest's reference
// labels (`label_text`). The numbers in docs/eval-report.md section 3 come from this script.
// Its output keeps only group labels and counts, never the label text or spans. One model call
// per SKU, one at a time, after a free-RAM check (the PC runs other model work).
//
//   cd agent && npx tsx src/eval/measure/extraction.ts [limit]

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, REPO_ROOT_URL } from "../../config.ts";
import { scanText, wrapUntrusted } from "../../contract/guard.ts";
import { allergenDisagreements, extractIngredients, verifiedAllergens } from "../../extract/ingredients.ts";
import { OllamaClient } from "../../llm/ollama.ts";
import { keywordBaseline } from "../../verify/lexicon.ts";
import { GatewayClient, rowsAsObjects } from "../../zetaris/client.ts";

export const GROUPS = ["milk", "egg", "fish", "crustacean", "mollusc", "tree_nut", "peanut", "gluten_cereal", "wheat", "soy", "sesame", "celery", "mustard", "lupin", "sulphite"] as const;
export type Group = (typeof GROUPS)[number];
export type Label = "contains" | "may_contain" | "none";
type Ref = Partial<Record<Group, Label | "unscored">>;

/** traps_present key -> the groups a false alarm would land in (maltodextrin has no lexicon trap term; mapped to the gluten groups). */
export const TRAP_GROUPS: Record<string, Group[]> = {
  cocoa_butter: ["milk"],
  coconut: ["tree_nut"],
  shea: ["milk", "tree_nut"],
  coconut_milk: ["milk"],
  buckwheat: ["wheat", "gluten_cereal"],
  cream_of_tartar: ["milk"],
  plant_milk: ["milk"],
  lactic_acid: ["milk"],
  maltodextrin: ["gluten_cereal", "wheat"],
  nutmeg: ["tree_nut"],
};

/** One label per group (contains beats may_contain beats none), with R-WHEAT-IS-GLUTEN applied as in the reference. */
export function labels(pairs: { group: string; relation: string }[]): Record<Group, Label> {
  const out = Object.fromEntries(GROUPS.map((g) => [g, "none"])) as Record<Group, Label>;
  for (const p of pairs) {
    if (!(GROUPS as readonly string[]).includes(p.group)) continue;
    const g = p.group as Group;
    if (p.relation === "contains") out[g] = "contains";
    else if (p.relation === "may_contain" && out[g] === "none") out[g] = "may_contain";
  }
  if (out.wheat === "contains") out.gluten_cereal = "contains";
  return out;
}

export interface SkuRecord {
  gtin: string;
  reference: Ref;
  traps_present: string[];
  lang: string | null;
  K: Record<Group, Label>;
  N: Record<Group, Label>;
  NV: Record<Group, Label>;
}

const rate = (n: number, d: number): number | null => (d ? n / d : null);

/** Precision/recall of `contains` per group (support >= 3) and micro, trap false alarms, precautionary accuracy. */
export function score(sys: "K" | "N" | "NV", recs: SkuRecord[]) {
  const per: Record<string, { tp: number; fp: number; fn: number; support: number }> = {};
  let tp = 0,
    fp = 0,
    fn = 0,
    trapD = 0,
    trapFA = 0,
    precD = 0,
    precOK = 0,
    scored = 0;
  for (const r of recs) {
    const trapGroups = new Set<string>(r.traps_present.flatMap((k) => TRAP_GROUPS[k] ?? []));
    for (const g of GROUPS) {
      const ref = r.reference[g];
      if (!ref || ref === "unscored") continue;
      scored++;
      const got = r[sys][g];
      const p = (per[g] ??= { tp: 0, fp: 0, fn: 0, support: 0 });
      if (ref === "contains") p.support++;
      if (ref === "contains" && got === "contains") {
        p.tp++;
        tp++;
      } else if (ref !== "contains" && got === "contains") {
        p.fp++;
        fp++;
      } else if (ref === "contains" && got !== "contains") {
        p.fn++;
        fn++;
      }
      if (trapGroups.has(g) && ref === "none") {
        trapD++;
        if (got !== "none") trapFA++;
      }
      if (ref === "may_contain") {
        precD++;
        if (got === "may_contain") precOK++;
      }
    }
  }
  const perGroup = Object.fromEntries(
    Object.entries(per)
      .filter(([, v]) => v.support >= 3)
      .map(([g, v]) => [g, { support: v.support, precision: rate(v.tp, v.tp + v.fp), recall: rate(v.tp, v.tp + v.fn), tp: v.tp, fp: v.fp, fn: v.fn }]),
  );
  return {
    scored_pairs: scored,
    per_group_contains_support_ge3: perGroup,
    micro: { precision: rate(tp, tp + fp), recall: rate(tp, tp + fn), tp, fp, fn },
    trap_false_alarm: { rate: rate(trapFA, trapD), alarms: trapFA, pairs: trapD },
    precautionary_accuracy: { rate: rate(precOK, precD), exact: precOK, pairs: precD },
  };
}

const median = (xs: number[]): number | null => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  return a.length ? (a.length % 2 ? a[(a.length - 1) / 2]! : (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2) : null;
};

interface ManifestSku {
  gtin: string;
  display_name?: string;
  role: string;
  off_snapshot?: { lang?: string };
  reference_labels?: { in_extraction_eval?: boolean; label_text?: Ref; traps_present?: string[] };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const gw = new GatewayClient({ baseUrl: cfg.gatewayUrl });
  const ollama = new OllamaClient({ baseUrl: cfg.ollamaUrl, model: cfg.model });
  const manifest = JSON.parse(readFileSync(new URL("data/manifest/skus.json", REPO_ROOT_URL), "utf8")) as { skus: ManifestSku[] };
  const limit = Number(process.argv[2] ?? 999);
  const skus = manifest.skus.filter((s) => s.reference_labels?.in_extraction_eval).slice(0, limit);

  // VRAM: whole GPU (includes other processes on this shared PC).
  const vramSample = (): { used: number; total: number } | null => {
    try {
      const [u, t] = execFileSync("nvidia-smi", ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8" })
        .trim()
        .split(",")
        .map((x) => Number(x));
      return { used: u!, total: t! };
    } catch {
      return null;
    }
  };
  const vramBefore = vramSample();
  let vramPeak = vramBefore?.used ?? 0;
  const timer = setInterval(() => {
    const v = vramSample();
    if (v && v.used > vramPeak) vramPeak = v.used;
  }, 1000);

  const records: (SkuRecord & Record<string, unknown>)[] = [];
  const notMeasured: Record<string, unknown>[] = [];
  const t0 = performance.now();
  for (const s of skus) {
    const st = performance.now();
    const row = rowsAsObjects(await gw.template("product", { gtin: s.gtin }))[0];
    const text = row ? String(row.ingredients_text ?? "").trim() || String(row.ingredients_text_en ?? "").trim() : "";
    if (!row || !text) {
      notMeasured.push({ gtin: s.gtin, display_name: s.display_name, role: s.role, reason: row ? "product row has no ingredient text" : "no product row in Zetaris" });
      process.stderr.write(`${s.gtin} not measured (${row ? "no text" : "no row"})\n`);
      continue;
    }
    // Before loading: 3 GiB + 4.5 GiB for the runner (the warm-up's rule); once resident, a 1 GiB floor.
    const resident = (await ollama.loaded().catch(() => [])).some((m) => m.name === ollama.model);
    const floor = resident ? 1024 ** 3 : (3072 + 4608) * 1048576;
    for (let i = 0; os.freemem() < floor; i++) {
      if (i > 60) throw new Error(`free RAM below ${Math.round(floor / 1048576)} MiB for 10 min`);
      process.stderr.write(`free RAM ${Math.round(os.freemem() / 1048576)} MiB < ${Math.round(floor / 1048576)}, waiting\n`);
      await new Promise((ok) => setTimeout(ok, 10_000));
    }
    const g = scanText(text, "off:ingredients_text");
    const res = await extractIngredients(text, ollama, g.hit ? wrapUntrusted(text, "off:ingredients_text") : undefined);
    const dis = allergenDisagreements(res.agreement, text);
    records.push({
      gtin: s.gtin,
      display_name: s.display_name,
      role: s.role,
      lang: s.off_snapshot?.lang ?? null,
      guard_flagged: g.hit,
      reference: s.reference_labels!.label_text ?? {},
      traps_present: s.reference_labels!.traps_present ?? [],
      K: labels(keywordBaseline(text).map((h) => ({ group: h.group, relation: "contains" }))),
      N: labels(res.spans.map((x) => ({ group: x.allergen_group, relation: x.relation }))),
      NV: labels(verifiedAllergens(res.agreement).map((x) => ({ group: x.group, relation: x.relation }))),
      model: { ok: res.ok, attempts: res.model.attempts, tokens_in: res.model.tokens_in, tokens_out: res.model.tokens_out, tokens_per_s: res.model.tokens_per_s, eval_ms: res.model.eval_ms, label: "measured" },
      spans_grounded: res.spans.length,
      spans_dropped: res.ungrounded.length,
      duplicates: res.duplicates,
      disagreements: dis.length,
      extraction_wall_ms: res.wall_ms,
      sku_wall_ms: Math.round(performance.now() - st),
    });
    process.stderr.write(`${s.gtin} ok=${res.ok} att=${res.model.attempts} ${res.model.tokens_in}/${res.model.tokens_out} ${res.wall_ms} ms dis=${dis.length}\n`);
  }
  clearInterval(timer);
  const ps = await ollama.loaded().catch(() => []);
  const freeLoaded = Math.round(os.freemem() / 1048576);
  await ollama.unload().catch(() => {});
  await new Promise((ok) => setTimeout(ok, 3000));
  const freeUnloaded = Math.round(os.freemem() / 1048576);

  type Rec = (typeof records)[number] & { model: { ok: boolean; attempts: number; tokens_per_s?: number }; disagreements: number; spans_grounded: number; spans_dropped: number; extraction_wall_ms: number; sku_wall_ms: number };
  const recs = records as Rec[];
  const ml = recs.filter((r) => r.lang && r.lang !== "en");
  const flagged = recs.filter((r) => r.disagreements > 0).length;
  const out = {
    generated_at: new Date().toISOString(),
    model: ollama.model,
    label: "measured",
    note: "reference labels = manifest label_text; R-WHEAT-IS-GLUTEN applied to every system",
    skus_in_eval: skus.length,
    measured: recs.length,
    not_measured: notMeasured,
    systems: { K: score("K", recs), N: score("N", recs), "N+V": score("NV", recs) },
    multilingual: { skus: ml.length, langs: [...new Set(ml.map((r) => r.lang))], K: score("K", ml).micro, N: score("N", ml).micro, "N+V": score("NV", ml).micro },
    json_validity: { calls: recs.length, valid_first_attempt: recs.filter((r) => r.model.ok && r.model.attempts === 1).length, valid_at_all: recs.filter((r) => r.model.ok).length },
    nv_flag_rate: { skus_flagged: flagged, skus: recs.length, rate: rate(flagged, recs.length) },
    grounding: { grounded: recs.reduce((a, r) => a + r.spans_grounded, 0), dropped: recs.reduce((a, r) => a + r.spans_dropped, 0) },
    performance: {
      median_tokens_per_s: median(recs.map((r) => r.model.tokens_per_s ?? Number.NaN)),
      median_extraction_s: (median(recs.map((r) => r.extraction_wall_ms)) ?? 0) / 1000,
      median_sku_s: (median(recs.map((r) => r.sku_wall_ms)) ?? 0) / 1000,
      total_s: Math.round(performance.now() - t0) / 1000,
    },
    vram: {
      whole_gpu_mib_before: vramBefore?.used ?? null,
      whole_gpu_mib_peak: vramPeak || null,
      total_mib: vramBefore?.total ?? null,
      ollama_ps: ps.map((m) => ({ name: m.name, size_mib: Math.round(m.size / 1048576), size_vram_mib: Math.round(m.size_vram / 1048576) })),
      label: "measured (nvidia-smi whole GPU incl. other processes; Ollama /api/ps for the model)",
      free_ram_mib_model_loaded: freeLoaded,
      free_ram_mib_after_unload: freeUnloaded,
    },
    records,
  };
  mkdirSync(new URL("data/eval/", REPO_ROOT_URL), { recursive: true });
  const file = fileURLToPath(new URL(`data/eval/extraction-${out.generated_at.replace(/[:.]/gu, "-")}.json`, REPO_ROOT_URL));
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ ...out, records: undefined }, null, 1));
  console.log(`wrote ${file}`);
}

if (process.argv[1] && /measure[\\/]extraction\.ts$/u.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });
}
