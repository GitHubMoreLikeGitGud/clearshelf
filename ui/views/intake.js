// Intake and catalogue: paste barcodes, pick a market, watch each clearance move through its
// stages live, and see every listing's current decision with the reasons behind it.
// Render functions are pure.

import { api, esc, noAddress, plainReason, renderError, ruleBadge, STAGES, stageOfTool, statusChip, stripEvidenceRefs, tag, ZETARIS_HOME, zoneName } from "../lib.js";
import { mountStream } from "./stream.js";

/** GS1 check digit of a 13-digit GTIN. */
export function gtinCheckOk(g) {
  if (!/^\d{13}$/u.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(g[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(g[12]);
}

/** Splits pasted text into barcodes, each marked valid or with the reason it is not. */
export function parseGtins(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? "").split(/[\s,;]+/u)) {
    const v = raw.trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (!/^\d{13}$/u.test(v)) out.push({ value: v, ok: false, why: /^\d+$/u.test(v) ? `${v.length} digits, 13 needed` : "not a 13-digit number" });
    else if (!gtinCheckOk(v)) out.push({ value: v, ok: false, why: "check digit does not match" });
    else out.push({ value: v, ok: true, why: "" });
  }
  return out;
}

/** The status shown for one listing: decision, pending signature, or not cleared. */
export function listingState(sku, market) {
  if (!sku.markets?.includes(market)) return { key: "unlisted" };
  const d = sku.decisions?.[market] ?? null;
  const pend = (sku.pending ?? []).filter((p) => p.market === market);
  const proposal = pend.find((p) => p.kind === "proposal");
  const names = pend.filter((p) => p.kind === "name_match").length;
  return { key: proposal ? "pending" : d ? d.status : "none", decision: d, proposal, names, run: sku.latest_runs?.[market] ?? null };
}

/**
 * The reasons behind a decision row, from its stored reason: each policy firing as
 * { rule, text }, or the officer's own words.
 */
export function rowReasons(row) {
  const reason = String(row?.reason ?? "");
  if (!reason) return { officer: null, firings: [] };
  const auto = /auto (?:HOLD|BLOCK) \(policy [^)]*\): (.*)$/u.exec(reason);
  if (auto) {
    const firings = auto[1]
      .split(/; (?=(?:R\d|ESC) )/u)
      .map((x) => /^(R\d|ESC) (.*)$/u.exec(x.trim()))
      .filter(Boolean)
      .map((m) => ({ rule: m[1], text: m[2] }));
    return { officer: null, firings };
  }
  if (row.actor === "officer") return { officer: reason.replace(/^officer (HOLD|BLOCK): /u, ""), firings: [] };
  return { officer: null, firings: [], other: reason };
}

/** Rules and a short plain reason for one listing, for the catalogue's Why column. */
export function whyCell(st) {
  if (st.key === "pending") {
    const p = st.proposal;
    return `${ruleBadge(p.status === "CLEAR" ? "R6" : "R5")} <span class="why-cell__t">${esc(p.status === "CLEAR" ? "No allergens found" : "Allergens verified, statement drafted")}: waiting for your signature</span>`;
  }
  if (!st.decision) return `<span class="muted">not cleared yet</span>`;
  const r = rowReasons(st.decision);
  if (r.officer !== null) return `<span class="why-cell__who">officer:</span> <span class="why-cell__t">${esc(r.officer.length > 110 ? `${r.officer.slice(0, 110)}…` : r.officer)}</span>`;
  if (!r.firings.length) return `<span class="why-cell__t muted">${esc(String(r.other ?? "").slice(0, 110))}</span>`;
  const rules = [...new Set(r.firings.map((f) => f.rule))];
  const plains = [...new Set(r.firings.map((f) => plainReason(f.rule, f.text)))];
  const shown = plains.slice(0, 2).join("; ");
  return `<span class="why-cell__rules">${rules.map((x) => ruleBadge(x)).join("")}</span> <span class="why-cell__t">${esc(noAddress(shown))}${plains.length > 2 ? ` <span class="muted">+${plains.length - 2} more</span>` : ""}</span>`;
}

const FILTERS = [
  { key: "all", label: "All listings" },
  { key: "HOLD", label: "HOLD" },
  { key: "BLOCK", label: "BLOCK" },
  { key: "CLEAR_WITH_STATEMENT", label: "CLEAR WITH STATEMENT" },
  { key: "CLEAR", label: "CLEAR" },
  { key: "pending", label: "Waiting for signature" },
  { key: "none", label: "Not cleared" },
];

