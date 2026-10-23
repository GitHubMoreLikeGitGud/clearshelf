// The SKU card: one product in one market. The decision first, in plain words, then where every
// claim came from (source cards with evidence chips), the label as read and verified, the
// statement draft, the officer's signed actions, and the Markovian investigation that produced it.
// The render functions are pure; mount() fetches and wires.

import {
  api,
  decisionSentence,
  esc,
  evidenceChips,
  fmtMs,
  fmtNum,
  fmtTime,
  groupFirings,
  groupWord,
  hasAddress,
  idHtml,
  kindOfTool,
  noAddress,
  OFFICER,
  plainReason,
  rememberEvidence,
  renderError,
  ruleBadge,
  RULES,
  sourceClassWord,
  statusChip,
  stripEvidenceRefs,
  tag,
  verdictChip,
  ZETARIS_HOME,
} from "../lib.js";
import { renderTokenChart } from "./telemetry.js";
import { mountStream } from "./stream.js";

const TO_CONFIRM = "(to confirm)";
const CONFLICT_ID = /\bac-[0-9a-f]{6,}\b/u;

// ---------- source grouping ----------

const SOURCES = [
  { key: "off", name: "Open Food Facts", what: "product row, label text and tags", test: (o) => o.startsWith("clearshelf_off.") },
  { key: "fda", name: "openFDA recalls", what: "enforcement reports naming undeclared allergens", test: (o) => o.startsWith("clearshelf_fda.") },
  { key: "fsa", name: "UK FSA allergy alerts", what: "alerts by business and product name (no GTIN)", test: (o) => o.startsWith("clearshelf_fsa.") },
  { key: "ref", name: "Reference allergen table", what: "statutory allergen lists per market", test: (o) => o === "clearshelf_ops.market_allergens" },
];
const PRIORITY = ["fda", "fsa", "off", "ref"];

function rawOf(rec) {
  return Array.isArray(rec?.raw_objects) ? rec.raw_objects.map(String) : [];
}

/** Every source a record read (by its raw objects). */
export function sourcesOfRecord(rec) {
  const raw = rawOf(rec);
  return SOURCES.filter((s) => raw.some((o) => s.test(o))).map((s) => s.key);
}

function primarySource(rec, byId, depth = 0) {
  if (!rec) return null;
  const keys = sourcesOfRecord(rec);
  const p = PRIORITY.find((k) => keys.includes(k));
  if (p) return p;
  if (depth < 2 && Array.isArray(rec.derived_from)) {
    for (const id of rec.derived_from) {
      const s = primarySource(byId.get(id), byId, depth + 1);
      if (s) return s;
    }
  }
  return null;
}

function isRecordedClaim(rec, byId) {
  if (!rec) return false;
  if (rec.kind === "world_model") return true;
  if (rec.template_id === "prior_decisions") return true;
  if (rec.kind === "memory" && Array.isArray(rec.derived_from)) return rec.derived_from.some((id) => byId.get(id)?.kind === "policy");
  return false;
}

/**
 * Where each card claim is shown: "band" (the decision), "contradiction" (its own panel),
 * "dq", "memory", "recorded" (closed loop) or a source key. Every claim lands somewhere.
 */
export function groupClaims(card, records) {
  const byId = new Map((records ?? []).map((r) => [r.id, r]));
  const groups = { band: [], contradiction: [], dq: [], memory: [], recorded: [], other: [] };
  for (const s of SOURCES) groups[s.key] = [];
  for (const c of Array.isArray(card) ? card : []) {
    const first = byId.get(c.evidenceIds?.[0]);
    let g = "other";
    if (/^Contradiction \(/u.test(c.text ?? "")) g = "contradiction";
    else if (first?.kind === "policy") g = "band";
    else if (isRecordedClaim(first, byId)) g = "recorded";
    else if (first?.kind === "dq") g = "dq";
    else if (first?.kind === "memory") g = "memory";
    else g = primarySource(first, byId) ?? "other";
    groups[g].push(c);
  }
  return groups;
}

// ---------- label text and spans ----------

/** The ingredient text from the product evidence record (the run itself does not carry it). */
export function ingredientText(run, records) {
  const rec = (records ?? []).find((r) => r.template_id === "product" && Array.isArray(r.columns) && Array.isArray(r.rows) && r.rows.length);
  if (!rec) return { text: null, record: null };
  const field = run?.product?.text_field ?? "ingredients_text";
  const idx = rec.columns.indexOf(field);
  const text = idx >= 0 ? rec.rows[0][idx] : null;
  return { text: typeof text === "string" && text.trim() ? text : null, record: rec, field };
}

/** The verifier's agreement table for the ingredient extraction, with its record. */
export function agreementOf(records) {
  const rec = (records ?? []).find((r) => r.kind === "verifier" && Array.isArray(r.details?.agreement));
  return { rows: rec ? rec.details.agreement : [], record: rec ?? null };
}

const REL_LABEL = { contains: "contains", may_contain: "may contain", not_allergen: "not an allergen", free_from: "free from" };

function kwTitle(kws) {
  return kws.map((k) => `keyword rule flags "${k.term}" as ${groupWord(k.group)} (contains)`).join("; ");
}

/**
 * The label text with every span the model or the verifier named highlighted: a tick when they
 * agreed, a cross when they did not. Overlaps go to the longer span. `checks` (from GET
 * /api/sku label_checks) adds the verifier's trap readings ("cocoa butter is not milk fat")
 * and marks every keyword-baseline hit with a K, so a keyword false positive shows where it is.
 * All text is escaped.
 */
export function highlightSpans(text, agreement, checks = null) {
  const src = String(text ?? "");
  const lower = src.toLowerCase();
  const fold = lower.length === src.length ? (s) => s.toLowerCase() : (s) => s;
  const hay = lower.length === src.length ? lower : src;
  const cands = [];
  (Array.isArray(agreement) ? agreement : []).forEach((a, i) => {
    const needle = fold(String(a?.evidence_text ?? ""));
    if (needle.length < 2) return;
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      cands.push({ start: at, end: at + needle.length, a, i, type: "span" });
      from = at + needle.length;
    }
  });
  cands.sort((x, y) => y.end - y.start - (x.end - x.start) || x.start - y.start || x.i - y.i);
  const chosen = [];
  for (const c of cands) if (!chosen.some((k) => c.start < k.end && k.start < c.end)) chosen.push(c);
  const inText = (h) => Number.isInteger(h?.start) && Number.isInteger(h?.end) && h.start >= 0 && h.end <= src.length && h.end > h.start;
  for (const t of Array.isArray(checks?.traps) ? checks.traps.filter(inText) : []) {
    if (!chosen.some((k) => t.start < k.end && k.start < t.end)) chosen.push({ start: t.start, end: t.end, trap: t, type: "trap" });
  }
  for (const c of chosen) c.kw = [];
  for (const k of Array.isArray(checks?.keyword) ? checks.keyword.filter(inText) : []) {
    const host = chosen.find((c) => c.type !== "kw" && k.start < c.end && c.start < k.end);
    if (host) host.kw.push(k);
    else chosen.push({ start: k.start, end: k.end, kw: [k], type: "kw" });
  }
  chosen.sort((x, y) => x.start - y.start);
  let out = "";
  let pos = 0;
  for (const c of chosen) {
    if (c.start < pos) continue;
    out += esc(src.slice(pos, c.start));
    const kwMark = c.kw.length ? `<span class="kw" aria-hidden="true">K</span>` : "";
    const kwText = c.kw.length ? `; ${kwTitle(c.kw)}` : "";
    const body = esc(src.slice(c.start, c.end));
    if (c.type === "span") {
      const a = c.a;
      const rel = a.relation ?? "contains";
      const ok = !!a.agree;
      const desc = `${a.group && a.group !== "none" ? a.group.replace("_", " ") : "no allergen group"}, ${REL_LABEL[rel] ?? rel}; model ${a.model ? "named it" : "missed it"}, verifier ${a.lexicon ? "named it" : "did not"}${a.lexicon_relation && a.lexicon_relation !== rel ? ` (verifier reads ${REL_LABEL[a.lexicon_relation] ?? a.lexicon_relation})` : ""}; ${ok ? "agreed" : "disagreed"}${kwText}`;
      out += `<mark class="sp sp--${esc(rel)} ${ok ? "sp--ok" : "sp--bad"}${c.kw.length ? " sp--kw" : ""}" title="${esc(desc)}" data-agree="${ok ? "yes" : "no"}">${body}<span class="sp__v" aria-hidden="true">${ok ? "✓" : "✗"}</span>${kwMark}<span class="sr-only"> (${esc(desc)})</span></mark>`;
    } else if (c.type === "trap") {
      const desc = `verifier reads "${c.trap.term}" as not an allergen: ${c.trap.reason}; the model named no allergen here${kwText}`;
      out += `<mark class="sp sp--not_allergen sp--trap${c.kw.length ? " sp--kw" : ""}" title="${esc(desc)}" data-trap="yes">${body}<span class="sp__v" aria-hidden="true">✓</span>${kwMark}<span class="sr-only"> (${esc(desc)})</span></mark>`;
    } else {
      const desc = `${kwTitle(c.kw)}; neither the model nor the verifier names an allergen here`;
      out += `<mark class="kw-hit" title="${esc(desc)}">${body}${kwMark}<span class="sr-only"> (${esc(desc)})</span></mark>`;
    }
    pos = c.end;
  }
  return out + esc(src.slice(pos));
}

