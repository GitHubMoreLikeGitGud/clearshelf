// The evidence drawer: where each claim came from, with the Lightning SQL text as the citation.
// renderEvidence is pure (tested in Node); openEvidence fetches and shows the drawer.

import { api, esc, evidenceChips, evShort, fieldOrMissing, fmtGap, fmtMs, fmtNum, fmtTime, hasAddress, noAddress, rememberEvidence, runOfEvidence, safeUrl, ZETARIS_HOME } from "../lib.js";
import { openDrawer, pushDrawer, updateDrawer } from "./drawer.js";

const KIND_LABEL = {
  zetaris_sql: "Zetaris SQL",
  dq: "Zetaris data quality",
  model_extraction: "Model extraction",
  verifier: "Deterministic verifier",
  memory: "H-MEM memory",
  world_model: "World Model",
  policy: "Decision policy",
};

const SQL_KINDS = new Set(["zetaris_sql", "dq"]);
const SHORT = { zetaris_sql: "SQL", dq: "SQL", model_extraction: "Model", verifier: "Check", memory: "Memory", world_model: "World", policy: "Policy" };

/** Every raw object is an ops table (never cached, read live). */
export function isOpsOnly(rec) {
  const raw = Array.isArray(rec?.raw_objects) ? rec.raw_objects : [];
  return raw.length > 0 && raw.every((o) => String(o).startsWith("clearshelf_ops."));
}

/** The plain freshness line under the two timestamps. */
export function freshnessLine(rec) {
  if (isOpsOnly(rec)) return "live read (ops table): ops tables are never cached";
  if (!rec?.source_cached_at) return "cache time not recorded";
  const gap = fmtGap(rec.source_cached_at, rec.queried_at);
  return gap === null ? "cache time not comparable with the query time" : `source cached ${gap} before the query`;
}

function cell(v) {
  if (v === null || v === undefined) return `<span class="null">null</span>`;
  if (typeof v === "object") return esc(noAddress(JSON.stringify(v)));
  return esc(noAddress(String(v)));
}

/** A row value that held a street address (stored before the gateway removed them). */
function rowsHadAddress(rec) {
  return (Array.isArray(rec?.rows) ? rec.rows : []).some((r) => (Array.isArray(r) ? r : [r]).some((v) => hasAddress(typeof v === "string" ? v : JSON.stringify(v ?? ""))));
}