function listings(cat) {
  return (cat?.skus ?? []).flatMap((s) => (s.markets ?? []).map((m) => ({ sku: s, market: m, st: listingState(s, m) })));
}

function statusCell(l) {
  const st = l.st;
  const parts = [];
  if (st.decision) parts.push(statusChip(st.decision.status));
  if (st.proposal) parts.push(statusChip(st.proposal.status, { proposed: true }));
  if (!st.decision && !st.proposal) parts.push(tag("not cleared", "neutral"));
  if (st.names) parts.push(tag(`${st.names} name match${st.names === 1 ? "" : "es"} to review`, "review"));
  return parts.join(" ");
}

/** Whether a listing passes a filter: a decision status, waiting for signature, or not cleared. */
export function matchesFilter(l, f) {
  if (f === "all") return true;
  if (f === "pending") return !!l.st.proposal;
  if (f === "none") return !l.st.decision && !l.st.proposal;
  return l.st.decision?.status === f;
}

/** Pure: the catalogue, one row per listing, with the status counts that filter it. */
export function renderCatalogue(cat, filter = "all") {
  const all = listings(cat);
  const count = (f) => all.filter((l) => matchesFilter(l, f)).length;
  const rows = all.filter((l) => matchesFilter(l, filter));
  return `<div class="filters" role="group" aria-label="Filter listings">${FILTERS.map((f) => `<button type="button" class="filter" data-filter="${f.key}" aria-pressed="${f.key === filter}">${esc(f.label)} <span class="filter__n">${count(f.key)}</span></button>`).join("")}</div>
  <div class="table-wrap"><table class="cat">
    <caption class="sr-only">Catalogue: current decision per listing, with the rules and the main reason</caption>
    <thead><tr><th scope="col">Product</th><th scope="col">Market</th><th scope="col">Decision</th><th scope="col">Why</th></tr></thead>
    <tbody>${rows
      .map(
        (l) => `<tr><th scope="row" class="cat__name"><a href="#/sku/${esc(l.sku.gtin)}/${esc(l.market)}">${esc(l.sku.name || "unnamed")}</a><span class="cat__brand">${l.sku.brand ? `${esc(l.sku.brand)} · ` : ""}<code class="gtin">${esc(l.sku.gtin)}</code></span></th><td class="cat__mkt">${esc(l.market)}</td><td class="cat__st">${statusCell(l)}</td><td class="cat__why">${whyCell(l.st)}</td></tr>`,
      )
      .join("") || `<tr><td colspan="4" class="muted">No listing matches this filter.</td></tr>`}</tbody>
  </table></div>
  <p class="small muted">${esc(cat?.source ?? "")}</p>`;
}

/** Queue figures for the session's clearances: done, running, waiting and an estimate of the time left. */
export function queueSummary(rows, now = Date.now()) {
  const done = rows.filter((r) => r.state === "done" || r.state === "failed");
  const running = rows.filter((r) => r.state === "running");
  const waiting = rows.filter((r) => r.state === "queued" || r.state === "submitting");
  const timed = done.filter((r) => r.started_at && r.finished_at).map((r) => r.finished_at - r.started_at);
  const each = timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length : 60_000;
  const runLeft = running.reduce((a, r) => a + Math.max(0, each - (r.started_at ? now - r.started_at : 0)), 0);
  return { total: rows.length, done: done.length, running: running.length, waiting: waiting.length, each, measured: timed.length, leftMs: runLeft + waiting.length * each };
}