/** Where the keyword baseline and the verified reading part ways, in plain lines. */
export function keywordNotes(text, agreement, checks) {
  const src = String(text ?? "");
  const hay = src.toLowerCase();
  const spans = [];
  for (const a of Array.isArray(agreement) ? agreement : []) {
    const needle = String(a?.evidence_text ?? "").toLowerCase();
    if (needle.length < 2) continue;
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) spans.push({ start: at, end: at + needle.length, rel: a.relation ?? "contains" });
  }
  const traps = Array.isArray(checks?.traps) ? checks.traps : [];
  const out = [];
  for (const k of Array.isArray(checks?.keyword) ? checks.keyword : []) {
    const trap = traps.find((t) => k.start < t.end && t.start < k.end);
    const span = spans.find((s) => k.start < s.end && s.start < k.end);
    if (trap) out.push(`"${k.term}" is inside "${trap.term}": the keyword rule calls it ${groupWord(k.group)}; the verifier reads it as not an allergen (${trap.reason}).`);
    else if (span && span.rel === "may_contain") out.push(`"${k.term}": the keyword rule says contains; the label says may contain (precautionary).`);
    else if (span && span.rel === "not_allergen") out.push(`"${k.term}": the keyword rule says ${groupWord(k.group)}; model and verifier read it as not an allergen.`);
    else if (!span) out.push(`"${k.term}": the keyword rule says ${groupWord(k.group)}; neither the model nor the verifier names an allergen there.`);
  }
  return [...new Set(out)];
}

// ---------- what the card knows beyond the run ----------

/** The proposal behind a run, and what happened to it (from GET /api/approvals). */
export function proposalOf(run, queue) {
  const id = run?.saved?.queue_id ?? null;
  if (!id) return null;
  return (Array.isArray(queue) ? queue : []).find((q) => q.id === id) ?? { id, state: "unknown" };
}

/** Every allergen this run knows of, with where it came from (for the release warning). */
export function knownAllergens(run) {
  const out = new Map();
  const add = (g, why) => {
    if (!g || g === "none") return;
    if (!out.has(g)) out.set(g, new Set());
    out.get(g).add(why);
  };
  for (const v of run?.extraction?.verified ?? []) if (v.relation === "contains" || v.relation === "may_contain") add(v.group, `label: ${REL_LABEL[v.relation]}`);
  for (const n of run?.notices ?? []) for (const g of n.undeclared_groups ?? []) add(g, `FDA ${n.recall_number}: undeclared`);
  for (const c of run?.claim_tests ?? []) for (const g of c.contradicting ?? []) add(g, `contradicts the "${c.claim}" claim`);
  for (const e of [...(run?.statement?.contains ?? []), ...(run?.statement?.toConfirm ?? [])]) for (const g of e.groups ?? []) add(g, "statement draft");
  return [...out.entries()].map(([group, why]) => ({ group, why: [...why] }));
}

/** The resolution of an H-MEM conflict named in a text, when it was resolved after the run. */
function resolvedConflict(text, conflicts) {
  const id = (CONFLICT_ID.exec(String(text ?? "")) ?? [])[0];
  if (!id) return null;
  const c = (conflicts ?? []).find((x) => x.id === id);
  return c && c.status !== "queued" && c.resolution ? c : null;
}

function resolvedNote(c) {
  const r = c.resolution;
  const kept = r.outcome === "keep_both" ? "kept both sides" : `kept ${r.winner === c.a ? `the ${String(c.polarityA).replace("_", " ")} side (${sourceClassWord(c.classA)})` : `the ${String(c.polarityB).replace("_", " ")} side (${sourceClassWord(c.classB)})`}`;
  return `<p class="since"><strong>Resolved since this run</strong> by ${r.by === OFFICER ? "<strong>officer</strong>" : esc(r.by)}, ${esc(fmtTime(r.at))}: ${esc(kept)}, rule <code>${esc(r.rule)}</code>. Re-clear to update the decision.</p>`;
}

// ---------- pieces ----------

function claimList(items, emptyText) {
  if (!items.length) return emptyText ? `<p class="muted small">${esc(emptyText)}</p>` : "";
  return `<ul class="claims">${items.map((c) => `<li><span class="claims__text">${esc(noAddress(c.text))}</span> ${evidenceChips(null, c.evidenceIds)}</li>`).join("")}</ul>`;
}

function sourceMeta(key, records) {
  const def = SOURCES.find((s) => s.key === key);
  for (const r of records) {
    for (const s of Array.isArray(r.sources) ? r.sources : []) {
      if (def.test(String(s.object ?? ""))) return { licence: s.licence, cached: s.cached_at, object: s.object };
    }
  }
  return null;
}

function nameMatchItems(run, source) {
  return (Array.isArray(run.name_matches) ? run.name_matches : []).filter((n) => n.source === source);
}

function sourceCard(def, claims, records, run) {
  const touching = records.filter((r) => sourcesOfRecord(r).includes(def.key));
  const meta = sourceMeta(def.key, touching);
  const cited = new Set(claims.flatMap((c) => c.evidenceIds ?? []));
  const extra = touching.filter((r) => !cited.has(r.id)).map((r) => r.id);
  const names = def.key === "fda" || def.key === "fsa" ? nameMatchItems(run, def.key) : [];
  const nc = def.key === "fsa" ? (run.not_checked ?? []).find((n) => n.id === "fsa_no_gtin") : null;
  const body = [];
  body.push(claimList(claims, touching.length || names.length ? "" : "Nothing was read from this source in this run."));
  if (names.length) {
    // Highest similarity first; the rest fold away so one noisy brand token cannot swamp the card.
    const sorted = [...names].sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    const li = (n) => `<li><span class="claims__text"><code>${esc(n.notice_id)}</code> ${esc(n.notice_date ?? "")} ${esc(n.business ?? "")}: ${esc(noAddress(n.title))} <span class="muted">similarity ${esc(fmtNum(n.similarity, 2))}</span></span> ${evidenceChips(null, n.evidenceIds)}</li>`;
    const top = sorted.slice(0, 3);
    const more = sorted.slice(3);
    body.push(`<h4 class="src__sub">${esc(fmtNum(names.length))} name-only match${names.length === 1 ? "" : "es"} for review (R2, no status change)</h4><ul class="claims claims--names">${top.map(li).join("")}</ul>${
      more.length ? `<details class="src__more"><summary>${esc(fmtNum(more.length))} more, lower similarity</summary><ul class="claims claims--names">${more.map(li).join("")}</ul></details>` : ""
    }`);
  }
  if (nc && !claims.length) body.push(`<p class="muted small">${esc(nc.text)}</p>`);
  if (extra.length) body.push(`<p class="src__also">Also read: ${evidenceChips(null, extra, { max: 4 })}</p>`);
  return `<article class="src src--${def.key}${claims.length || names.length ? "" : " src--empty"}" aria-labelledby="src-${def.key}">
    <header class="src__head"><h3 id="src-${def.key}">${esc(def.name)}</h3><p class="src__what">${esc(def.what)}</p></header>
    ${body.join("")}
    <footer class="src__foot">${meta ? `${esc(meta.licence ?? "")}${meta.cached ? `; cached ${esc(fmtTime(meta.cached))}` : String(meta.object ?? "").startsWith("clearshelf_ops.") ? "; live read (ops table)" : ""}` : `<span class="muted">not read</span>`}</footer>
  </article>`;
}

