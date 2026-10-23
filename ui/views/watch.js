// Recall watch: poll for new FDA and FSA notices (or replay as of a date), see what each sweep
// matched and did, review name-only matches, and check the closed loop in Zetaris.
// Render functions are pure; mount() fetches and wires.

import { api, esc, evidenceChips, evidenceSummary, fmtMs, fmtNum, fmtTime, idHtml, noAddress, OFFICER, plainReason, rememberEvidence, renderError, ruleBadge, ruleLegend, statusChip, tag, zoneName } from "../lib.js";
import { mountTokenCharts } from "./telemetry.js";
import { mountStream } from "./stream.js";

const yes = (v) => (v === true ? `<span class="tick">yes</span>` : v === false ? `<span class="cross">no</span>` : `<span class="muted">not checked</span>`);
const FOUND_BY = { recall_product_link: "the recall link table", gs1_scan: "a GS1 barcode scan of the notice", nemotron: "the model's reading", manifest: "the intake manifest" };

function sqlBlock(sql, id) {
  return sql ? `<details class="sqlbox"><summary>Lightning SQL</summary><pre class="sql" id="${esc(id)}">${esc(sql)}</pre></details>` : "";
}

/** "w20261023T181358…" -> "23 Oct 18:13:58" (sweep ids carry the server's local start time). */
export function sweepTime(id) {
  const m = /^[wr](\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/u.exec(String(id ?? ""));
  if (!m) return String(id ?? "");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1];
  return `${Number(m[3])} ${mon} ${m[4]}:${m[5]}:${m[6]}`;
}

/** Pure: the join map (per GTIN transform: links, in the catalogue, orphans = links - in catalogue). */
export function renderJoinMap(d) {
  const rows = Array.isArray(d?.rows) ? d.rows : [];
  return `<div class="table-wrap"><table class="num">
    <thead><tr><th scope="col">GTIN transform</th><th scope="col">Links</th><th scope="col">In catalogue</th><th scope="col">Orphans</th></tr></thead>
    <tbody>${rows
      .map((r) => {
        const links = Number(r.links ?? 0);
        const inCat = Number(r.in_catalogue ?? 0);
        return `<tr><th scope="row"><code>${esc(r.transform)}</code></th><td>${esc(fmtNum(links))}</td><td>${esc(fmtNum(inCat))}</td><td>${esc(fmtNum(links - inCat))}</td></tr>`;
      })
      .join("") || `<tr><td colspan="4" class="muted">No links.</td></tr>`}</tbody></table></div>
    <p class="small muted">Through Zetaris in ${esc(fmtMs(d?.elapsed_ms))}, cache ${esc(d?.cache_state ?? "unknown")}, run ${esc(fmtTime(d?.executed_at, true))}</p>${sqlBlock(d?.sql, "sql-joinmap")}`;
}

