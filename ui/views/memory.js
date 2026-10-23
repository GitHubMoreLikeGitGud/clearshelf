// Memory and why: H-MEM's allergen-conflict queue (grouped by product and allergen), dream
// (invariant) proposals, the "why" trace and the World Model timeline per listing, the merge
// queue, and the source-access memories the planner reads. Render functions are pure; mount()
// fetches and wires.

import { api, esc, fmtNum, fmtTime, groupWord, OFFICER, renderError, sourceClassWord, statusChip, zoneName } from "../lib.js";
import { loadTraceEvidence, renderWhy, whyTitle } from "./why.js";

const presenceOf = (c) => (c.polarityA === "free_from" ? { mem: c.b, cls: c.classB, pol: c.polarityB, side: "b" } : { mem: c.a, cls: c.classA, pol: c.polarityA, side: "a" });
const freeOf = (c) => (c.polarityA === "free_from" ? { mem: c.a, cls: c.classA, pol: c.polarityA, side: "a" } : { mem: c.b, cls: c.classB, pol: c.polarityB, side: "b" });

/** The rule label a resolution records: the score's own label when the officer keeps the suggested side. */
export function ruleFor(c, side) {
  if (side === "both") return `keep_both_${String(c.allergen).replace(/[^a-z0-9_]/gu, "_")}`.slice(0, 60);
  const win = side === "presence" ? presenceOf(c) : freeOf(c);
  const lose = side === "presence" ? freeOf(c) : presenceOf(c);
  if (win.mem === c.score?.suggested && c.score?.suggestedRule) return c.score.suggestedRule;
  return `${win.cls}_over_${lose.cls}`.replace(/[^a-z0-9_]/gu, "_").slice(0, 60);
}