function dqCard(claims, run) {
  const dq = Array.isArray(run.dq) ? run.dq : [];
  const used = new Set();
  const lines = dq.map((d) => {
    const c = claims.find((x) => !used.has(x) && (x.text ?? "").startsWith(`DQ ${d.rule} on ${d.table} `));
    if (c) used.add(c);
    return `<li class="${d.invalid ? "dq--bad" : "dq--ok"}"><span class="dq__mark" aria-hidden="true">${d.invalid ? "✗" : "✓"}</span><code>${esc(d.rule)}</code> on <code>${esc(d.table)}</code>: ${d.invalid ? `<strong>${esc(fmtNum(d.invalid))} invalid record${d.invalid === 1 ? "" : "s"}</strong>` : "no invalid record"}${d.other_market ? `, ${esc(fmtNum(d.other_market))} in the other market` : ""} <span class="muted">${d.source === "zetaris_dq" ? "Zetaris DQ" : d.source === "dq_equivalent_sql" ? "DQ-equivalent SQL" : esc(d.source ?? "")}</span> ${c ? evidenceChips(null, c.evidenceIds) : ""}</li>`;
  });
  const rest = claims.filter((c) => !used.has(c));
  return `<article class="src src--dq" aria-labelledby="src-dq">
    <header class="src__head"><h3 id="src-dq">Zetaris data-quality gate</h3><p class="src__what">rules on the clearance USL; an invalid record holds the listing (R3)</p></header>
    ${dq.length ? `<ul class="dq">${lines.join("")}</ul>` : ""}
    ${claimList(rest, dq.length ? "" : "The DQ gate did not run in this investigation.")}
  </article>`;
}