/** Pure: the closed-loop recheck (cleared listings against recalls that arrived since). `cleared` = how many listings are cleared now. */
export function renderRecheck(d, cleared = null) {
  const rows = Array.isArray(d?.rows) ? d.rows : [];
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const of = typeof cleared === "number" ? ` of ${fmtNum(cleared)}` : "";
  const why = typeof cleared === "number" && cleared === 0 ? ": no listing is cleared at the moment, so there is nothing to recheck" : rows.length ? "" : ": none is affected";
  return `<p class="recheck__n"><strong>${esc(fmtNum(rows.length))}${esc(of)}</strong> cleared listing${(typeof cleared === "number" ? cleared : rows.length) === 1 ? "" : "s"} now named by a recall${esc(why)}</p>
    ${rows.length ? `<div class="table-wrap"><table class="rows"><thead><tr>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(noAddress(String(r[c] ?? "")))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : ""}
    <p class="small muted">Through Zetaris in ${esc(fmtMs(d?.elapsed_ms))}, cache ${esc(d?.cache_state ?? "unknown")}, run ${esc(fmtTime(d?.executed_at, true))}</p>${sqlBlock(d?.sql, "sql-recheck")}`;
}

function reviewForm(item, title, where = "sweep", name = "") {
  const fid = `nm-${where}-${item.id}`;
  return `<form class="review" data-form="namematch" data-queue="${esc(item.id)}" novalidate>
    <p class="review__what"><strong>${esc(name || item.gtin)}</strong> <code class="gtin">${esc(item.gtin)}</code> ${esc(item.market)} and notice <code>${esc(item.notice_id ?? "")}</code>${typeof item.similarity === "number" ? `, name similarity ${esc(fmtNum(item.similarity, 2))}` : ""}${item.replay ? ` ${tag(item.replay.banner, "replay")}` : ""}</p>
    ${title ? `<p class="small">${esc(noAddress(title))}</p>` : ""}
    <p class="small muted">${esc(noAddress(item.summary ?? ""))} ${evidenceChips(item.run_id, item.evidence_ids, { max: 3 })}</p>
    <label class="field" for="${esc(fid)}"><span class="field__label">Reason (required)</span><textarea id="${esc(fid)}" rows="2" data-reason></textarea></label>
    <div class="act__buttons"><button type="button" class="btn btn--hold" data-act="confirm" disabled>Confirm the match (holds the listing)</button><button type="button" class="btn btn--ghost" data-act="dismiss" disabled>Dismiss</button></div>
    <div data-result aria-live="polite"></div>
  </form>`;
}

/**
 * Pure: one sweep record. pending = the pending queue items (to know which name matches still
 * need review); opts.current = the current decision per "gtin|market", opts.names = product
 * names by GTIN, opts.outcomes = officer outcomes by queue id.
 */
export function renderSweep(s, pending = [], opts = {}) {
  if (!s) return `<p class="muted">No sweep yet. Start a replay as of a date, or poll now.</p>`;
  const current = opts.current ?? null;
  const names = opts.names ?? {};
  const outcomes = opts.outcomes ?? new Map();
  const pendingIds = new Set(pending.map((p) => p.id));
  const title = (id) => s.notices?.find((n) => n.notice_id === id)?.title ?? "";
  const actions = Array.isArray(s.actions) ? s.actions : [];
  const exact = Array.isArray(s.exact_matches) ? s.exact_matches : [];
  const nameMatches = Array.isArray(s.name_matches) ? s.name_matches : [];
  const notices = Array.isArray(s.notices) ? s.notices : [];
  const rules = [...new Set(actions.flatMap((a) => a.rules ?? []))];
  return `<article class="sweep">
    <header class="sweep__head">
      <h3>${esc(s.kind === "baseline" ? "Baseline sweep" : "Poll")} started ${esc(fmtTime(s.started_at, true) || sweepTime(s.sweep_id))}</h3>
      ${s.banner ? tag(s.banner, "replay") : tag("live", "live")}
      <p class="small">Read notices reported after <strong>${esc(s.window?.after)}</strong> up to <strong>${esc(s.window?.up_to)}</strong>, in ${esc(fmtMs(s.wall_ms))}. Model: ${esc(fmtNum(s.model?.calls))} call${s.model?.calls === 1 ? "" : "s"}, ${esc(fmtNum(s.model?.tokens_in))} in / ${esc(fmtNum(s.model?.tokens_out))} out tokens <span class="label">${esc(s.model?.label ?? "measured")}</span>. Sweep <code>${esc(s.sweep_id)}</code>.</p>
    </header>
    <div class="sweep__counts">
      <div><span class="big">${esc(fmtNum(notices.length))}</span> new notice${notices.length === 1 ? "" : "s"} read</div>
      <div><span class="big">${esc(fmtNum(exact.length))}</span> name${exact.length === 1 ? "s" : ""} a catalogue barcode</div>
      <div><span class="big">${esc(fmtNum(nameMatches.length))}</span> name-only match${nameMatches.length === 1 ? "" : "es"} for review</div>
      <div><span class="big">${esc(fmtNum(s.recheck?.rows?.length ?? 0))}</span> cleared listing${(s.recheck?.rows?.length ?? 0) === 1 ? "" : "s"} hit ${evidenceChips(null, s.recheck?.evidence_id ? [s.recheck.evidence_id] : [], { noneText: "" })}</div>
    </div>
    <h4>What the sweep did <span class="panel__note">HOLD and BLOCK are applied automatically; anything that clears waits for a signature</span></h4>
    ${ruleLegend(rules, { label: "Rules: " })}
    ${
      actions.length
        ? `<ul class="actions">${actions
            .map((a) => {
              const cur = current?.[`${a.gtin}|${a.market}`] ?? null;
              const superseded = cur && a.decision_id && cur.decision_id !== a.decision_id;
              const plains = String(a.reason ?? "")
                .split(/; (?=(?:R\d|ESC) )/u)
                .map((x) => /(?:^|: )(R\d|ESC) (.*)$/u.exec(x.trim()))
                .filter(Boolean)
                .map((m) => `${ruleBadge(m[1])} ${esc(plainReason(m[1], m[2]))}`);
              return `<li class="action">
          <div class="action__head">${statusChip(a.status, { proposed: !a.applied })}<span class="rule-list">${(a.rules ?? []).map((r) => ruleBadge(r, { named: true })).join("")}</span><a href="#/sku/${esc(a.gtin)}/${esc(a.market)}"><strong>${esc(names[a.gtin] ?? "")}</strong> <code class="gtin">${esc(a.gtin)}</code> ${esc(a.market)}</a></div>
          <p class="small"><strong>${esc(a.trigger)}</strong></p>
          ${plains.length ? `<ul class="action__why small">${plains.map((p) => `<li>${p}</li>`).join("")}</ul>` : `<p class="small">${esc(noAddress(a.reason))}</p>`}
          <dl class="kv kv--inline small"><div class="kv__row"><dt>Applied</dt><dd>${a.applied ? "yes, automatically" : a.queue_id ? `waiting for a signature (<code>${esc(a.queue_id)}</code>)` : "no"}</dd></div><div class="kv__row"><dt>Decision</dt><dd>${a.decision_id ? `<code>${idHtml(a.decision_id)}</code>` : "none"}</dd></div><div class="kv__row"><dt>Visible in Zetaris</dt><dd>${yes(a.visible_in_zetaris)}</dd></div></dl>
          ${superseded ? `<p class="small msg msg--warn">Since superseded: the current decision for this listing is ${statusChip(cur.status)} <code>${idHtml(cur.decision_id)}</code> (${esc(fmtTime(cur.decided_at))}).</p>` : ""}
          <p class="small">Evidence: ${evidenceSummary(a.run_id, a.evidence_ids)}</p>
          <div class="action__chart" data-mount="token-chart" data-run="${esc(a.run_id)}" data-gtin="${esc(a.gtin)}" data-market="${esc(a.market)}"></div>
        </li>`;
            })
            .join("")}</ul>`
        : `<p class="muted small">No catalogue listing needed an action in this sweep.</p>`
    }
    ${
      exact.length
        ? `<h4>Notices that name a catalogue barcode</h4><ul class="claims">${exact.map((x) => `<li><code>${esc(x.notice_id)}</code> names <strong>${esc(names[x.gtin] ?? "")}</strong> <code class="gtin">${esc(x.gtin)}</code>; found by ${esc((x.by ?? []).map((b) => FOUND_BY[b] ?? b).join(", "))}${x.link_written ? "; link written to the ops store" : ""} ${evidenceChips(null, x.evidence_ids)}</li>`).join("")}</ul>`
        : ""
    }
    <h4 id="h-names">Name-only matches <span class="panel__note">a person decides: confirm holds the listing (R2), dismiss changes nothing</span></h4>
    ${
      nameMatches.length
        ? `<ul class="reviews">${nameMatches
            .map((n) => {
              const item = pending.find((p) => p.id === n.queue_id);
              const out = n.queue_id ? outcomes.get(n.queue_id) : null;
              if (item && pendingIds.has(item.id)) return `<li>${reviewForm(item, title(n.notice_id), "sweep", names[item.gtin])}</li>`;
              return `<li class="review review--done">${out ? `<div class="act-outcome" tabindex="-1" data-outcome="${esc(n.queue_id)}">${out}</div>` : ""}<p><code>${esc(n.notice_id)}</code> and <strong>${esc(names[n.gtin] ?? "")}</strong> <code class="gtin">${esc(n.gtin)}</code> ${esc(n.market)}, similarity ${esc(fmtNum(n.similarity, 2))}, ${n.confirmed_in_zetaris ? "candidate confirmed in Zetaris" : "not confirmed in Zetaris"}; ${n.queue_id ? `review item <code>${esc(n.queue_id)}</code> already settled` : "not queued"} ${evidenceChips(null, n.evidence_ids, { max: 3 })}</p><p class="small muted">${esc(noAddress(title(n.notice_id)))}</p></li>`;
            })
            .join("")}</ul>`
        : `<p class="muted small">None.</p>`
    }
    <details class="notices"${notices.length && notices.length <= 6 ? " open" : ""}><summary>${esc(fmtNum(notices.length))} notice${notices.length === 1 ? "" : "s"} read</summary>
      ${
        notices.length
          ? `<div class="table-wrap"><table class="rows notices__t"><thead><tr><th scope="col">Notice</th><th scope="col">Date</th><th scope="col">Title</th><th scope="col">Allergens</th><th scope="col">Matched</th><th scope="col">Evidence</th></tr></thead><tbody>${notices
              .map(
                (n) => `<tr><td><span class="src-tag">${esc(String(n.source).toUpperCase())}</span> <code class="nowrap">${esc(n.notice_id)}</code>${n.classification ? `<br><span class="small muted">${esc(n.classification)}, ${esc(n.status ?? "")}</span>` : ""}${n.guard?.hit ? `<br><span class="cross small">guard hit</span>` : ""}</td><td class="nowrap">${esc(n.date)}</td><td class="notices__title">${esc(noAddress(n.title))}${n.firm ? `<br><span class="small muted">${esc(n.firm)}</span>` : ""}</td><td>${esc((n.allergens ?? []).join(", "))}</td><td>${n.exact_gtins?.length ? `barcode ${esc(n.exact_gtins.join(", "))}` : ""}${n.name_candidates?.length ? `${n.exact_gtins?.length ? "<br>" : ""}name ${esc(n.name_candidates.join(", "))}` : ""}${!n.exact_gtins?.length && !n.name_candidates?.length ? `<span class="muted">none</span>` : ""}</td><td>${evidenceChips(null, n.evidence_ids, { max: 2 })}</td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : `<p class="muted small">No new notices in this window.</p>`
      }
    </details>
    ${(s.gaps ?? []).length ? `<h4>Gaps</h4><ul class="nc">${s.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : ""}
  </article>`;
}