/** Queued conflicts grouped by what they are about: one product (or brand) and one allergen. */
export function groupConflicts(list) {
  const by = new Map();
  for (const c of Array.isArray(list) ? list : []) {
    const key = `${c.scope === "brand" ? `brand:${c.brand}` : `gtin:${c.gtin}`}|${c.allergen}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(c);
  }
  return [...by.values()];
}

function sideHtml(label, s, c) {
  const mem = s.side === "a" ? c.sides?.a : c.sides?.b;
  return `<div class="side"><p class="side__k">${esc(label)}: <strong>${esc(sourceClassWord(s.cls))}</strong> says <strong>${esc(String(s.pol ?? "").replace("_", " "))}</strong></p>${mem?.content ? `<p class="side__c">${esc(mem.content.length > 220 ? `${mem.content.slice(0, 220)}…` : mem.content)}</p>` : ""}<p class="small muted"><code>${esc(s.mem)}</code>${mem?.label ? `, ${esc(mem.label)}` : ""}</p></div>`;
}

function productLinks(c) {
  const markets = c.product?.markets ?? (c.gtin ? ["UK"] : []);
  return c.gtin ? markets.map((m) => `<a class="small" href="#/sku/${esc(c.gtin)}/${esc(m)}">open the ${esc(m)} card</a>`).join(" ") : "";
}

/** Pure: one product-and-allergen group of queued conflicts, with one resolve form for all of them. */
export function renderConflictGroup(group) {
  const c0 = group[0];
  const n = group.length;
  const who = c0.scope === "brand" ? `brand ${c0.brand ?? ""}` : (c0.product?.name ?? `GTIN ${c0.gtin ?? ""}`);
  const suggestPresence = group.every((c) => c.score?.suggested === presenceOf(c).mem);
  const gid = esc(c0.id);
  const queued = group.filter((c) => c.status === "queued");
  return `<li class="conflict" data-group="${gid}">
    <header class="conflict__head"><h3>${esc(who)}: <span class="allergen">${esc(groupWord(c0.allergen))}</span></h3>${c0.gtin ? `<code class="gtin small">${esc(c0.gtin)}</code>` : ""} ${productLinks(c0)}<span class="small muted">${n > 1 ? `${esc(fmtNum(n))} pairs of memories disagree` : "two memories disagree"}; first detected ${esc(fmtTime(c0.detectedAt))}</span></header>
    <ul class="pairs">${group
      .map(
        (c) => `<li class="pair"><div class="sides">${sideHtml("Presence", presenceOf(c), c)}<div class="sides__vs" aria-hidden="true">against</div>${sideHtml("Free from", freeOf(c), c)}</div>
      <p class="small">The score suggests keeping <strong>${esc(c.score?.suggested === presenceOf(c).mem ? "the presence side" : "the free-from side")}</strong> (${esc(fmtNum(c.score?.a?.total, 2))} against ${esc(fmtNum(c.score?.b?.total, 2))}, rule <code>${esc(c.score?.suggestedRule ?? "")}</code>). A suggestion only; you decide. <code class="muted">${esc(c.id)}</code></p></li>`,
      )
      .join("")}</ul>
    ${
      queued.length
        ? `<details class="resolve-wrap"><summary>Resolve ${n > 1 ? `all ${esc(fmtNum(queued.length))} pairs` : "it"} with a reason</summary><form class="resolve" data-form="resolve" data-ids="${esc(queued.map((c) => c.id).join(" "))}" novalidate>
      <fieldset class="field field--inline"><legend class="field__label">Keep</legend>
        <label><input type="radio" name="side" value="presence" ${suggestPresence ? "checked" : ""}> the presence side (${esc(groupWord(c0.allergen))} is in it)</label>
        <label><input type="radio" name="side" value="free"> the free-from side</label>
        <label><input type="radio" name="side" value="both"> both</label></fieldset>
      <div class="msg msg--warn small" data-free-warn hidden><strong>Keeping the free-from side records ${esc(who)} as free from ${esc(groupWord(c0.allergen))}.</strong> That removes this conflict's hold (R4), so the listing could then be released, even though ${esc(sourceClassWord(presenceOf(c0).cls))} says it ${esc(String(presenceOf(c0).pol).replace("_", " "))} ${esc(groupWord(c0.allergen))}.</div>
      <p class="small muted" data-rules>Rule label recorded: ${queued.map((c) => `<code>${esc(ruleFor(c, suggestPresence ? "presence" : "free"))}</code>`).join(", ")}</p>
      <label class="field" for="why-${gid}"><span class="field__label">Reason (required, recorded in memory)</span><textarea id="why-${gid}" rows="2" data-reason></textarea></label>
      <div class="act__buttons"><button type="submit" class="btn btn--primary" data-act="resolve" disabled>Resolve ${n > 1 ? `${esc(fmtNum(queued.length))} pairs` : "the conflict"}</button></div>
      <div data-result aria-live="polite"></div>
    </form></details>`
        : group.map((c) => `<p class="msg msg--ok small">Resolved by ${esc(c.resolution?.by ?? "")} ${esc(fmtTime(c.resolution?.at))}: ${esc(c.resolution?.outcome ?? "")}, rule <code>${esc(c.resolution?.rule ?? "")}</code>; ${esc(c.resolution?.reason ?? "")}</p>`).join("")
    }
  </li>`;
}

/** Pure: one queued allergen conflict with its resolve form (a group of one). */
export function renderConflict(c) {
  return renderConflictGroup([c]);
}

/** Pure: one dream (invariant) proposal; the wording carries its label exactly as stored. */
export function renderDream(p) {
  const n = Array.isArray(p.derivedFrom) ? p.derivedFrom.length : 0;
  return `<li class="dream">
    <p class="dream__text">${esc(p.wording?.text ?? p.content)}</p>
    <p class="small"><span class="label">${esc(p.wording?.label ?? "")}</span> derived from ${esc(fmtNum(n))} memor${n === 1 ? "y" : "ies"} (${(p.derivedFrom ?? []).map((m) => `<code>${esc(m)}</code>`).join(", ")}), ${esc(fmtNum(p.officerActions))} officer action${p.officerActions === 1 ? "" : "s"}</p>
    <p class="small">${p.predicate ? `If approved it escalates ${esc(p.predicate.scope)} <code>${esc(p.predicate.value)}</code> to ${statusChip(p.predicate.to)}; an invariant can only make a decision stricter.` : "Advisory: no predicate, so it cannot change a decision."}</p>
    ${
      p.status === "proposed"
        ? `<form class="dream__form" data-form="dream" data-id="${esc(p.id)}" novalidate>
      <label class="field" for="dr-${esc(p.id)}"><span class="field__label">Reason (required)</span><textarea id="dr-${esc(p.id)}" rows="2" data-reason></textarea></label>
      <div class="act__buttons"><button type="button" class="btn btn--primary" data-act="approve" disabled>Approve the invariant</button><button type="button" class="btn btn--ghost" data-act="reject" disabled>Reject</button></div>
      <div data-result aria-live="polite"></div></form>`
        : `<p class="small">${esc(p.status)} by ${esc(p.decidedBy ?? "")}${p.reason ? `: ${esc(p.reason)}` : ""}</p>`
    }
  </li>`;
}

function nodeWord(ref) {
  const r = String(ref ?? "");
  let m;
  if ((m = /^product:gtin:(\d+)/u.exec(r))) return "the product";
  if ((m = /^market:code:(\w+)/u.exec(r))) return m[1];
  if ((m = /^allergen:code:(\w+)/u.exec(r))) return groupWord(m[1]);
  if ((m = /^notice:(fda|fsa):([\w-]+)/u.exec(r))) return `${m[1].toUpperCase()} ${m[2]}`;
  if ((m = /^decision:clearshelf:([\w-]+)/u.exec(r))) return `decision ${m[1]}`;
  if ((m = /^firm "(.*)"$/u.exec(r))) return `firm ${m[1]}`;
  return r;
}

const VERB = { listed_in: "is listed in", issued_by: "was issued by", reports: "reports", concerns: "names", decides: "applies to", declares: "declares", made_by: "is made by", alias_of: "is an alias of" };

/** One World Model event as a plain line: "FDA H-1328-2026 reports milk". */
export function plainEvent(e) {
  const s = String(e?.summary ?? "");
  let m;
  if (e?.kind === "upsertEntity" && (m = /^(\w+) (\S+) "(.*)"$/u.exec(s))) {
    if (m[1] === "product") return `Product recorded: "${m[3]}"`;
    if (m[1] === "notice") return `Notice recorded: ${m[3]}`;
    if (m[1] === "decision") return `Decision recorded: ${m[3].replace(/^(\w+) (\d+) (\w+)$/u, "$1 in $3")} (${m[2].replace(/^decision:clearshelf:/u, "")})`;
    return `${m[1][0].toUpperCase()}${m[1].slice(1)} recorded: ${m[3]}`;
  }
  if (e?.kind === "relate" && (m = /^(\S+) -(\w+)-> (.+?)(?: (\{.*\}))?$/u.exec(s))) {
    if (m[3] === "(earlier edge closed)") return `The earlier "${(VERB[m[2]] ?? m[2].replace(/_/gu, " ")).replace(/^is /u, "")}" link was closed`;
    let attrs = "";
    if (m[4]) {
      try {
        const a = JSON.parse(m[4]);
        attrs = [a.status ? `status ${a.status}` : "", a.transform ? `matched by ${a.transform}` : "", a.basis ? `from the ${a.basis}` : ""].filter(Boolean).join(", ");
      } catch {
        attrs = "";
      }
    }
    return `${nodeWord(m[1])[0].toUpperCase()}${nodeWord(m[1]).slice(1)} ${VERB[m[2]] ?? m[2].replace(/_/gu, " ")} ${nodeWord(m[3])}${attrs ? ` (${attrs})` : ""}`;
  }
  if (e?.kind === "assertFact" && (m = /^\S+\.clearance:(\w+) = "(.*)"$/u.exec(s))) return `Clearance in ${m[1]} set to ${m[2]}`;
  return s;
}

/** Pure: the World Model timeline and snapshots for one GTIN (optionally one market). */
export function renderTimeline(d, market) {
  const tl = Array.isArray(d?.timeline) ? d.timeline : [];
  const snaps = (Array.isArray(d?.snapshots) ? d.snapshots : []).filter((s) => !market || s.market === market);
  return `${tl.length ? `<ol class="wm">${tl.map((e) => `<li><time class="small" datetime="${esc(e.at)}">${esc(fmtTime(e.at))}</time><span class="wm__sum" title="${esc(`${e.kind}: ${e.summary}`)}">${esc(plainEvent(e))}</span></li>`).join("")}</ol>` : `<p class="muted small">No World Model events for this GTIN.</p>`}
  ${snaps.length ? `<details class="snaps-wrap"><summary>${esc(fmtNum(snaps.length))} snapshot${snaps.length === 1 ? "" : "s"}${market ? ` for ${esc(market)}` : ""}</summary><ul class="snaps">${snaps.map((s) => `<li>${esc(fmtTime(s.at))}: ${esc(s.reason)}; ${esc(fmtNum(s.edges?.length ?? 0))} link(s), state sha256 <code class="hash">${esc(String(s.stateSha256 ?? "").slice(0, 12))}…</code> <code class="muted">${esc(s.id)}</code></li>`).join("")}</ul></details>` : ""}`;
}

/** Pure: the merge queue; approving or rejecting a merge needs a reason. */
export function renderMerges(list) {
  if (!list.length) return `<p class="muted small">No entity merge is waiting for review.</p>`;
  return `<ul class="merges">${list
    .map(
      (m) => `<li data-id="${esc(m.id)}"><p>${esc(m.summary ?? m.reason ?? JSON.stringify(m).slice(0, 200))}</p><p class="small muted"><code>${esc(m.id)}</code>${m.score !== undefined ? `, score ${esc(fmtNum(m.score, 2))}` : ""}</p>${
        m.status && m.status !== "proposed" && m.status !== "pending"
          ? `<p class="small">${esc(m.status)}</p>`
          : `<form class="merge-form" data-form="merge" data-id="${esc(m.id)}" novalidate><label class="field" for="mg-${esc(m.id)}"><span class="field__label">Reason (required)</span><textarea id="mg-${esc(m.id)}" rows="2" data-reason></textarea></label><div class="act__buttons"><button type="button" class="btn btn--primary btn--small" data-act="approve" disabled>Approve merge</button><button type="button" class="btn btn--ghost btn--small" data-act="reject" disabled>Reject</button></div><div data-result aria-live="polite"></div></form>`
      }</li>`,
    )
    .join("")}</ul>`;
}

/** Pure: the source-access memories, grouped by source. */
export function renderSources(memories) {
  if (!memories.length) return `<p class="muted small">No source-access memories are seeded.</p>`;
  const groups = new Map();
  for (const m of memories) {
    const src = (m.tags ?? []).find((t) => t.startsWith("source:"))?.slice(7) ?? "other";
    if (!groups.has(src)) groups.set(src, []);
    groups.get(src).push(m);
  }
  const NAMES = { off: "Open Food Facts", fda: "openFDA", fsa: "UK FSA", zetaris: "Zetaris", rules: "Labelling rules", other: "Other" };
  return [...groups.entries()]
    .map(
      ([k, list]) =>
        `<details class="srcgroup"><summary>${esc(NAMES[k] ?? k)} <span class="panel__note">${esc(fmtNum(list.length))} memor${list.length === 1 ? "y" : "ies"}</span></summary><ul class="srcmem">${list
          .map((m) => `<li${m.superseded_by ? ' class="srcmem--old"' : ""}><p>${esc(m.content)}</p><p class="small muted"><code>${esc(m.id)}</code> ${esc(m.label ?? "")}${m.superseded_by ? `; superseded by ${esc(m.superseded_by)}` : ""}</p></li>`)
          .join("")}</ul></details>`,
    )
    .join("");
}

/** Pure: the empty dream queue, with how far dreaming is from proposing anything. */
export function renderNoDreams(d) {
  const n = typeof d?.officer_rulings === "number" ? d.officer_rulings : null;
  return `<p class="muted small">No invariant is proposed yet. Dreaming runs after ${esc(d?.runs_after ?? "each recall-watch sweep")} and proposes a rule only when at least two separate officer rulings point the same way${n === null ? "." : `; ${esc(fmtNum(n))} officer ruling${n === 1 ? " is" : "s are"} recorded so far.`}</p>`;
}

let pick = { gtin: null, market: "UK" };

export function mount(el, ctx) {
  el.innerHTML = `<h1 class="view-h">Memory and why</h1>
  <div class="mem-grid">
    <section class="panel" aria-labelledby="h-conf"><h2 id="h-conf" class="panel__h">Allergen conflicts <span class="panel__note">queued for the officer; never settled by the last write</span></h2><div data-conf-out></div><div data-conf><p class="muted">Loading…</p></div></section>
    <section class="panel" aria-labelledby="h-dream"><h2 id="h-dream" class="panel__h">Dream proposals <span class="panel__note">rules mined from officer rulings; none takes effect until approved</span></h2><div data-dream><p class="muted">Loading…</p></div></section>
  </div>
  <section class="panel why-panel" aria-labelledby="h-why">
    <h2 id="h-why" class="panel__h" data-why-title>Why this decision?</h2>
    <div class="why-pick">
      <label for="why-gtin">Listing</label><select id="why-gtin"></select>
      <span class="small muted">The trace and the timeline follow the listing you pick. Times in ${esc(zoneName() || "local time")}.</span>
    </div>
    <div class="why-grid"><div data-why-body aria-live="polite"><p class="muted">Choose a listing.</p></div><div><h3 class="why__h">World Model timeline</h3><div data-tl></div></div></div>
  </section>
  <div class="mem-grid">
    <section class="panel" aria-labelledby="h-merge"><h2 id="h-merge" class="panel__h">World Model merge queue</h2><div data-merge-q><p class="muted">Loading…</p></div></section>
    <section class="panel" aria-labelledby="h-srcmem"><h2 id="h-srcmem" class="panel__h">Source-access memories <span class="panel__note">what the planner is told about each source</span></h2><div data-mount="source-memories"><p class="muted">Loading…</p></div></section>
  </div>`;
  // The view can be left while a request is in flight; writes then find no element and stop.
  const missing = { innerHTML: "", textContent: "", querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
  const $ = (s) => el.querySelector(s) ?? missing;
  let catalogue = null;
  let resolving = 0;

  const loadConf = async () => {
    const r = await api("/api/memory/conflicts?state=queued");
    const list = r.data?.conflicts ?? [];
    const groups = groupConflicts(list);
    $("[data-conf]").innerHTML = !r.ok
      ? renderError(r)
      : list.length
        ? `<p class="small">${esc(fmtNum(list.length))} queued pair${list.length === 1 ? "" : "s"} of memories, in ${esc(fmtNum(groups.length))} product-and-allergen group${groups.length === 1 ? "" : "s"}; each holds its listing under R4 until resolved.</p><ol class="conflicts">${groups.map(renderConflictGroup).join("")}</ol>`
        : `<p class="muted small">No conflict is queued.</p>`;
    wireForms($("[data-conf]"));
  };
  const loadDreams = async () => {
    const r = await api("/api/memory/dreams");
    const list = r.data?.proposals ?? [];
    $("[data-dream]").innerHTML = !r.ok ? renderError(r) : list.length ? `<ol class="dreams">${list.map(renderDream).join("")}</ol>` : renderNoDreams(r.data);
    wireForms($("[data-dream]"));
  };
  const loadMerges = async () => {
    const r = await api("/api/world/merges");
    $("[data-merge-q]").innerHTML = r.ok ? renderMerges(r.data?.proposals ?? []) : renderError(r);
    wireForms($("[data-merge-q]"));
  };
  const loadSources = async () => {
    const r = await api("/api/memory/sources");
    $('[data-mount="source-memories"]').innerHTML = r.ok ? renderSources(r.data?.memories ?? []) : renderError(r);
  };
  const loadWhy = async () => {
    if (!pick.gtin) return;
    $("[data-why-body]").innerHTML = `<p class="muted" role="status">Loading the trace…</p>`;
    const [w, t] = await Promise.all([api(`/api/why/${pick.gtin}/${pick.market}`), api(`/api/world/timeline/${pick.gtin}`)]);
    if (w.ok) await loadTraceEvidence(w.data);
    const name = catalogue?.skus?.find((s) => s.gtin === pick.gtin)?.name ?? pick.gtin;
    $("[data-why-body]").innerHTML = w.ok ? renderWhy(w.data) : renderError(w);
    $("[data-why-title]").textContent = w.ok ? `${whyTitle(w.data)} ${name}, ${pick.market}` : "Why this decision?";
    $("[data-tl]").innerHTML = t.ok ? renderTimeline(t.data, pick.market) : renderError(t);
  };

  function wireForms(root) {
    for (const form of root.querySelectorAll("form[data-form]")) {
      const reason = form.querySelector("[data-reason]");
      const btns = [...form.querySelectorAll("button[data-act]")];
      const sideOk = () => form.dataset.form !== "resolve" || !!form.querySelector('input[name="side"]:checked');
      const sync = () => btns.forEach((b) => (b.disabled = !reason.value.trim() || !sideOk()));
      reason.addEventListener("input", sync);
      form.addEventListener("change", sync);
      const out = form.querySelector("[data-result]");
      if (form.dataset.form === "resolve") {
        const warn = form.querySelector("[data-free-warn]");
        const ids = (form.dataset.ids ?? "").split(" ").filter(Boolean);
        const rulesEl = form.querySelector("[data-rules]");
        form.addEventListener("change", async () => {
          const side = form.querySelector('input[name="side"]:checked')?.value;
          warn.hidden = side !== "free";
          if (side && rulesEl) {
            const r = await api("/api/memory/conflicts?state=queued");
            const list = (r.data?.conflicts ?? []).filter((c) => ids.includes(c.id));
            rulesEl.innerHTML = `Rule label recorded: ${list.map((c) => `<code>${esc(ruleFor(c, side))}</code>`).join(", ")}`;
          }
        });
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const side = form.querySelector('input[name="side"]:checked')?.value;
          if (!side) return;
          btns.forEach((b) => (b.disabled = true));
          const r0 = await api("/api/memory/conflicts?state=queued");
          const byId = new Map((r0.data?.conflicts ?? []).map((c) => [c.id, c]));
          const jobs = [];
          const errors = [];
          for (const id of ids) {
            const c = byId.get(id);
            if (!c) continue;
            const winner = side === "both" ? "both" : side === "presence" ? presenceOf(c).mem : freeOf(c).mem;
            resolving += 1;
            const r = await api("/api/memory/conflicts/resolve", { body: { id, winner, rule: ruleFor(c, side), reason: reason.value.trim(), officer: OFFICER } });
            if (r.ok) jobs.push(r.data.job_id);
            else {
              resolving = Math.max(0, resolving - 1);
              errors.push(renderError(r));
            }
          }
          out.innerHTML = `${jobs.length ? `<p class="msg msg--ok small" role="status">${esc(fmtNum(jobs.length))} resolution${jobs.length === 1 ? "" : "s"} queued (the reason is mined into memory, one model call each). The list updates as each one lands.</p>` : ""}${errors.join("")}`;
          if (resolving > 0) $("[data-conf-out]").innerHTML = jobs.length ? `<div class="act-outcome" tabindex="-1"><p class="msg msg--ok small" role="status">Resolving ${esc(fmtNum(jobs.length))} conflict pair${jobs.length === 1 ? "" : "s"} for ${esc(form.closest(".conflict")?.querySelector("h3")?.textContent ?? "")}: each is marked resolved as its job finishes.</p></div>` : "";
          if (!jobs.length) sync();
          ctx.announce(jobs.length ? "Resolution queued." : "Resolution refused.");
        });
      }
      if (form.dataset.form === "dream") {
        for (const b of btns) {
          b.addEventListener("click", async () => {
            btns.forEach((x) => (x.disabled = true));
            const r = await api(`/api/memory/dreams/${b.dataset.act}`, { body: { id: form.dataset.id, reason: reason.value.trim(), officer: OFFICER } });
            out.innerHTML = r.ok ? `<p class="msg msg--ok small" role="status">${b.dataset.act === "approve" ? `Approved as memory <code>${esc(r.data.memory ?? "")}</code>.` : "Rejected."}</p>` : renderError(r);
            if (!r.ok) sync();
            else loadDreams();
          });
        }
      }
      if (form.dataset.form === "merge") {
        for (const b of btns) {
          b.addEventListener("click", async () => {
            btns.forEach((x) => (x.disabled = true));
            const r = await api(`/api/world/merges/${b.dataset.act}`, { body: { id: form.dataset.id, reason: reason.value.trim(), officer: OFFICER } });
            out.innerHTML = r.ok ? `<p class="msg msg--ok small" role="status">${b.dataset.act === "approve" ? "Merge approved" : "Merge rejected"}; your reason is recorded.</p>` : renderError(r);
            if (!r.ok) sync();
            else setTimeout(loadMerges, 800);
          });
        }
      }
    }
  }

  const picker = $("#why-gtin");
  picker.addEventListener("change", () => {
    const [g, m] = picker.value.split("/");
    pick = { gtin: g, market: m };
    try {
      history.replaceState(null, "", `#/memory/${g}/${m}`);
    } catch {
      /* the URL is a convenience only */
    }
    loadWhy();
  });

  const offs = [
    ctx.on("memory.conflict_resolved", () => {
      resolving = Math.max(0, resolving - 1);
      loadConf();
      loadWhy();
      if (!resolving) $("[data-conf-out]").innerHTML = `<div class="act-outcome" tabindex="-1"><p class="msg msg--ok small" role="status">Resolved: the reasons are recorded in memory. Re-clear the listing to update its decision.</p></div>`;
    }),
    ctx.on("memory.dream_approved", loadDreams),
    ctx.on("memory.dream_rejected", loadDreams),
    ctx.on("memory.dreamed", loadDreams),
    ctx.on("memory.officer_reason", loadDreams),
    ctx.on("world.merge_resolved", loadMerges),
    ctx.on("world.recorded", (d) => {
      if (d.gtin === pick.gtin) loadWhy();
    }),
  ];

  (async () => {
    const c = await api("/api/catalogue");
    catalogue = c.ok ? c.data : null;
    const opts = (catalogue?.skus ?? []).flatMap((s) =>
      s.markets.map((m) => {
        const d = s.decisions?.[m]?.status ?? null;
        const p = (s.pending ?? []).find((x) => x.kind === "proposal" && x.market === m);
        return { v: `${s.gtin}/${m}`, t: `${s.name || s.gtin} (${m})`, st: d ? d.replaceAll("_", " ") : p ? `${p.status.replaceAll("_", " ")} proposed` : "not cleared" };
      }),
    );
    if (ctx.params.gtin) pick = { gtin: ctx.params.gtin, market: ctx.params.market ?? "UK" };
    if (!pick.gtin && opts[0]) [pick.gtin, pick.market] = opts[0].v.split("/");
    picker.innerHTML = opts.map((o) => `<option value="${esc(o.v)}"${o.v === `${pick.gtin}/${pick.market}` ? " selected" : ""}>${esc(o.t)}: ${esc(o.st)}</option>`).join("");
    loadWhy();
  })();
  loadConf();
  loadDreams();
  loadMerges();
  loadSources();
  return () => offs.forEach((f) => f());
}