function labelPanel(run, records, checks) {
  const { text, record, field } = ingredientText(run, records);
  const { rows, record: vrec } = agreementOf(records);
  const ex = run.extraction ?? {};
  const mrec = (records ?? []).find((r) => r.kind === "model_extraction" && r.details?.text_field);
  const notChecked = (run.not_checked ?? []).find((n) => n.id === "no_ingredient_list");
  if (!text) {
    return `<section class="panel label-panel" aria-labelledby="h-label"><h2 id="h-label" class="panel__h">The label as read</h2>
      <p class="label-panel__none">${esc(notChecked?.text ?? "No ingredient text in the source for this product.")}</p>
      ${record ? `<p class="small">Product row ${evidenceChips(null, [record.id])}</p>` : ""}</section>`;
  }
  const agreed = rows.filter((a) => a.agree).length;
  const notes = keywordNotes(text, rows, checks);
  const kwGroups = Array.isArray(ex.keyword_contains) ? ex.keyword_contains : [];
  const hasKw = Array.isArray(checks?.keyword) && checks.keyword.length;
  return `<section class="panel label-panel" aria-labelledby="h-label">
    <h2 id="h-label" class="panel__h">The label as read <span class="panel__note">${esc(field ?? "")} from Open Food Facts ${record ? evidenceChips(null, [record.id]) : ""}</span></h2>
    <div class="pack" lang="${esc(run.product?.lang ?? "")}">
      <p class="pack__title">Ingredients</p>
      <p class="pack__text">${highlightSpans(text, rows, checks)}</p>
    </div>
    <div class="label-panel__meta">
      <p class="legend legend--spans"><span><mark class="sp sp--contains sp--ok">contains<span class="sp__v" aria-hidden="true">✓</span></mark></span><span><mark class="sp sp--may_contain sp--ok">may contain<span class="sp__v" aria-hidden="true">✓</span></mark></span><span><mark class="sp sp--not_allergen sp--ok">not an allergen<span class="sp__v" aria-hidden="true">✓</span></mark></span>${hasKw ? `<span><span class="kw" aria-hidden="true">K</span> keyword rule hit</span>` : ""}<span>✓ model and verifier agree, <span class="cross">✗</span> they disagree (held for the officer)</span></p>
      <p class="small">${ex.ran ? `Nemotron named ${esc(fmtNum(ex.spans))} span${ex.spans === 1 ? "" : "s"}${ex.reused ? " (reused from memory: same text, same model)" : ""}; the verifier agreed on ${esc(fmtNum(agreed))} of ${esc(fmtNum(rows.length))} ${mrec ? evidenceChips(null, [mrec.id]) : ""} ${vrec ? evidenceChips(null, [vrec.id]) : ""}` : "No extraction ran."}${ex.unparsed_fragments?.length ? ` ${esc(fmtNum(ex.unparsed_fragments.length))} fragment(s) could not be parsed.` : ""}</p>
      ${
        kwGroups.length
          ? `<div class="baseline small"><p><strong>Keyword baseline</strong>, for comparison only (it decides nothing): it would mark <strong>${esc(kwGroups.map(groupWord).join(", "))}</strong> as contains${hasKw ? `, from the words marked <span class="kw" aria-hidden="true">K</span> above` : ""}.</p>${notes.length ? `<ul class="baseline__diff">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}</div>`
          : ""
      }
    </div>
  </section>`;
}

function entryList(title, entries, cls = "") {
  if (!entries?.length) return "";
  return `<div class="stmt__group ${cls}"><h4>${esc(title)}</h4><ul>${entries.map((e) => `<li>${esc(e.label ?? e.name ?? e.group)}${e.reason ? ` <span class="muted">${esc(e.evidence_text ? `"${e.evidence_text}": ` : "")}${esc(e.reason)}</span>` : ""} ${evidenceChips(null, e.evidenceIds)}</li>`).join("")}</ul></div>`;
}

function boldMarked(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/gu, "<b>$1</b>");
}

function statementPanel(run) {
  const st = run.statement;
  if (!st) return `<section class="panel" aria-labelledby="h-stmt"><h2 id="h-stmt" class="panel__h">Statement draft</h2><p class="muted small">No statement: ${run.decision?.status === "HOLD" || run.decision?.status === "BLOCK" ? "the listing is not being cleared." : "nothing to state."}</p></section>`;
  const toConfirm = Array.isArray(st.toConfirm) && st.toConfirm.length;
  return `<section class="panel" aria-labelledby="h-stmt">
    <h2 id="h-stmt" class="panel__h">Statement draft <span class="panel__note">${esc(st.market ?? run.market)}; built from verified spans only</span></h2>
    <p class="stmt__text">${esc(st.text).replaceAll(esc(TO_CONFIRM), `<span class="to-confirm">${esc(TO_CONFIRM)}</span>`)}</p>
    ${toConfirm ? `<p class="msg msg--warn small">Entries marked "to confirm" are allergens the verifier found that no verified span states: the model missed or contradicted them. They stay in the draft so it never under-declares, and the statement cannot be signed until they are confirmed or removed.</p>` : ""}
    ${entryList("Contains", st.contains)}
    ${entryList("May contain", st.mayContain)}
    ${entryList("To confirm", st.toConfirm, "stmt__group--confirm")}
    ${entryList("Kept out of the statement", st.excluded, "stmt__group--excluded")}
    ${st.ingredientsMarked ? `<details class="stmt__ing"><summary>Ingredient list with allergens in bold</summary><p>${boldMarked(st.ingredientsMarked)}</p></details>` : ""}
  </section>`;
}

function reasonBox(id, label = "Reason (required, recorded in memory)") {
  return `<label class="field" for="${id}"><span class="field__label">${esc(label)}</span><textarea id="${id}" name="reason" rows="2" required data-reason></textarea></label>`;
}

/** The allergen names a statement draft carries (an edit that drops one is flagged). */
function statementNames(run) {
  const st = run?.statement;
  if (!st) return [];
  return [...(st.contains ?? []), ...(st.mayContain ?? [])].map((e) => String(e.name ?? e.label ?? "")).filter(Boolean);
}

/** What the officer is about to sign, filled live from the form. */
function signBox(fields) {
  return `<dl class="sign" data-sign>
    <div class="sign__row"><dt>Action</dt><dd data-sign-action>${esc(fields.action)}</dd></div>
    <div class="sign__row"><dt>Product</dt><dd>${esc(fields.name)} <code class="gtin">${esc(fields.gtin)}</code></dd></div>
    <div class="sign__row"><dt>Market</dt><dd>${esc(fields.market)}</dd></div>
    <div class="sign__row"><dt>Status written</dt><dd data-sign-status>${esc(fields.status ?? "choose below")}</dd></div>
    <div class="sign__row"><dt>Statement</dt><dd data-sign-statement>${fields.statement ? esc(fields.statement) : `<span class="muted">none</span>`}</dd></div>
    <div class="sign__row"><dt>Signed as</dt><dd><strong>${esc(OFFICER)}</strong> <span class="muted">(local demo identity)</span></dd></div>
  </dl>
  <p class="small muted">The server signs a one-time contract for exactly these values, valid for 15 minutes. Anything changed after signing is refused.</p>`;
}

/** The officer's panel: sign a pending proposal, or hold, block or release by hand. */
export function actionPanel(gtin, market, entry, run, opts = {}) {
  const pending = (entry?.pending ?? []).filter((q) => q.kind === "proposal" && q.state === "pending");
  const names = (entry?.pending ?? []).filter((q) => q.kind === "name_match" && q.state === "pending");
  const cur = entry?.decision ?? null;
  const pname = opts.name ?? run?.product?.name ?? gtin;
  const parts = [];
  for (const q of pending) {
    const stmt = q.statement ?? "";
    const unconfirmed = stmt.includes(TO_CONFIRM);
    const editable = q.status === "CLEAR_WITH_STATEMENT";
    const allergenNames = run?.run_id === q.run_id ? statementNames(run) : [];
    parts.push(`<form class="act act--sign" data-form="proposal" data-queue="${esc(q.id)}" data-status="${esc(q.status)}" data-names="${esc(allergenNames.join("|"))}" novalidate>
      <h3 class="act__h">Waiting for your signature</h3>
      <p class="act__what">${statusChip(q.status, { proposed: true })} proposed ${esc(fmtTime(q.created_at))} <code class="small">${esc(q.id)}</code>${q.replay ? ` ${tag(q.replay.banner, "replay")}` : ""}</p>
      <ul class="act__reasons">${(q.reasons ?? []).map((r) => {
        const m = /^(R\d|ESC) (.*)$/u.exec(r);
        return m ? `<li>${ruleBadge(m[1])} ${esc(plainReason(m[1], m[2]))}</li>` : `<li>${esc(r)}</li>`;
      }).join("")}</ul>
      <label class="field" for="stmt-${esc(q.id)}"><span class="field__label">Statement${editable ? " (edit it if the label needs a correction)" : ""}</span>
        <textarea id="stmt-${esc(q.id)}" name="statement" rows="2" ${editable ? "" : "readonly"} data-original="${esc(stmt)}">${esc(stmt)}</textarea></label>
      <div class="msg msg--warn small" data-removed hidden></div>
      ${signBox({ action: q.status.replaceAll("_", " "), name: pname, gtin, market, status: q.status.replaceAll("_", " "), statement: stmt })}
      ${reasonBox(`reason-${esc(q.id)}`)}
      <div class="act__buttons">
        <button type="submit" class="btn btn--primary" data-act="approve" disabled>Approve and sign</button>
        <button type="button" class="btn btn--danger-ghost" data-act="reject" disabled>Reject (holds the listing)</button>
      </div>
      <p class="act__hint small" data-hint>${unconfirmed ? `The statement still has entries marked "${esc(TO_CONFIRM)}". Confirm or remove them before approving.` : `The decision is written only with the signed contract; HOLD and BLOCK need no signature, clearing always does.`}</p>
      <div data-result aria-live="polite"></div>
    </form>`);
  }
  if (!pending.length && cur?.status === "HOLD") {
    const stmt = run?.statement?.text ?? "";
    const over = groupFirings((run?.decision?.firings ?? []).filter((f) => f.effect === "HOLD" || f.effect === "BLOCK"));
    const allergens = run ? knownAllergens(run) : [];
    parts.push(`<details class="act act--release"><summary>Release this hold (needs your signature)</summary>
      <form data-form="release" data-allergens="${allergens.length}" novalidate>
        ${
          over.length
            ? `<div class="override"><p class="override__h">You would be overriding</p><ul class="override__list">${over
                .map(([rule, fs]) => `<li>${ruleBadge(rule)} <span class="override__name">${esc(RULES[rule]?.name ?? rule)}</span>: ${esc([...new Set(fs.map((f) => plainReason(rule, f.reason)))].join("; "))}</li>`)
                .join("")}</ul></div>`
            : `<p class="small muted">The run behind this hold is not on file; read the decision's reason before releasing.</p>`
        }
        <fieldset class="field"><legend class="field__label">Release as (choose one)</legend>
          <label><input type="radio" name="status" value="CLEAR_WITH_STATEMENT"> CLEAR WITH STATEMENT</label>
          <label><input type="radio" name="status" value="CLEAR"> CLEAR (no allergen statement)</label></fieldset>
        ${
          allergens.length
            ? `<div class="msg msg--warn small" data-clear-warn hidden><p><strong>CLEAR publishes no allergen statement</strong>, but this product has: ${allergens.map((a) => `<strong>${esc(groupWord(a.group))}</strong> (${esc(a.why.join("; "))})`).join(", ")}.</p>
              <label class="ack"><input type="checkbox" data-ack> I have checked that no allergen statement is needed</label></div>`
            : ""
        }
        <label class="field" for="rel-stmt"><span class="field__label">Statement (for CLEAR WITH STATEMENT)${stmt ? "" : ": this run built no draft, so write it"}</span><textarea id="rel-stmt" name="statement" rows="2">${esc(stmt)}</textarea></label>
        ${signBox({ action: "RELEASE", name: pname, gtin, market, status: null, statement: null })}
        ${reasonBox("rel-reason")}
        <div class="act__buttons"><button type="submit" class="btn btn--primary" data-act="release" disabled>Sign and release</button></div>
        <p class="act__hint small">The server refuses a release while an allergen conflict is queued for this product, while untrusted text is unresolved, or while a recall is open.</p>
        <div data-result aria-live="polite"></div>
      </form></details>`);
  }
  parts.push(`<details class="act act--manual"><summary>Hold or block by hand</summary>
    <form data-form="manual" novalidate>
      ${reasonBox("man-reason")}
      <div class="act__buttons"><button type="button" class="btn btn--hold" data-act="HOLD" disabled>Hold</button><button type="button" class="btn btn--block" data-act="BLOCK" disabled>Block</button></div>
      <p class="act__hint small">HOLD and BLOCK are low risk: the server applies them without a signature and supersedes any pending proposal.</p>
      <div data-result aria-live="polite"></div>
    </form></details>`);
  if (names.length) {
    parts.push(`<div class="act"><h3 class="act__h">Name-only recall matches to review</h3><p class="small">Review them on the Recall watch screen: ${names.map((n) => `<code>${esc(n.notice_id ?? n.id)}</code>`).join(", ")}. <a href="#/watch">Open the recall watch</a></p></div>`);
  }
  return `<section class="panel panel--action" aria-labelledby="h-act"><h2 id="h-act" class="panel__h">Officer actions</h2>${parts.join("")}</section>`;
}

/** The contract verifier's log for this listing (GET /api/contracts/log): issued, verified, refused. */
export function contractLog(entries, gtin, market) {
  const mine = (Array.isArray(entries) ? entries : []).filter((e) => e?.params?.gtin === gtin && (!e.params.market || e.params.market === market)).slice(-8).reverse();
  return `<section class="panel" aria-labelledby="h-clog"><h2 id="h-clog" class="panel__h">Contract log <span class="panel__note">every signature check for this listing, refusals included</span></h2>${
    mine.length
      ? `<ol class="clog">${mine
          .map(
            (e) =>
              `<li class="clog__i clog__i--${e.ok ? "ok" : "bad"}"><span class="clog__t">${esc(fmtTime(e.at))}</span> <strong>${esc(e.action ?? "")}</strong> ${e.ok ? `<span class="tick">accepted</span>` : `<span class="cross">refused${e.code ? ` (${esc(e.code)})` : ""}</span>`} <code class="small">${idHtml(e.contract_id ?? "no contract")}</code>${e.reason ? `<span class="small muted"> ${esc(e.reason)}</span>` : ""}</li>`,
          )
          .join("")}</ol>`
      : `<p class="muted small">No contract has been checked for this listing yet.</p>`
  }</section>`;
}

/** The decision band: what was decided, in one sentence, why (grouped by rule), and what stands now. */
function band(gtin, market, run, cur, groups, ctx) {
  const d = run.decision ?? {};
  const status = d.status;
  const firings = (d.firings ?? []).filter((f) => f.effect !== "INFO" && f.effect !== "REVIEW");
  const rules = [...new Set(firings.map((f) => f.rule))];
  const review = d.review ?? [];
  const claim = groups.band[0];
  const policyEv = claim?.evidenceIds?.find((id) => (ctx.records ?? []).some((r) => r.id === id && r.kind === "policy")) ?? null;
  const prop = proposalOf(run, ctx.queue);
  const saved = run.saved ?? {};
  let label;
  let proposed = false;
  let how = "";
  if (saved.applied === true && d.autoExecutable) {
    label = "Decision, applied automatically";
    how = "HOLD and BLOCK are applied without a signature, and the officer is notified.";
  } else if (prop) {
    const r = prop.resolution;
    if (prop.state === "pending") {
      label = "Proposed by the policy: waiting for your signature";
      proposed = true;
      how = "Nothing is written until you approve and sign.";
    } else if (prop.state === "executed") {
      label = "Proposed by the policy, approved and signed";
      how = `Signed by ${r?.by === OFFICER ? "<strong>officer</strong>" : esc(r?.by ?? "")}${r?.at ? `, ${esc(fmtTime(r.at))}` : ""}${r?.decision_id ? `: decision <code>${idHtml(r.decision_id)}</code>` : ""}${r?.contract_id ? `, contract <code>${idHtml(r.contract_id)}</code>` : ""}.`;
    } else if (prop.state === "rejected") {
      label = "Proposed by the policy, rejected by the officer";
      proposed = true;
      how = `Rejected${r?.at ? ` ${esc(fmtTime(r.at))}` : ""}${r?.reason ? `: "${esc(r.reason)}"` : ""}; the listing was held.`;
    } else if (prop.state === "superseded") {
      label = "Proposed by the policy, superseded";
      proposed = true;
      how = `A later decision replaced this proposal${r?.reason ? `: ${esc(r.reason)}` : ""}.`;
    } else {
      label = "Proposed by the policy";
      proposed = true;
      how = d.pendingSignature ? "Pending the officer's signed approval." : "";
    }
  } else if (saved.applied === false) {
    label = "Proposed by the policy in a run that applied nothing";
    proposed = true;
  } else {
    label = d.autoExecutable ? "Decision, applied automatically" : "Proposed by the policy";
    proposed = !d.autoExecutable;
  }
  const differs = cur && cur.status !== status;
  const conflicts = ctx.conflicts ?? [];
  const groupsByRule = groupFirings(firings);
  const firingLi = (f) => {
    const since = resolvedConflict(f.reason, conflicts);
    return `<li class="firing"><span class="firing__plain" title="${esc(f.reason)}">${esc(plainReason(f.rule, f.reason))}</span> ${evidenceChips(null, f.evidenceIds)}${since ? resolvedNote(since) : ""}</li>`;
  };
  const ruleRows = groupsByRule
    .map(([rule, fs]) => {
      const effects = [...new Set(fs.map((f) => f.effect))];
      const shown = rule === "R4" && fs.length > 3 ? fs.slice(0, 3) : fs;
      const rest = fs.length - shown.length;
      return `<div class="rulegroup"><dt class="rulegroup__h">${ruleBadge(rule)} <span class="rulegroup__name">${esc(RULES[rule]?.name ?? rule)}${fs.length > 1 ? ` <span class="rulegroup__n">${esc(fmtNum(fs.length))}</span>` : ""}</span>${effects.length === 1 && effects[0] !== status ? ` ${statusChip(effects[0])}` : ""}</dt>
        <dd><ul class="firings">${shown.map(firingLi).join("")}</ul>${rest ? `<details class="rulegroup__more"><summary>${esc(fmtNum(rest))} more</summary><ul class="firings">${fs.slice(shown.length).map(firingLi).join("")}</ul></details>` : ""}</dd></div>`;
    })
    .join("");
  const notes = (d.notes ?? []).map((f) => `<li class="firing firing--note">${ruleBadge(f.rule)} <span class="firing__plain">${esc(f.reason)}</span> ${evidenceChips(null, f.evidenceIds)}</li>`).join("");
  return `<section class="band band--${esc(String(status ?? "").toLowerCase())}${proposed ? " band--proposed" : ""}" aria-labelledby="h-band">
    <div class="band__main">
      <h2 class="band__k" id="h-band">${esc(label)}</h2>
      <p class="band__status">${statusChip(status, { large: true, proposed })}</p>
      <p class="band__sentence">${esc(decisionSentence(status, firings))} ${policyEv ? evidenceChips(null, [policyEv]) : ""}</p>
      ${how ? `<p class="band__how">${how}</p>` : ""}
    </div>
    <div class="band__why">
      <h3 class="sr-only">Why, by rule</h3>
      <dl class="rulegroups">${ruleRows}</dl>
      ${notes ? `<ul class="firings firings--notes">${notes}</ul>` : ""}
      ${review.length ? `<details class="band__review"><summary>${esc(fmtNum(review.length))} name-only review item${review.length === 1 ? "" : "s"} (R2): no status change</summary><ul>${review.map((f) => `<li>${esc(noAddress(f.reason))} ${evidenceChips(null, f.evidenceIds)}</li>`).join("")}</ul></details>` : ""}
      <details class="band__raw"><summary>The policy's exact words</summary><ol>${(d.firings ?? []).map((f) => `<li>${ruleBadge(f.rule)} ${statusChip(f.effect)} ${esc(f.reason)}</li>`).join("")}</ol>${claim ? `<p class="small">${esc(claim.text)} ${evidenceChips(null, claim.evidenceIds, { max: 4 })}</p>` : ""}</details>
    </div>
    <div class="band__current">
      <h3 class="band__k">Current decision in Zetaris</h3>
      ${
        cur
          ? `<p>${statusChip(cur.status)} <code class="small">${idHtml(cur.decision_id)}</code>${String(cur.decision_id).startsWith("rp-") ? ` ${tag("replay row", "replay")}` : ""}</p><p class="small">by ${cur.actor === OFFICER ? "<strong>officer</strong>" : esc(cur.actor)}, ${esc(fmtTime(cur.decided_at))}, contract <code>${idHtml(cur.contract_id)}</code></p>${
              cur.actor === OFFICER && cur.reason ? `<p class="small">Reason: ${esc(cur.reason)}</p>` : ""
            }${differs ? `<p class="small msg msg--warn">The current row differs from this run's ${proposed ? "proposal" : "decision"}${saved.applied === false && !saved.queue_id ? ": the run applied nothing" : ""}.</p>` : ""}`
          : `<p class="small">No decision row yet${prop?.state === "pending" ? ": the proposal waits for your signature." : "."}</p>`
      }
      <p><button type="button" class="btn btn--why" data-why="${esc(gtin)}/${esc(market)}">${cur?.status === "HOLD" ? "Why was this held?" : cur?.status === "BLOCK" ? "Why was this blocked?" : "Why this decision?"}</button></p>
    </div>
  </section>`;
}

function claimTests(run) {
  const ct = Array.isArray(run.claim_tests) ? run.claim_tests : [];
  return `<section class="panel" aria-labelledby="h-claims"><h2 id="h-claims" class="panel__h">Label claims tested</h2>
    ${ct.length ? `<ul class="verdicts">${ct.map((c) => `<li>${verdictChip(c.verdict)} <strong>${esc(c.claim)}</strong>${c.contradicting?.length ? ` contradicted by ${esc(c.contradicting.map(groupWord).join(", "))}` : ""}<span class="muted small"> ${esc(c.reason ?? "")}</span> ${evidenceChips(null, c.evidenceIds)}</li>`).join("")}</ul>` : `<p class="muted small">The label makes no vegan, dairy-free, gluten-free or nut-free claim.</p>`}
  </section>`;
}

function contradictions(run, conflicts) {
  const cs = Array.isArray(run.contradictions) ? run.contradictions : [];
  return `<section class="panel${cs.length ? " panel--alert" : ""}" aria-labelledby="h-contra"><h2 id="h-contra" class="panel__h">Contradictions <span class="panel__note">${cs.length ? "each one holds the listing until the officer settles it (R4)" : ""}</span></h2>
    ${
      cs.length
        ? `<ul class="contra">${cs
            .map((c) => {
              const since = resolvedConflict(c.text, conflicts);
              return `<li><span class="contra__plain">${esc(plainReason("R4", `unresolved contradiction (${c.kind}): ${c.text}`))}</span> ${evidenceChips(null, c.evidenceIds)}<span class="contra__raw small muted"><span class="contra__kind">${esc(String(c.kind).replaceAll("_", " "))}</span> ${esc(c.text)}</span>${since ? resolvedNote(since) : ""}</li>`;
            })
            .join("")}</ul>`
        : `<p class="muted small">None found.</p>`
    }
  </section>`;
}

function notChecked(run) {
  const nc = Array.isArray(run.not_checked) ? run.not_checked : [];
  return `<section class="panel" aria-labelledby="h-nc"><h2 id="h-nc" class="panel__h">Not checked</h2>${nc.length ? `<ul class="nc">${nc.map((n) => `<li>${esc(n.text)}</li>`).join("")}</ul>` : `<p class="muted small">Nothing listed.</p>`}${(run.gaps ?? []).length ? `<h4>Gaps in this run</h4><ul class="nc">${run.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : ""}</section>`;
}

function memoryPanel(groups, records) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const hits = [];
  for (const c of groups.memory) {
    const rec = byId.get(c.evidenceIds?.[0]);
    if (Array.isArray(rec?.details?.hits)) hits.push(...rec.details.hits);
  }
  return `<section class="panel" aria-labelledby="h-mem"><h2 id="h-mem" class="panel__h">Memory</h2>
    ${claimList(groups.memory, "No memory was consulted.")}
    ${hits.length ? `<details><summary>${esc(fmtNum(hits.length))} memories retrieved</summary><ul class="hits">${hits.map((h) => `<li><code>${esc(h.id)}</code> ${esc(noAddress(h.text))}</li>`).join("")}</ul></details>` : ""}
    <p class="small"><a href="#/memory">Conflicts and invariants are settled on Memory and why</a></p>
  </section>`;
}