/**
 * Pure: the officer's queue: proposals waiting for a signature, and name-only matches.
 * A name-only match that the open sweep already shows links there instead of repeating its form.
 */
export function renderQueue(items, opts = {}) {
  const inSweep = opts.inSweep ?? new Set();
  const names = opts.names ?? {};
  const props = items.filter((i) => i.kind === "proposal");
  const nm = items.filter((i) => i.kind === "name_match");
  return `${
    props.length
      ? `<h3 class="queue__h">Waiting for your signature <span class="panel__note">${esc(fmtNum(props.length))}</span></h3><ul class="queue">${props
          .map(
            (q) =>
              `<li>${statusChip(q.status, { proposed: true })} <a href="#/sku/${esc(q.gtin)}/${esc(q.market)}"><strong>${esc(names[q.gtin] ?? q.gtin)}</strong> <span class="muted">${esc(q.market)}</span></a><br><span class="small muted">proposed ${esc(fmtTime(q.created_at))}${q.statement ? `; statement "${esc(q.statement)}"` : "; no statement"}</span>${q.replay ? ` ${tag(q.replay.banner, "replay")}` : ""}</li>`,
          )
          .join("")}</ul>`
      : `<p class="muted small">No proposal is waiting for a signature.</p>`
  }
    ${
      nm.length
        ? `<h3 class="queue__h">Name-only matches to review <span class="panel__note">${esc(fmtNum(nm.length))}</span></h3><ul class="reviews">${nm
            .map((q) => (inSweep.has(q.id) ? `<li class="small"><code>${esc(q.notice_id ?? "")}</code> and <strong>${esc(names[q.gtin] ?? q.gtin)}</strong>: <a href="#h-names">review it in the sweep</a></li>` : `<li>${reviewForm(q, "", "queue", names[q.gtin])}</li>`))
            .join("")}</ul>`
        : ""
    }`;
}