function rowsTable(rec) {
  const cols = Array.isArray(rec.columns) ? rec.columns : [];
  const rows = Array.isArray(rec.rows) ? rec.rows : [];
  const count = typeof rec.row_count === "number" ? rec.row_count : null;
  const head = `<p class="rows__count">${esc(fmtNum(rows.length))} of ${count === null ? `<span class="missing">missing</span>` : esc(fmtNum(count))} row${count === 1 ? "" : "s"} shown${rows.length < (count ?? 0) ? " (the record keeps at most 20)" : ""}</p>`;
  if (!rows.length) return `${head}<p class="muted">The query returned no rows.</p>`;
  const note = rowsHadAddress(rec) ? `<p class="small muted">A firm's street address in these stored rows is shown as [address removed]; the gateway's templates no longer select addresses.</p>` : "";
  return `${head}${note}<div class="table-wrap"><table class="rows"><thead><tr>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows
    .slice(0, 20)
    .map((r) => `<tr>${(Array.isArray(r) ? r : [r]).map((v) => `<td>${cell(v)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function kv(label, value) {
  return `<div class="kv__row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}

function link(url) {
  const u = safeUrl(url);
  return u ? `<a href="${esc(u)}" rel="noreferrer" target="_blank">${esc(u)}</a>` : esc(url);
}

function modelBlock(m) {
  if (!m) return `<span class="missing">missing</span>`;
  return `<dl class="kv kv--inline">
    ${kv("Model", esc(m.name))}
    ${kv("Thinking", m.think ? "on" : "off")}
    ${kv("Tokens in / out", `${esc(fmtNum(m.tokens_in))} / ${esc(fmtNum(m.tokens_out))} <span class="label">${esc(m.label ?? "measured")}</span>`)}
    ${kv("Attempts", esc(fmtNum(m.attempts)))}
    ${kv("Speed", m.tokens_per_s ? `${esc(fmtNum(m.tokens_per_s, 1))} tok/s <span class="label">${esc(m.label ?? "measured")}</span>` : "not measured")}
    ${kv("Prompt sha256", `<code class="hash">${esc(m.prompt_sha256)}</code>`)}
  </dl>`;
}

function detailsBlock(rec) {
  const d = rec.details;
  if (!d || typeof d !== "object") return "";
  let special = "";
  if (Array.isArray(d.agreement)) {
    special = `<h4>Model against verifier</h4><div class="table-wrap"><table class="agree"><thead><tr><th scope="col">Text</th><th scope="col">Group</th><th scope="col">Relation</th><th scope="col">Model</th><th scope="col">Verifier</th><th scope="col">Agree</th></tr></thead><tbody>${d.agreement
      .map(
        (a) =>
          `<tr><td>${esc(a.evidence_text)}</td><td>${esc(a.group)}</td><td>${esc(a.relation)}${a.lexicon_relation && a.lexicon_relation !== a.relation ? ` <span class="muted">(verifier: ${esc(a.lexicon_relation)})</span>` : ""}</td><td>${yesNo(a.model)}</td><td>${yesNo(a.lexicon)}</td><td>${a.agree ? `<span class="tick" aria-label="agreed">✓</span>` : `<span class="cross" aria-label="disagreed">✗</span>`}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
  } else if (Array.isArray(d.hits)) {
    special = `<h4>Memories retrieved</h4><ul class="hits">${d.hits.map((h) => `<li><code>${esc(h.id)}</code> ${esc(h.text)} <span class="muted">${esc(h.source ?? "")}</span></li>`).join("")}</ul>`;
  } else if (d.guard && typeof d.guard === "object") {
    special = `<p>Guard flagged: <strong>${d.guard.flagged ? "yes" : "no"}</strong>${Array.isArray(d.guard.reasons) && d.guard.reasons.length ? `; ${esc(d.guard.reasons.join("; "))}` : ""}</p>`;
  }
  return `${special}<details class="raw"><summary>Details as stored</summary><pre>${esc(JSON.stringify(d, null, 2))}</pre></details>`;
}

function yesNo(v) {
  return v ? `<span class="tick" aria-label="yes">✓</span>` : `<span class="cross" aria-label="no">✗</span>`;
}

function zetarisLink(rec) {
  const obj = rec.zetaris_object ?? (Array.isArray(rec.raw_objects) ? rec.raw_objects[0] : null);
  if (!obj) return "";
  const isUsl = String(obj).startsWith("lightning.metastore.clearshelf.clearance_usl");
  return `<p class="zlink"><a href="${esc(ZETARIS_HOME)}" rel="noreferrer" target="_blank">Open in Zetaris</a> <span class="muted">then ${isUsl ? "the USL <code>lightning.metastore.clearshelf.clearance_usl</code>, ERD view, object" : "Data Explorer, Lightning databases <code>CLEARSHELF_*</code>, object"} <code>${esc(obj)}</code> (login required)</span></p>`;
}

/** One record, every field visible; a required field that is absent shows "missing" in red. */
export function renderRecord(rec) {
  if (!rec || typeof rec !== "object") return "";
  if (rec.error) return `<article class="evrec evrec--error" id="evrec-${esc(rec.id)}" tabindex="-1"><h3 class="evrec__claim">${esc(rec.id)}</h3><p class="msg msg--error">${esc(rec.error)}</p></article>`;
  const sql = SQL_KINDS.has(rec.kind);
  const opsOnly = isOpsOnly(rec);
  const parts = [];
  parts.push(`<header class="evrec__head"><span class="evrec__n">Record ${esc(evShort(rec.id))}</span><span class="kind kind--${esc(rec.kind)}">${esc(KIND_LABEL[rec.kind] ?? rec.kind ?? "")}</span>${fieldOrMissing(rec.kind, () => "")}<code class="evrec__id">${fieldOrMissing(rec.id)}</code><span class="muted">run ${fieldOrMissing(rec.run_id, (v) => `<code>${esc(v)}</code>`)}</span></header>`);
  parts.push(`<h3 class="evrec__claim">${fieldOrMissing(rec.claim, (v) => esc(noAddress(v)))}</h3>`);
  if (sql || rec.sql) {
    const pre = `sql-${String(rec.id ?? "x").replace(/[^A-Za-z0-9-]/gu, "")}`;
    parts.push(`<section class="cite" aria-label="Lightning SQL citation">
      <div class="cite__bar"><span class="cite__title">Lightning SQL, the citation for this claim</span>${rec.sql ? `<button type="button" class="btn btn--small" data-copy="${esc(pre)}">Copy SQL</button>` : ""}</div>
      ${rec.sql ? `<pre class="sql" id="${esc(pre)}">${esc(rec.sql)}</pre>` : `<p class="sql sql--missing"><span class="missing">missing</span></p>`}
      <p class="cite__hash">sha256 ${fieldOrMissing(rec.sql_sha256, (v) => `<code class="hash">${esc(v)}</code>`)}</p>
    </section>`);
  }
  const rows = [];
  if (rec.template_id || sql) rows.push(kv("Template", `${fieldOrMissing(rec.template_id, (v) => `<code>${esc(v)}</code>`)}${rec.params && Object.keys(rec.params).length ? ` <span class="muted">${esc(Object.entries(rec.params).map(([k, v]) => `${k}=${v}`).join(", "))}</span>` : ""}`));
  if (sql || rec.zetaris_object) rows.push(kv("Zetaris object", fieldOrMissing(rec.zetaris_object, (v) => `<code>${esc(v)}</code>`)));
  if (Array.isArray(rec.zetaris_objects) && rec.zetaris_objects.length) rows.push(kv("Objects read", rec.zetaris_objects.map((o) => `<code>${esc(o)}</code>`).join("<br>")));
  if (sql || rec.raw_objects) rows.push(kv("Raw objects", fieldOrMissing(Array.isArray(rec.raw_objects) && rec.raw_objects.length ? rec.raw_objects : null, (v) => v.map((o) => `<code>${esc(o)}</code>`).join("<br>"))));
  if (sql || rec.source_url) rows.push(kv("Source URL", fieldOrMissing(rec.source_url, link)));
  if (sql || rec.licence) rows.push(kv("Licence", fieldOrMissing(rec.licence)));
  if (Array.isArray(rec.sources) && rec.sources.length) {
    rows.push(
      kv(
        "Sources",
        `<ul class="srclist">${rec.sources
          .map((s) => `<li><code>${esc(s.object)}</code><br>${link(s.url)}<br><span class="muted">${esc(s.licence)}; ${s.cached_at ? `cached ${esc(fmtTime(s.cached_at, true))}` : String(s.object ?? "").startsWith("clearshelf_ops.") ? "live read (ops table)" : "cache time not recorded"}</span></li>`)
          .join("")}</ul>`,
      ),
    );
  }
  parts.push(`<dl class="kv">${rows.join("")}</dl>`);
  parts.push(`<div class="times">
    <div class="times__cell"><span class="times__k">Queried</span><span class="times__v">${fieldOrMissing(rec.queried_at, (v) => `<time datetime="${esc(v)}">${esc(v)}</time>`)}</span></div>
    ${sql || rec.source_cached_at !== undefined ? `<div class="times__cell"><span class="times__k">Source cached</span><span class="times__v">${rec.source_cached_at ? `<time datetime="${esc(rec.source_cached_at)}">${esc(rec.source_cached_at)}</time>` : opsOnly ? "live read (ops table)" : `<span class="missing">missing</span>`}</span></div>` : ""}
    ${sql || rec.source_cached_at !== undefined ? `<p class="times__line">${esc(freshnessLine(rec))}</p>` : ""}
  </div>`);
  if (sql) {
    parts.push(`<dl class="kv kv--inline">
      ${kv("Cache state", fieldOrMissing(rec.cache_state))}
      ${kv("Elapsed", fieldOrMissing(rec.elapsed_ms, (v) => esc(fmtMs(v))))}
      ${kv("Rows", fieldOrMissing(rec.row_count, (v) => esc(fmtNum(v))))}
      ${rec.kind === "dq" ? kv("DQ source", fieldOrMissing(rec.dq_source, (v) => (v === "zetaris_dq" ? "from Zetaris DQ (SHOW DQ INVALID RECORD)" : v === "dq_equivalent_sql" ? "from DQ-equivalent SQL" : esc(v)))) : ""}
      ${rec.reused ? kv("Reused", "yes: a table-wide result from an earlier query in this process") : ""}
    </dl>`);
    parts.push(rowsTable(rec));
  }
  if (rec.kind === "model_extraction" || rec.model) parts.push(`<h4>Model</h4>${modelBlock(rec.model)}`);
  if (Array.isArray(rec.derived_from) && rec.derived_from.length) parts.push(`<p class="derived">Derived from ${evidenceChips(rec.run_id, rec.derived_from)}</p>`);
  if (rec.reused && !sql) parts.push(`<p class="muted">Reused from an earlier run.</p>`);
  parts.push(detailsBlock(rec));
  parts.push(zetarisLink(rec));
  return `<article class="evrec" id="evrec-${esc(rec.id)}" tabindex="-1">${parts.join("")}</article>`;
}

/** The drawer body for one or more records (each a record or { id, error }). */
export function renderEvidence(records) {
  const list = (Array.isArray(records) ? records : [records]).filter(Boolean);
  if (!list.length) return `<p class="muted">No evidence records.</p>`;
  const index =
    list.length > 1
      ? `<nav class="evindex" aria-label="Records cited"><span>${list.length} records cited, jump to:</span> ${list.map((r) => `<button type="button" class="ev ev--jump" data-jump="evrec-${esc(r.id)}" data-kind="${esc(r.kind ?? "unknown")}" aria-label="Go to record ${esc(evShort(r.id))}: ${esc(KIND_LABEL[r.kind] ?? r.kind ?? "")}"><span class="ev__k" aria-hidden="true">${esc(SHORT[r.kind] ?? "Record")}</span><span class="ev__n" aria-hidden="true">${esc(evShort(r.id))}</span></button>`).join(" ")}</nav>`
      : "";
  return `${index}${list.map(renderRecord).join("")}`;
}

/** Fetches the records and shows them; inside the drawer it stacks (Back returns). */
export async function openEvidence(runId, ids, opts = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return;
  const start = opts.start && list.includes(opts.start) ? opts.start : list[0];
  const entry = (opts.push ? pushDrawer : openDrawer)({
    title: list.length > 1 ? `Evidence for this claim (${list.length} records)` : `Evidence record ${evShort(list[0])}`,
    kicker: "Where this came from",
    html: `<p class="muted" role="status">Loading ${list.length} evidence record${list.length === 1 ? "" : "s"}…</p>`,
  });
  const recs = await Promise.all(
    list.map(async (id) => {
      const run = runOfEvidence(id, runId);
      if (!run) return { id, error: "this evidence id names no run" };
      const r = await api(`/api/evidence/${encodeURIComponent(run)}/${encodeURIComponent(id)}`);
      return r.ok && r.data ? r.data : { id, error: r.data?.error ?? `HTTP ${r.status}` };
    }),
  );
  rememberEvidence(recs.filter((r) => !r.error));
  const one = recs.length === 1 && !recs[0].error ? recs[0] : null;
  updateDrawer(entry, { ...(one ? { title: `Evidence record ${evShort(one.id)}: ${KIND_LABEL[one.kind] ?? one.kind}` } : {}), html: renderEvidence(recs), focus: `#evrec-${CSS.escape(start)}` });
}