function recordedPanel(groups) {
  return `<section class="panel" aria-labelledby="h-rec"><h2 id="h-rec" class="panel__h">Written back <span class="panel__note">closed loop</span></h2>${claimList(groups.recorded, "Nothing was written for this run.")}${groups.other.length ? `<h4>Other</h4>${claimList(groups.other)}` : ""}</section>`;
}

function timeline(run) {
  const loop = run.loop ?? {};
  const tl = Array.isArray(loop.timeline) ? loop.timeline : [];
  const chart = Array.isArray(loop.chart) ? loop.chart : [];
  const tele = Array.isArray(loop.chunk_telemetry) ? loop.chunk_telemetry : [];
  const s = loop.summary ?? {};
  const chunks = [...new Set(tl.map((t) => t.chunk))];
  const cl = Array.isArray(loop.checklist) ? loop.checklist : [];
  return `<section class="panel" aria-labelledby="h-loop">
    <h2 id="h-loop" class="panel__h">How the agent investigated <span class="panel__note">Markovian loop, ${esc(fmtNum(loop.chunks))} chunk${loop.chunks === 1 ? "" : "s"}, ${esc(loop.status ?? "")}</span></h2>
    ${cl.length ? `<ul class="checklist" aria-label="Checklist">${cl.map((c) => `<li class="cl cl--${esc(c.status)}" title="${esc(c.note ?? c.status)}"><span aria-hidden="true">${c.status === "done" ? "✓" : c.status === "na" ? "–" : "○"}</span> ${esc(String(c.id).replaceAll("_", " "))}<span class="sr-only">: ${esc(c.status === "na" ? `not applicable${c.note ? `, ${c.note}` : ""}` : c.status)}</span></li>`).join("")}</ul>` : ""}
    <ol class="chunks">${chunks
      .map((n) => {
        const pt = chart.find((p) => p.chunk === n);
        const ct = tele.find((c) => c.chunk === n);
        return `<li class="chunk"><div class="chunk__head"><span class="chunk__n">Chunk ${esc(n)}</span><span class="chunk__m">${pt ? `${esc(fmtNum(pt.markovian_prompt_tokens_measured))} prompt tokens <span class="label">measured</span>` : ""}${ct ? `, ${esc(fmtNum(ct.carryover_in_tokens))} carried in <span class="label">estimated (chars/4)</span>, ${esc(fmtMs(ct.wall_ms))}` : ""}</span></div>
          <ol class="steps">${tl
            .filter((t) => t.chunk === n)
            .map(
              (t) =>
                `<li class="step step--${esc(t.source)}${t.ok ? "" : " step--fail"}"><span class="step__seq">${esc(t.seq)}</span><div class="step__body"><p class="step__tool"><code>${esc(t.tool)}</code> <span class="src-badge src-badge--${esc(t.source)}">${t.source === "fallback" ? "fallback step" : "chosen by the model"}</span>${t.ok ? "" : ` <span class="cross">failed</span>`}</p>${
                  t.thought ? `<p class="step__thought"><span class="step__k">Model's note, as written:</span> <q>${esc(t.thought)}</q></p>` : ""
                }${t.fallback_reason ? `<p class="step__fb small">Fallback because ${esc(t.fallback_reason)}</p>` : ""}<p class="step__fact"><span class="step__k">What the tool found:</span> ${esc(noAddress(stripEvidenceRefs(t.fact)))} ${evidenceChips(null, t.evidence_ids, { kind: kindOfTool(t.tool), max: 5 })}</p></div></li>`,
            )
            .join("")}</ol></li>`;
      })
      .join("")}</ol>
    <div class="loop-sum">
      <dl class="kv kv--inline">
        <div class="kv__row"><dt>Planner calls</dt><dd>${esc(fmtNum(s.planner_calls))}, ${esc(fmtNum(s.planner_valid_first_try))} valid first time</dd></div>
        <div class="kv__row"><dt>Fallback steps</dt><dd>${esc(fmtNum(s.fallback_steps))}</dd></div>
        <div class="kv__row"><dt>Planner tokens</dt><dd>${esc(fmtNum(s.planner_prompt_tokens))} in / ${esc(fmtNum(s.planner_eval_tokens))} out <span class="label">measured</span></dd></div>
        <div class="kv__row"><dt>Tool-model tokens</dt><dd>${esc(fmtNum(s.tool_model_tokens_in))} in / ${esc(fmtNum(s.tool_model_tokens_out))} out <span class="label">measured</span></dd></div>
        <div class="kv__row"><dt>Saving against full history</dt><dd>${s.saving_vs_naive_estimated === null || s.saving_vs_naive_estimated === undefined ? "not measured" : `${esc(fmtNum(s.saving_vs_naive_estimated * 100))}%`} <span class="label">estimated (chars/4)</span></dd></div>
        <div class="kv__row"><dt>Wall time</dt><dd>${esc(fmtMs(loop.wall_ms))}</dd></div>
      </dl>
    </div>
    <div data-mount="token-chart">${renderTokenChart(chart, { title: `${run.gtin} ${run.market}` })}</div>
  </section>`;
}

/**
 * Pure: the whole card. model = { gtin, market, data (GET /api/sku), records, queue (GET
 * /api/approvals items), conflicts (GET /api/memory/conflicts), contracts (contract log entries) }.
 */
export function renderCard(model) {
  const { gtin, market, data, records = [], queue = [], conflicts = [], contracts = null } = model;
  rememberEvidence(records);
  const entry = data?.markets?.[market] ?? null;
  const sku = data?.sku ?? null;
  const run = entry?.run ?? null;
  const cur = entry?.decision ?? null;
  const markets = sku?.markets ?? Object.keys(data?.markets ?? {});
  const name = run?.product?.name ?? sku?.name ?? "Unnamed product";
  const brand = run?.product?.brand ?? sku?.brand ?? "";
  const switcher = markets.length > 1 ? `<nav class="mkt" aria-label="Market">${markets.map((m) => `<a href="#/sku/${esc(gtin)}/${esc(m)}" ${m === market ? 'aria-current="page"' : ""}>${esc(m)}</a>`).join("")}</nav>` : `<span class="mkt mkt--one">${esc(market)}</span>`;
  const head = `<header class="card-head">
    <div class="card-head__id"><h1 class="card-head__name">${esc(name)}</h1><p class="card-head__meta"><code class="gtin">${esc(gtin)}</code>${brand ? `<span>${esc(brand)}</span>` : ""}${switcher}</p></div>
    <div class="card-head__acts"><button type="button" class="btn" data-act="reclear">Re-clear now</button><a class="btn btn--ghost" href="${esc(ZETARIS_HOME)}" rel="noreferrer" target="_blank" title="Zetaris GUI (login required): USL lightning.metastore.clearshelf.clearance_usl, ERD view">Open in Zetaris</a></div>
  </header>`;
  const clog = contracts ? contractLog(contracts, gtin, market) : "";
  if (!markets.includes(market) && sku) return `${head}<p class="msg msg--warn">${esc(name)} is not listed in ${esc(market)}.</p>`;
  if (!run) {
    return `${head}<section class="panel"><h2 class="panel__h">Not cleared yet in this market</h2>
      ${cur ? `<p>Current decision: ${statusChip(cur.status)} <code>${idHtml(cur.decision_id)}</code> by ${esc(cur.actor)}, ${esc(fmtTime(cur.decided_at))}</p><p class="small">${esc(cur.reason)}</p>` : `<p>No decision and no saved investigation for this product in ${esc(market)}.</p>`}
      <p><button type="button" class="btn btn--primary" data-act="reclear">Clear it now</button></p></section>
      ${actionPanel(gtin, market, entry, null, { name })}${clog}`;
  }
  const groups = groupClaims(run.card, records);
  const saved = run.saved ?? null;
  const prop = proposalOf(run, queue);
  const since = prop && prop.state !== "pending" && prop.state !== "unknown" ? ` Since then: proposal ${esc(prop.state)}${prop.resolution?.at ? ` ${esc(fmtTime(prop.resolution.at))}` : ""}.` : "";
  const savedLine = saved
    ? `<p class="saved">Run <code>${esc(run.run_id)}</code> from ${esc({ server: "intake on this server", cli: "the command line", watch: "a recall-watch sweep", eval: "the scenario eval" }[saved.source] ?? saved.source)}, ${esc(fmtTime(saved.at))}: ${esc(saved.note)}.${since}${saved.applied === false && !saved.queue_id && !saved.decision_id ? ` <strong class="warn-text">This run applied nothing: no decision row and no proposal came from it.</strong>` : ""}${saved.replay ? ` ${tag(saved.replay, "replay")}` : data?.banner ? ` ${tag("live run, not part of the replay", "live")}` : ""}</p>`
    : `<p class="saved">Run <code>${esc(run.run_id)}</code>, as of ${esc(run.as_of)}</p>`;
  const sourceCards = SOURCES.map((def) => sourceCard(def, groups[def.key], records, run)).join("") + dqCard(groups.dq, run);
  const addressed = records.some((r) => Array.isArray(r.rows) && r.rows.some((row) => (Array.isArray(row) ? row : [row]).some((v) => hasAddress(v))));
  return `${head}${savedLine}
    ${band(gtin, market, run, cur, groups, { records, queue, conflicts })}
    <div class="card-grid">
      <div class="card-main">
        <section class="sources" aria-label="Sources">${sourceCards}</section>
        ${addressed ? `<p class="small muted">A firm's street address in this run's stored evidence is shown as [address removed]; the gateway no longer selects addresses.</p>` : ""}
        ${labelPanel(run, records, entry?.label_checks ?? null)}
        <div class="two">${claimTests(run)}${contradictions(run, conflicts)}</div>
        ${timeline(run)}
      </div>
      <aside class="card-side" aria-label="Decision support">
        ${actionPanel(gtin, market, entry, run, { name })}
        ${statementPanel(run)}
        ${clog}
        ${notChecked(run)}
        ${memoryPanel(groups, records)}
        ${recordedPanel(groups)}
      </aside>
    </div>`;
}

/** Pure: the picker shown on the card tab before a product is chosen. */
export function renderPicker(catalogue) {
  const skus = catalogue?.skus ?? [];
  return `<section class="panel picker"><h1 class="view-h">SKU card</h1><p>Choose a listing to open its card.</p>
    <ul class="picker__list">${skus
      .map((s) =>
        s.markets
          .map((m) => {
            const d = s.decisions?.[m] ?? null;
            const p = (s.pending ?? []).find((x) => x.kind === "proposal" && x.market === m);
            return `<li><a href="#/sku/${esc(s.gtin)}/${esc(m)}"><span class="picker__name">${esc(s.name || "unnamed")}</span> <span class="muted small">${esc(m)} <code class="gtin">${esc(s.gtin)}</code></span></a> <span class="picker__st">${d ? statusChip(d.status) : ""}${p ? statusChip(p.status, { proposed: true }) : ""}${!d && !p ? tag("not cleared") : ""}</span></li>`;
          })
          .join(""),
      )
      .join("")}</ul></section>`;
}

// ---------- DOM ----------

/** Every officer button stays disabled until a reason is typed; signing also waits for a confirmed statement. */
export function wireReasons(form) {
  const reason = form.querySelector("[data-reason]");
  const stmt = form.querySelector('textarea[name="statement"]');
  const kind = form.dataset.form;
  const names = (form.dataset.names ?? "").split("|").filter(Boolean);
  const sync = () => {
    const has = !!reason.value.trim();
    const releaseAs = form.querySelector('input[name="status"]:checked')?.value ?? null;
    const statementSigned = kind === "proposal" || (kind === "release" && releaseAs === "CLEAR_WITH_STATEMENT");
    const unconfirmed = !!stmt && statementSigned && stmt.value.includes(TO_CONFIRM);
    const warn = form.querySelector("[data-clear-warn]");
    if (warn) warn.hidden = releaseAs !== "CLEAR";
    const ackNeeded = !!warn && releaseAs === "CLEAR" && !form.querySelector("[data-ack]")?.checked;
    const emptyStatement = kind === "release" && releaseAs === "CLEAR_WITH_STATEMENT" && !(stmt?.value.trim() ?? "");
    for (const b of form.querySelectorAll("button[data-act]")) {
      const signs = b.dataset.act === "approve" || b.dataset.act === "release";
      b.disabled = !has || (signs && (unconfirmed || (kind === "release" && (!releaseAs || ackNeeded || emptyStatement))));
    }
    if (kind === "release" && stmt) stmt.disabled = releaseAs === "CLEAR";
    const sAct = form.querySelector("[data-sign-status]");
    if (sAct && kind === "release") sAct.textContent = releaseAs ? releaseAs.replaceAll("_", " ") : "choose below";
    const sSt = form.querySelector("[data-sign-statement]");
    if (sSt && stmt) {
      const v = statementSigned ? stmt.value.trim() : "";
      sSt.textContent = v || "none";
    }
    if (kind === "proposal" && stmt) {
      const approve = form.querySelector('[data-act="approve"]');
      const edited = stmt.value !== stmt.dataset.original;
      approve.textContent = edited ? "Approve edited statement and sign" : "Approve and sign";
      form.querySelector("[data-hint]")?.classList.toggle("msg--warn", unconfirmed);
      const removedEl = form.querySelector("[data-removed]");
      if (removedEl) {
        const word = (n) => new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}($|[^\\p{L}])`, "iu");
        const removed = edited ? names.filter((n) => word(n).test(stmt.dataset.original) && !word(n).test(stmt.value)) : [];
        removedEl.hidden = !removed.length;
        removedEl.textContent = removed.length ? `Your edit removes ${removed.join(", ")}, which the verifier found on the label. Say why in the reason; the edit is recorded with your signature.` : "";
      }
    }
  };
  reason.addEventListener("input", sync);
  stmt?.addEventListener("input", sync);
  form.addEventListener("change", sync);
  sync();
}