/** Pure: one progress row per submitted clearance, with the queue position of each waiting one. */
export function renderProgress(rows, now = Date.now()) {
  if (!rows.length) return `<p class="muted small">Nothing submitted in this session yet. Each clearance runs as one job; the model works one job at a time (about a minute each).</p>`;
  const q = queueSummary(rows, now);
  const waitOrder = rows
    .filter((r) => r.state === "queued" || r.state === "submitting")
    .sort((a, b) => (a.submitted_at ?? 0) - (b.submitted_at ?? 0));
  const head = `<p class="prog__sum" role="status"><strong>${esc(q.done)} of ${esc(q.total)}</strong> finished${q.running ? `, ${esc(q.running)} running` : ""}${q.waiting ? `, ${esc(q.waiting)} waiting` : ""}${q.running || q.waiting ? `; about ${esc(String(Math.max(1, Math.round(q.leftMs / 60_000))))} min left <span class="label">estimated, ${q.measured ? `from ${esc(q.measured)} finished in this session` : "about 1 min each"}</span>` : ""}.</p>`;
  return `${head}<ol class="prog">${rows
    .map((r) => {
      const stage = r.stage ?? -1;
      const seen = new Set(r.seen ?? []);
      const steps = STAGES.map((s, i) => {
        const finished = r.state === "done";
        let cls = "todo";
        if (finished) cls = seen.has(i) || i === STAGES.length - 1 ? "done" : "skip";
        else if (i === stage && r.state === "running") cls = "now";
        else if (seen.has(i)) cls = "done";
        else if (stage > i) cls = "skip";
        const word = { done: "done", now: "in progress", todo: "not started", skip: i === 0 ? "already registered" : "not needed" }[cls];
        return `<li class="prog__step prog__step--${cls}"><span class="prog__n" aria-hidden="true">${i + 1}</span>${esc(s)}${cls === "skip" ? `<span class="prog__skip"> (${esc(word)})</span>` : ""}<span class="sr-only">: ${esc(word)}</span></li>`;
      }).join("");
      const pos = waitOrder.indexOf(r);
      const outcome =
        r.state === "failed"
          ? `<span class="cross">failed</span> ${esc(r.error ?? "")}`
          : r.status
            ? `${statusChip(r.status, { proposed: !r.applied && !!r.queued })} ${(r.rules ?? []).map((x) => ruleBadge(x)).join(" ")}${r.applied ? " applied automatically" : r.queued ? " waiting for your signature" : ""}`
            : r.state === "unknown"
              ? `<span class="muted">the server no longer knows this job (it may have restarted)</span>`
              : pos >= 0
                ? `waiting: <strong>${esc(pos + 1)} of ${esc(waitOrder.length)}</strong> in the queue`
                : r.state === "running"
                  ? "running"
                  : esc(r.state);
      return `<li class="prog__row prog__row--${esc(r.state)}">
        <div class="prog__id"><code class="gtin">${esc(r.gtin)}</code> <span class="mkt mkt--one">${esc(r.market)}</span> <span class="prog__name">${esc(r.name ?? "")}</span></div>
        <ol class="prog__steps" aria-label="Stages">${steps}</ol>
        <div class="prog__out">${outcome} ${r.state === "done" || r.status ? `<a href="#/sku/${esc(r.gtin)}/${esc(r.market)}">Open card</a>` : ""}</div>
        ${r.fact ? `<p class="prog__fact small">${esc(noAddress(stripEvidenceRefs(r.fact)))}</p>` : ""}
      </li>`;
    })
    .join("")}</ol>`;
}

let filterState = "all";
const ROWS_KEY = "clearshelf.intake.rows";

function saveRows(rows) {
  try {
    sessionStorage.setItem(ROWS_KEY, JSON.stringify(rows.slice(0, 200)));
  } catch {
    /* storage can be unavailable; progress then lasts only while the screen is open */
  }
}