/** Pure: the watch's state line. sweeps = how many sweep records exist. */
export function renderState(w, sweeps = 0) {
  const st = w?.state ?? null;
  if (!st || !st.mode || st.mode === "off") {
    return `<p class="state"><strong>The watch is off</strong>: it is neither replaying nor polling live.${sweeps ? ` ${esc(fmtNum(sweeps))} earlier sweep${sweeps === 1 ? " is" : "s are"} kept below for reference.` : ""} Start a replay as of a date to show a known past, or poll now.</p>`;
  }
  const mode = st.mode === "replay" ? `<strong>Replaying</strong> from ${esc(st.replay?.origin ?? "")}: the watch now sees notices up to <strong>${esc(st.as_of)}</strong>` : `<strong>Live</strong>: notices up to <strong>${esc(st.as_of)}</strong>`;
  return `<p class="state">${mode}; ${esc(fmtNum(st.polls))} poll${st.polls === 1 ? "" : "s"} so far; last sweep ${st.last_sweep_id ? esc(sweepTime(st.last_sweep_id)) : "none"}${w.busy ? `; <strong>a sweep is running</strong>` : ""}.</p>`;
}

export function mount(el, ctx) {
  const zone = zoneName();
  el.innerHTML = `<h1 class="view-h">Recall watch</h1>
  <section class="panel watch-ctl" aria-labelledby="h-ctl">
    <h2 id="h-ctl" class="sr-only">Controls</h2>
    <div class="watch-ctl__row">
      <button type="button" class="btn btn--primary" data-act="poll">Poll now</button>
      <form class="watch-ctl__replay" data-form="replay" novalidate>
        <label for="asof">Replay as of</label><input id="asof" type="date" value="2026-10-10" required>
        <button type="submit" class="btn">Start replay</button>
      </form>
      <button type="button" class="btn btn--ghost" data-act="live">Go live</button>
    </div>
    <div data-state></div>
    <div data-ctl-result aria-live="polite"></div>
  </section>
  <section class="panel" data-live hidden aria-labelledby="h-wlive"><h2 id="h-wlive" class="panel__h">Sweep progress <span class="panel__note" data-live-note>live events; times in ${esc(zone || "local time")}</span></h2><ol class="stream" data-stream></ol></section>
  <div class="watch-grid">
    <section class="panel watch-sweep" aria-labelledby="h-sweep">
      <h2 id="h-sweep" class="panel__h">Sweep results <label class="sweep-pick"><span class="sr-only">Choose a sweep</span><select data-pick></select></label></h2>
      <div data-sweep><p class="muted">Loading sweeps…</p></div>
    </section>
    <aside class="watch-side">
      <section class="panel" aria-labelledby="h-queue"><h2 id="h-queue" class="panel__h">Approval queue</h2><div data-queue-list><p class="muted">Loading…</p></div></section>
      <section class="panel" aria-labelledby="h-recheck"><h2 id="h-recheck" class="panel__h">Closed-loop recheck <button type="button" class="btn btn--small btn--ghost" data-act="recheck">Run again</button></h2><div data-recheck><p class="muted">Querying Zetaris…</p></div></section>
      <section class="panel" aria-labelledby="h-join"><h2 id="h-join" class="panel__h">Join map <button type="button" class="btn btn--small btn--ghost" data-act="join">Run again</button></h2><div data-join><p class="muted">Querying Zetaris…</p></div></section>
    </aside>
  </div>`;

  const $ = (sel) => el.querySelector(sel);
  let pending = [];
  let current = null;
  let currentDecisions = {};
  let names = {};
  let cleared = null;
  let sweepCount = 0;
  const outcomes = new Map();
  let focusOutcome = null;

  const loadContext = async () => {
    const [c, d] = await Promise.all([api("/api/catalogue"), api("/api/ops/decisions")]);
    if (c.ok) {
      names = Object.fromEntries((c.data?.skus ?? []).map((s) => [s.gtin, s.name]));
      cleared = (c.data?.skus ?? []).flatMap((s) => Object.values(s.decisions ?? {})).filter((x) => x && (x.status === "CLEAR" || x.status === "CLEAR_WITH_STATEMENT")).length;
    }
    if (d.ok) currentDecisions = Object.fromEntries((d.data?.current ?? []).map((r) => [`${r.gtin}|${r.market}`, r]));
  };
  const loadState = async () => {
    const r = await api("/api/watch/state");
    put("[data-state]", r.ok ? renderState(r.data, sweepCount) : renderError(r));
    return r.data;
  };
  const queueHtml = () => renderQueue(pending, { names, inSweep: new Set((current?.name_matches ?? []).map((n) => n.queue_id).filter(Boolean)) });
  const loadQueue = async () => {
    const r = await api("/api/approvals?state=pending");
    pending = r.ok ? (r.data?.items ?? []) : [];
    const t = put("[data-queue-list]", r.ok ? queueHtml() : renderError(r));
    if (t) wireReviews(t);
  };
  const paintSweep = () => {
    if (!$("[data-sweep]")) return;
    $("[data-sweep]").innerHTML = renderSweep(current, pending, { current: currentDecisions, names, outcomes });
    wireReviews($("[data-sweep]"));
    mountTokenCharts($("[data-sweep]"));
    if (focusOutcome) {
      $(`[data-outcome="${CSS.escape(focusOutcome)}"]`)?.focus();
      focusOutcome = null;
    }
  };
  const showSweep = async (id) => {
    if (!id) {
      current = null;
      $("[data-sweep]").innerHTML = renderSweep(null);
      return;
    }
    const [r, ev] = await Promise.all([api(`/api/watch/sweeps/${encodeURIComponent(id)}`), api(`/api/evidence/${encodeURIComponent(id)}`)]);
    if (ev.ok) rememberEvidence(ev.data?.records ?? []);
    current = r.ok ? r.data : null;
    if (!r.ok) {
      put("[data-sweep]", renderError(r));
      return;
    }
    paintSweep();
    const q = put("[data-queue-list]", queueHtml());
    if (q) wireReviews(q);
  };
  const loadSweeps = async (pick) => {
    const r = await api("/api/watch/sweeps");
    const ids = r.ok ? (r.data?.sweeps ?? []) : [];
    sweepCount = ids.length;
    const sel = $("[data-pick]");
    if (!sel) return;
    sel.innerHTML = ids.map((id, i) => `<option value="${esc(id)}">${esc(sweepTime(id))}${i === 0 ? " (newest)" : ""}</option>`).join("") || `<option value="">no sweeps</option>`;
    const want = pick && ids.includes(pick) ? pick : ids[0];
    if (want) sel.value = want;
    await showSweep(want);
  };
  // The view can be left while a request is in flight: write only into elements that are still there.
  const put = (sel, html) => {
    const t = $(sel);
    if (t) t.innerHTML = html;
    return t;
  };
  const loadZ = async (path, sel, render) => {
    put(sel, `<p class="muted" role="status">Querying Zetaris…</p>`);
    const r = await api(path);
    put(sel, r.ok ? render(r.data) : renderError(r));
  };
  const loadRecheck = () => loadZ("/api/recheck", "[data-recheck]", (d) => renderRecheck(d, cleared));

  function wireReviews(root) {
    for (const form of root.querySelectorAll('form[data-form="namematch"]')) {
      const reason = form.querySelector("[data-reason]");
      const btns = [...form.querySelectorAll("button[data-act]")];
      reason.addEventListener("input", () => btns.forEach((b) => (b.disabled = !reason.value.trim())));
      for (const b of btns) {
        b.addEventListener("click", async () => {
          btns.forEach((x) => (x.disabled = true));
          const confirm = b.dataset.act === "confirm";
          const qid = form.dataset.queue;
          const r = await api(confirm ? "/api/approvals/confirm" : "/api/approvals/reject", { body: { queue_id: qid, reason: reason.value.trim(), officer: OFFICER } });
          if (!r.ok) {
            form.querySelector("[data-result]").innerHTML = renderError(r);
            btns.forEach((x) => (x.disabled = !reason.value.trim()));
            return;
          }
          // The outcome stays on screen, and keeps the focus, after the queue and the sweep reload.
          outcomes.set(qid, `<p class="msg msg--ok small" role="status">${confirm ? `Confirmed by you: the listing is held, decision <code>${idHtml(r.data.decision_id ?? "")}</code>, visible in Zetaris: ${r.data.visible_in_zetaris ? "yes" : "not yet"}.` : "Dismissed by you: no status change."}</p>`);
          focusOutcome = qid;
          ctx.announce(confirm ? "Name match confirmed; the listing is held." : "Name match dismissed.");
          await loadContext();
          await loadQueue();
          if (current) paintSweep();
        });
      }
    }
  }

  const ctlResult = (html) => {
    $("[data-ctl-result]").innerHTML = html;
  };
  const startLive = () => {
    $("[data-live]").hidden = false;
  };

  $('[data-act="poll"]').addEventListener("click", async () => {
    const r = await api("/api/watch/poll", { body: {} });
    ctlResult(r.ok ? `<p class="small muted" role="status">Poll queued as job <code>${esc(r.data.job_id)}</code>.</p>` : renderError(r));
    if (r.ok) startLive();
  });
  $('form[data-form="replay"]').addEventListener("submit", async (e) => {
    e.preventDefault();
    const asOf = $("#asof").value;
    const r = await api("/api/watch/replay", { body: { as_of: asOf, poll: false } });
    ctlResult(r.ok ? `<p class="small muted" role="status">Replay queued as job <code>${esc(r.data.job_id)}</code>: ${esc(r.data.banner)}.</p>` : renderError(r));
    if (r.ok) startLive();
  });
  $('[data-act="live"]').addEventListener("click", async () => {
    const r = await api("/api/watch/live", { body: {} });
    ctlResult(r.ok ? `<p class="small muted" role="status">The watch is live from ${esc(r.data?.state?.as_of ?? "today")}; the replay banner is gone.</p>` : renderError(r));
    loadState();
    ctx.refreshBanner();
  });
  $("[data-pick]").addEventListener("change", (e) => showSweep(e.target.value));
  $('[data-act="recheck"]').addEventListener("click", loadRecheck);
  $('[data-act="join"]').addEventListener("click", () => loadZ("/api/join-map", "[data-join]", renderJoinMap));

  const offs = [
    mountStream($("[data-stream]"), {
      filter: (type) => type.startsWith("watch.") || type.startsWith("loop.") || type === "clear.started" || type === "clear.done" || type === "job.failed",
      onLine: (type) => {
        if (type === "watch.sweep_started") {
          startLive();
          $("[data-live-note]").textContent = `running; times in ${zone || "local time"}`;
        }
        if (type === "watch.sweep_done") $("[data-live-note]").textContent = `finished; times in ${zone || "local time"}`;
      },
    }),
    ctx.on("watch.sweep_done", async (d) => {
      await loadContext();
      await loadQueue();
      await loadSweeps(d.sweep_id);
      loadState();
      loadRecheck();
      ctx.refreshBanner();
    }),
    ctx.on("watch.state", () => {
      loadState();
      ctx.refreshBanner();
    }),
    ctx.on("job.done", (d) => {
      if (String(d.kind).startsWith("watch.")) {
        loadState();
        ctx.refreshBanner();
      }
    }),
    ctx.on("approval.resolved", async () => {
      await loadQueue();
      if (current) paintSweep();
    }),
    ctx.on("approval.queued", () => loadQueue()),
    ctx.on("approval.superseded", () => loadQueue()),
  ];

  (async () => {
    await loadContext();
    const st = await loadState();
    if (st?.busy) startLive();
    await loadQueue();
    await loadSweeps();
    loadState();
    loadRecheck();
    loadZ("/api/join-map", "[data-join]", renderJoinMap);
  })();
  return () => offs.forEach((f) => f());
}