function result(form, html) {
  form.querySelector("[data-result]").innerHTML = html;
}

function okLine(text, sql, extra = "") {
  return `<div class="msg msg--ok" role="status"><p>${text}</p>${extra}${sql ? `<details><summary>Closed-loop SQL run in Zetaris</summary><pre class="sql">${esc(sql)}</pre></details>` : ""}</div>`;
}

/** What the signed contract says, for the officer to read after signing. */
export function contractSummary(c, statement) {
  if (!c || typeof c !== "object") return "";
  const p = c.intent?.parameters ?? {};
  const appr = Array.isArray(c.risk?.approvals) ? c.risk.approvals[0] : null;
  return `<dl class="sign sign--done">
    <div class="sign__row"><dt>Contract</dt><dd><code>${idHtml(c.contractId)}</code></dd></div>
    <div class="sign__row"><dt>Action</dt><dd>${esc(c.intent?.primary ?? "")}</dd></div>
    <div class="sign__row"><dt>GTIN, market</dt><dd><code class="gtin">${esc(p.gtin ?? "")}</code> ${esc(p.market ?? "")}</dd></div>
    <div class="sign__row"><dt>Status written</dt><dd>${esc(String(p.status ?? p.release_to ?? "").replaceAll("_", " "))}</dd></div>
    <div class="sign__row"><dt>Statement</dt><dd>${statement ? `${esc(statement)}${p.statement_sha256 ? ` <span class="muted small">sha256 ${esc(String(p.statement_sha256).slice(0, 12))}…</span>` : ""}` : `<span class="muted">none</span>`}</dd></div>
    <div class="sign__row"><dt>Approved by</dt><dd><strong>${esc(appr?.by ?? OFFICER)}</strong></dd></div>
    <div class="sign__row"><dt>Valid</dt><dd>${esc(fmtTime(c.issuedAt))} to ${esc(fmtTime(c.expiresAt))}, used once</dd></div>
  </dl>`;
}