function loadRows() {
  try {
    const v = JSON.parse(sessionStorage.getItem(ROWS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((r) => r && typeof r.gtin === "string") : [];
  } catch {
    return [];
  }
}

export function mount(el, ctx) {
  el.innerHTML = `<h1 class="view-h">Intake and catalogue</h1>
  <div class="intake">
    <section class="panel intake__form" aria-labelledby="h-intake">
      <h2 id="h-intake" class="panel__h">Clear new products</h2>
      <form data-form="intake" novalidate>
        <label class="field" for="gtins"><span class="field__label">Barcodes (GTIN-13), one per line or separated by commas</span>
          <textarea id="gtins" rows="4" spellcheck="false" autocomplete="off" aria-describedby="gtin-check"></textarea></label>
        <div id="gtin-check" class="gtin-check small" aria-live="polite"></div>
        <fieldset class="field field--inline"><legend class="field__label">Market</legend>
          <label><input type="radio" name="market" value="UK" checked> UK</label>
          <label><input type="radio" name="market" value="US"> US</label></fieldset>
        <div class="act__buttons"><button type="submit" class="btn btn--primary" data-submit disabled>Clear products</button><button type="button" class="btn btn--ghost" data-fill>Paste the catalogue's barcodes</button></div>
        <div data-result aria-live="polite"></div>
      </form>
      <div class="zetaris small">
        <h3>Open in Zetaris</h3>
        <p><a href="${esc(ZETARIS_HOME)}" rel="noreferrer" target="_blank">Zetaris GUI</a> (login required), then:</p>
        <ul><li>Data Explorer, Lightning databases <code>CLEARSHELF_*</code>: each product appears as <code>clearshelf_off.off_&lt;gtin&gt;</code></li><li>the USL <code>lightning.metastore.clearshelf.clearance_usl</code>, ERD view</li></ul>
      </div>
    </section>
    <div class="intake__right">
      <section class="panel intake__progress" aria-labelledby="h-prog">
        <h2 id="h-prog" class="panel__h">Progress <span class="panel__note">registering in Zetaris, fetching, reading, verifying, deciding</span> <button type="button" class="btn btn--small btn--ghost" data-clear-rows hidden>Clear finished</button></h2>
        <div data-progress></div>
        <details class="live-wrap" data-live-wrap><summary>Live investigation stream <span class="muted small">(times in ${esc(zoneName() || "local time")})</span></summary><ol class="stream" data-stream></ol></details>
      </section>
      <section class="panel" aria-labelledby="h-cat"><h2 id="h-cat" class="panel__h">Catalogue <span class="panel__note">current decision per listing, with the rules that decided it; open a listing for its card</span></h2><div data-cat><p class="muted">Loading the catalogue…</p></div></section>
    </div>
  </div>`;

  const form = el.querySelector('form[data-form="intake"]');
  const ta = el.querySelector("#gtins");
  const check = el.querySelector("#gtin-check");
  const submit = el.querySelector("[data-submit]");
  const progEl = el.querySelector("[data-progress]");
  const catEl = el.querySelector("[data-cat]");
  const clearBtn = el.querySelector("[data-clear-rows]");
  let catalogue = null;
  const rows = loadRows();
  const byJob = new Map(rows.filter((r) => r.job).map((r) => [r.job, r]));
  const rowFor = (gtin, market) => rows.find((r) => r.gtin === gtin && r.market === market && r.state !== "done" && r.state !== "failed" && r.state !== "unknown") ?? null;
  const paint = () => {
    progEl.innerHTML = renderProgress(rows);
    clearBtn.hidden = !rows.some((r) => r.state === "done" || r.state === "failed" || r.state === "unknown");
    saveRows(rows);
  };
  const tick = setInterval(() => {
    if (rows.some((r) => r.state === "running" || r.state === "queued")) paint();
  }, 30_000);

  clearBtn.addEventListener("click", () => {
    for (let i = rows.length - 1; i >= 0; i--) if (["done", "failed", "unknown"].includes(rows[i].state)) rows.splice(i, 1);
    paint();
    ta.focus();
  });

  const validate = () => {
    const list = parseGtins(ta.value);
    const good = list.filter((x) => x.ok);
    const bad = list.filter((x) => !x.ok);
    submit.disabled = !good.length;
    submit.textContent = good.length ? `Clear ${good.length} product${good.length === 1 ? "" : "s"}` : "Clear products";
    check.innerHTML = list.length
      ? `${good.length} valid${good.length > 1 ? `, about ${good.length} min of model time` : ""}${bad.length ? `; <span class="cross">${bad.length} invalid</span>: ${bad.map((b) => `<code>${esc(b.value)}</code> ${esc(b.why)}`).join("; ")}` : ""}`
      : "";
    return good;
  };
  ta.addEventListener("input", validate);

  el.querySelector("[data-fill]").addEventListener("click", () => {
    const market = form.querySelector('input[name="market"]:checked').value;
    ta.value = (catalogue?.skus ?? []).filter((s) => s.markets.includes(market)).map((s) => s.gtin).join("\n");
    validate();
    ta.focus();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const good = validate();
    const market = form.querySelector('input[name="market"]:checked').value;
    const res = form.querySelector("[data-result]");
    res.innerHTML = "";
    submit.disabled = true;
    const errors = [];
    for (const g of good) {
      const name = catalogue?.skus?.find((s) => s.gtin === g.value)?.name ?? "";
      const row = { gtin: g.value, market, name, state: "submitting", stage: -1, seen: [], submitted_at: Date.now() };
      rows.unshift(row);
      paint();
      const r = await api("/api/clear", { body: { gtin: g.value, market } });
      if (!r.ok) {
        row.state = "failed";
        row.error = r.data?.error ?? "refused";
        errors.push(renderError(r));
      } else {
        row.state = r.data.state === "running" ? "running" : "queued";
        row.job = r.data.job_id;
        byJob.set(r.data.job_id, row);
      }
      paint();
    }
    res.innerHTML = errors.join("") || `<p class="msg msg--ok small" role="status">${good.length} clearance${good.length === 1 ? "" : "s"} queued. You can leave this screen: progress is kept for this browser tab.</p>`;
    validate();
  });

  const loadCat = async () => {
    const r = await api("/api/catalogue");
    if (!r.ok) {
      catEl.innerHTML = renderError(r);
      return;
    }
    catalogue = r.data;
    catEl.innerHTML = renderCatalogue(catalogue, filterState);
    for (const row of rows) if (!row.name) row.name = catalogue.skus?.find((s) => s.gtin === row.gtin)?.name ?? "";
  };
  catEl.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-filter]") : null;
    if (!b) return;
    filterState = b.getAttribute("data-filter");
    catEl.innerHTML = renderCatalogue(catalogue, filterState);
    catEl.querySelector(`[data-filter="${filterState}"]`)?.focus();
  });

  let catTimer = null;
  const refreshCat = () => {
    clearTimeout(catTimer);
    catTimer = setTimeout(loadCat, 400);
  };

  const finish = (row, result) => {
    row.state = "done";
    row.finished_at = Date.now();
    if (result?.status && !row.status) Object.assign(row, { status: result.status, rules: result.rules, applied: result.applied, queued: !!result.queue_id });
    row.stage = STAGES.length - 1;
  };

  // Jobs submitted before this screen was (re)opened: ask the server where each one is.
  const resume = async () => {
    const open = rows.filter((r) => r.job && (r.state === "queued" || r.state === "running" || r.state === "submitting"));
    await Promise.all(
      open.map(async (row) => {
        const r = await api(`/api/jobs/${encodeURIComponent(row.job)}`);
        if (!r.ok) {
          row.state = r.status === 404 ? "unknown" : row.state;
          return;
        }
        const j = r.data;
        if (j.state === "done") {
          finish(row, j.result);
          if (j.started_at) row.started_at = Date.parse(j.started_at);
          if (j.finished_at) row.finished_at = Date.parse(j.finished_at);
        } else if (j.state === "failed") {
          row.state = "failed";
          row.error = j.error;
        } else {
          row.state = j.state;
          if (j.started_at) row.started_at = Date.parse(j.started_at);
        }
      }),
    );
    paint();
  };

  const offs = [
    ctx.on("job.queued", (d) => {
      if (d.kind !== "clear" || byJob.has(d.job_id)) return;
      const g = d.input?.gtin;
      const m = d.input?.market;
      if (!g || !m) return;
      const row = rowFor(g, m) ?? { gtin: g, market: m, name: catalogue?.skus?.find((s) => s.gtin === g)?.name ?? "", state: "queued", stage: -1, seen: [], submitted_at: Date.now() };
      if (!rows.includes(row)) rows.unshift(row);
      row.job = d.job_id;
      byJob.set(d.job_id, row);
      paint();
    }),
    ctx.on("job.started", (d) => {
      const row = byJob.get(d.job_id);
      if (row) {
        row.state = "running";
        row.started_at = Date.now();
        paint();
      }
    }),
    ctx.on("loop.tool", (d) => {
      const row = rowFor(d.gtin, d.market);
      if (!row) return;
      row.state = "running";
      const s = stageOfTool(d.tool);
      if (s !== null) {
        // The current stage is the latest tool's; every stage a tool ran in counts as done.
        row.stage = s;
        row.seen = [...new Set([...(row.seen ?? []), s])];
      }
      row.fact = d.fact ?? row.fact;
      paint();
    }),
    ctx.on("clear.done", (d) => {
      const row = rowFor(d.gtin, d.market);
      if (!row) return;
      Object.assign(row, { status: d.status, rules: d.rules, applied: d.applied, queued: !!d.queue_id, stage: STAGES.length - 1 });
      paint();
    }),
    ctx.on("job.done", (d) => {
      const row = byJob.get(d.job_id);
      if (!row) return;
      finish(row, d.result);
      paint();
      refreshCat();
    }),
    ctx.on("job.failed", (d) => {
      const row = byJob.get(d.job_id);
      if (!row) return;
      row.state = "failed";
      row.error = d.error;
      paint();
    }),
    ctx.on("decision.written", refreshCat),
    ctx.on("approval.queued", refreshCat),
    ctx.on("approval.resolved", refreshCat),
    ctx.on("approval.superseded", refreshCat),
    mountStream(el.querySelector("[data-stream]"), {
      filter: (type) => type.startsWith("loop.") || type.startsWith("clear.") || type === "job.failed",
      onLine: () => {
        const w = el.querySelector("[data-live-wrap]");
        if (w && !w.dataset.opened) {
          w.open = true;
          w.dataset.opened = "1";
        }
      },
    }),
  ];
  paint();
  resume();
  loadCat();
  return () => {
    clearTimeout(catTimer);
    clearInterval(tick);
    offs.forEach((f) => f());
  };
}