async function signAndExecute(form, { gtin, market, action, status, statement, reason, queueId }) {
  const buttons = [...form.querySelectorAll("button")];
  buttons.forEach((b) => (b.disabled = true));
  result(form, `<p class="muted" role="status">Asking the server to sign the contract…</p>`);
  const signed = await api("/api/approvals/sign", { body: { gtin, market, action, ...(action === "RELEASE" ? { status } : {}), statement: statement || null, reason, officer: OFFICER, ...(queueId ? { queue_id: queueId } : {}) } });
  if (!signed.ok) {
    result(form, renderError(signed));
    buttons.forEach((b) => (b.disabled = false));
    return false;
  }
  const c = signed.data.contract;
  result(form, `<p class="muted" role="status">Contract <code>${esc(c?.contractId ?? "")}</code> signed; executing…</p>`);
  const ex = await api("/api/execute", { body: { gtin, market, status, statement: statement || null, ...(action === "RELEASE" ? { action: "RELEASE" } : {}), reason, contract: c } });
  if (!ex.ok) {
    result(form, renderError(ex));
    buttons.forEach((b) => (b.disabled = false));
    return false;
  }
  result(
    form,
    okLine(
      `Signed and written: ${statusChip(status)} decision <code>${idHtml(ex.data.decision_id)}</code> by <strong>officer</strong>; visible in Zetaris: <strong>${ex.data.visible_in_zetaris ? "yes" : "not yet"}</strong>.`,
      ex.data.closed_loop_sql,
      `<details open><summary>What you signed</summary>${contractSummary(c, statement)}</details>`,
    ),
  );
  return true;
}

export function mount(el, ctx) {
  const { gtin, market } = ctx.params;
  if (!gtin) {
    api("/api/catalogue").then((r) => {
      el.innerHTML = r.ok ? renderPicker(r.data) : renderError(r);
    });
    return () => {};
  }
  el.innerHTML = `<section class="live" data-live hidden aria-labelledby="h-live"><h2 id="h-live" class="panel__h">Live investigation <span class="panel__note" data-live-note></span></h2><ol class="stream" data-stream></ol></section><div data-body><p class="muted" role="status">Loading the card…</p></div>`;
  const liveEl = el.querySelector("[data-live]");
  const body = el.querySelector("[data-body]");
  let flashMsg = "";
  let focusFlash = false;
  let loading = false;
  let again = false;

  const load = async () => {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      const [r, q, c, l] = await Promise.all([api(`/api/sku/${encodeURIComponent(gtin)}`), api("/api/approvals"), api("/api/memory/conflicts"), api("/api/contracts/log?limit=500")]);
      if (!r.ok) {
        body.innerHTML = renderError(r);
        return;
      }
      const run = r.data?.markets?.[market]?.run ?? null;
      let records = [];
      if (run?.run_id) {
        const ev = await api(`/api/evidence/${encodeURIComponent(run.run_id)}`);
        records = ev.ok ? (ev.data?.records ?? []) : [];
      }
      const keepScroll = window.scrollY;
      const active = document.activeElement?.id || null;
      body.innerHTML = renderCard({ gtin, market, data: r.data, records, queue: q.ok ? (q.data?.items ?? []) : [], conflicts: c.ok ? (c.data?.conflicts ?? []) : [], contracts: l.ok ? (l.data?.entries ?? []) : null });
      // The outcome of the officer's last action stays in the panel where they acted, across the reloads that SSE events trigger.
      if (flashMsg) body.querySelector(".panel--action .panel__h")?.insertAdjacentHTML("afterend", `<div class="act-outcome" id="act-outcome" tabindex="-1">${flashMsg}</div>`);
      window.scrollTo(0, keepScroll);
      ctx.setTitle(`${run?.product?.name ?? r.data?.sku?.name ?? gtin} ${market}`);
      wire();
      if (focusFlash && flashMsg) {
        focusFlash = false;
        body.querySelector(".act-outcome")?.focus();
      } else if (active && document.getElementById(active) && body.contains(document.getElementById(active))) {
        document.getElementById(active).focus({ preventScroll: true });
      }
    } finally {
      loading = false;
      if (again) {
        again = false;
        load();
      }
    }
  };

  const done = (html, announce) => {
    flashMsg = html;
    focusFlash = true;
    ctx.announce(announce);
    setTimeout(load, 300);
  };

  const wire = () => {
    for (const form of body.querySelectorAll("form[data-form]")) wireReasons(form);
    for (const btn of body.querySelectorAll('[data-act="reclear"]')) {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const r = await api("/api/clear", { body: { gtin, market } });
        liveEl.hidden = false;
        el.querySelector("[data-live-note]").textContent = r.ok ? `job ${r.data.job_id} queued; the model runs one job at a time` : "";
        if (!r.ok) el.querySelector("[data-stream]").insertAdjacentHTML("beforeend", `<li class="s s--fail">${esc(r.data?.error ?? "refused")}</li>`);
      });
    }
    const prop = body.querySelector('form[data-form="proposal"]');
    if (prop) {
      prop.addEventListener("submit", async (e) => {
        e.preventDefault();
        const reason = prop.querySelector("[data-reason]").value.trim();
        const statement = prop.querySelector('textarea[name="statement"]').value.trim();
        const status = prop.dataset.status;
        const ok = await signAndExecute(prop, { gtin, market, action: status, status, statement: status === "CLEAR_WITH_STATEMENT" || statement ? statement : null, reason, queueId: prop.dataset.queue });
        if (ok) done(prop.querySelector("[data-result]").innerHTML, "Approved and signed.");
      });
      prop.querySelector('[data-act="reject"]').addEventListener("click", async () => {
        const reason = prop.querySelector("[data-reason]").value.trim();
        const r = await api("/api/approvals/reject", { body: { queue_id: prop.dataset.queue, reason, officer: OFFICER } });
        if (!r.ok) return result(prop, renderError(r));
        done(okLine(`Proposal rejected: the listing is held, decision <code>${idHtml(r.data.decision_id ?? "")}</code>; visible in Zetaris: <strong>${r.data.visible_in_zetaris ? "yes" : "not yet"}</strong>.`), "Proposal rejected; the listing is held.");
      });
    }
    const rel = body.querySelector('form[data-form="release"]');
    if (rel) {
      rel.addEventListener("submit", async (e) => {
        e.preventDefault();
        const status = rel.querySelector('input[name="status"]:checked')?.value;
        if (!status) return;
        const statement = status === "CLEAR_WITH_STATEMENT" ? rel.querySelector('textarea[name="statement"]').value.trim() : null;
        const reason = rel.querySelector("[data-reason]").value.trim();
        const ok = await signAndExecute(rel, { gtin, market, action: "RELEASE", status, statement, reason });
        if (ok) done(rel.querySelector("[data-result]").innerHTML, "Released and signed.");
      });
    }
    const man = body.querySelector('form[data-form="manual"]');
    if (man) {
      for (const b of man.querySelectorAll("[data-act]")) {
        b.addEventListener("click", async () => {
          const reason = man.querySelector("[data-reason]").value.trim();
          const status = b.dataset.act;
          const r = await api("/api/decisions", { body: { gtin, market, status, reason } });
          if (!r.ok) return result(man, renderError(r));
          done(okLine(`Officer ${esc(status)} written: <code>${idHtml(r.data.decision_id)}</code>; visible in Zetaris: <strong>${r.data.visible_in_zetaris ? "yes" : "not yet"}</strong>${r.data.superseded?.length ? `; superseded ${esc(r.data.superseded.join(", "))}` : ""}.`), `Officer ${status} written.`);
        });
      }
    }
  };

  const mine = (d) => d && d.gtin === gtin && (!d.market || d.market === market);
  const offStream = mountStream(el.querySelector("[data-stream]"), {
    filter: (type, d) => mine(d) && (type.startsWith("loop.") || type.startsWith("clear.") || type === "watch.clear_started" || type === "decision.written"),
    onLine: (type, d) => {
      liveEl.hidden = false;
      if (type === "clear.done") {
        el.querySelector("[data-live-note]").textContent = `finished: ${d.status}`;
        ctx.announce(`Investigation finished: ${d.status}.`);
        setTimeout(load, 400);
      }
    },
  });
  const offs = [
    offStream,
    ctx.on("decision.written", (d) => mine(d) && load()),
    ctx.on("approval.queued", (d) => mine(d) && load()),
    ctx.on("approval.resolved", () => load()),
    ctx.on("approval.superseded", (d) => mine(d) && load()),
    ctx.on("memory.conflict_resolved", () => load()),
  ];
  load();
  return () => offs.forEach((f) => f());
}
