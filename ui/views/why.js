// "Why was this held?": three to five plain lines first, each with the evidence it rests on;
// then, folded, the server's full trace and one time-ordered ledger merged from H-MEM's ledger
// entries and its allergen conflicts (repeated reads folded). renderWhy is pure.

import {
  api,
  esc,
  evidenceChips,
  evidenceIdsIn,
  fmtTime,
  groupFirings,
  groupWord,
  idHtml,
  linkEvidenceIds,
  plainReason,
  rememberEvidence,
  renderError,
  ruleBadge,
  RULES,
  runOfEvidence,
  sourceClassWord,
  statusChip,
  zoneName,
} from "../lib.js";
import { openDrawer, pushDrawer, updateDrawer } from "./drawer.js";

const EV = /^ev-[rw]\d{8}T\d{6}[0-9a-f]{4}-\d{2,4}$/u;
const DECIDING = new Set(["HOLD", "BLOCK", "CLEAR", "CLEAR_WITH_STATEMENT"]);

export function whyTitle(trace) {
  const s = trace?.current?.status ?? trace?.hmem?.decision?.status ?? null;
  return s === "HOLD" ? "Why was this held?" : s === "BLOCK" ? "Why was this blocked?" : "Why this decision?";
}

function actorHtml(actor) {
  const a = String(actor ?? "unknown");
  return a === "officer" ? `<strong class="actor actor--officer">officer</strong>` : `<span class="actor">${esc(a.replace("clearshelf-policy", "policy").replace("clearshelf-agent", "agent"))}</span>`;
}

function detailText(d) {
  if (!d || typeof d !== "object") return "";
  const bits = [];
  if (d.action) bits.push(String(d.action));
  if (d.ruling) bits.push(`ruling ${d.ruling}`);
  if (d.rule) bits.push(`rule ${d.rule}`);
  if (d.outcome) bits.push(String(d.outcome).replace("_", " "));
  if (d.reason) bits.push(`reason: ${d.reason}`);
  if (d.by && d.by !== d.actor) bits.push(`by ${d.by}`);
  if (d.query) bits.push(`query "${d.query}"`);
  if (d.tool) bits.push(`for ${d.tool}`);
  return bits.join("; ");
}

/**
 * One list in time order: conflict detection and resolution (with rule label and reason), and
 * every ledger entry. Repeated reads of one memory are folded into a single line marked `read`.
 */
export function ledgerEvents(hmem) {
  const conflicts = Array.isArray(hmem?.conflicts) ? hmem.conflicts : [];
  const sides = new Set(conflicts.flatMap((c) => [c.a, c.b]));
  const detectedBy = new Map();
  for (const block of Array.isArray(hmem?.ledger) ? hmem.ledger : []) {
    for (const e of Array.isArray(block.entries) ? block.entries : []) if (e.action === "conflict_detected" && !detectedBy.has(e.memoryId)) detectedBy.set(e.memoryId, e.actor);
  }
  const out = [];
  for (const c of conflicts) {
    const t = Date.parse(c.detectedAt);
    out.push({
      t,
      actor: detectedBy.get(c.a) ?? detectedBy.get(c.b) ?? "H-MEM",
      action: "conflict detected",
      memory: c.id,
      text: `${groupWord(c.allergen)}: ${sourceClassWord(c.classA)} says ${String(c.polarityA).replace("_", " ")} [${c.a}], ${sourceClassWord(c.classB)} says ${String(c.polarityB).replace("_", " ")} [${c.b}]; the score suggests keeping ${c.score?.suggested ?? "?"} (${c.score?.suggestedRule ?? "no rule"})`,
      refs: [],
      officer: false,
    });
    if (c.resolution) {
      out.push({
        t: Date.parse(c.resolution.at),
        actor: c.resolution.by,
        action: "conflict resolved",
        memory: c.id,
        text: `${c.resolution.outcome?.replace("_", " ") ?? ""}${c.resolution.winner ? ` ${c.resolution.winner}` : ""}; rule ${c.resolution.rule}; reason: ${c.resolution.reason}`,
        refs: [],
        officer: c.resolution.by === "officer",
      });
    }
  }
  for (const block of Array.isArray(hmem?.ledger) ? hmem.ledger : []) {
    const reads = [];
    for (const e of Array.isArray(block.entries) ? block.entries : []) {
      if (e.action === "read") {
        reads.push(e);
        continue;
      }
      if ((e.action === "conflict_detected" || e.action === "conflict_resolved") && sides.has(e.memoryId)) continue;
      const ns = e.newState ?? {};
      const tags = Array.isArray(ns.tags) ? ns.tags : [];
      const refs = e.action === "create" && Array.isArray(ns.provenance?.refs) ? [...new Set(ns.provenance.refs.filter((r) => EV.test(String(r))))] : [];
      const isDecision = tags.includes("kind:decision");
      const changed = e.action === "update" && ns.supersededBy ? `superseded by ${ns.supersededBy}` : "";
      out.push({
        t: Number(e.timestamp),
        actor: e.actor,
        action: e.action === "create" && isDecision ? "decision recorded" : e.action === "create" && tags.includes("actor:officer") ? "officer reason recorded" : e.action.replaceAll("_", " "),
        memory: e.memoryId,
        text: e.action === "create" ? String(ns.content ?? "") : [changed, detailText(e.details)].filter(Boolean).join("; "),
        refs,
        officer: e.actor === "officer",
      });
    }
    if (reads.length) {
      const last = reads[reads.length - 1];
      out.push({
        t: Number(reads[0].timestamp),
        actor: reads[0].actor,
        action: reads.length === 1 ? "read" : `read ×${reads.length}`,
        memory: block.memoryId,
        text: reads.length > 1 ? `first ${fmtTime(Number(reads[0].timestamp))}, last ${fmtTime(Number(last.timestamp))}` : detailText(reads[0].details),
        refs: [],
        officer: false,
        read: true,
      });
    }
  }
  return out.filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
}

function conflictLine(c) {
  const head = `${sourceClassWord(c.classA).replace(/^the /u, "")} says ${String(c.polarityA).replace("_", " ")} ${groupWord(c.allergen)}; ${sourceClassWord(c.classB).replace(/^the /u, "")} says ${String(c.polarityB).replace("_", " ")}`;
  if (c.status === "queued") return `${head[0].toUpperCase()}${head.slice(1)}: queued for you to settle (H-MEM conflict ${c.id}).`;
  const r = c.resolution ?? {};
  return `${head[0].toUpperCase()}${head.slice(1)}: settled by ${r.by ?? "?"} ${fmtTime(r.at)} (${r.outcome === "keep_both" ? "kept both" : `kept ${r.winner}`}, rule ${r.rule}): "${r.reason ?? ""}".`;
}

/**
 * The three to five plain lines that answer the question, each with the evidence it rests on:
 * what was decided and by whom, the rules behind it, the officer's reason, and the Zetaris
 * read-back of the decision row.
 */
export function plainLines(trace) {
  const cur = trace?.current ?? null;
  const d = trace?.hmem?.decision ?? null;
  const out = [];
  if (cur || d) {
    const status = cur?.status ?? d?.status;
    const by = cur?.actor ?? d?.actor;
    const at = cur?.decided_at ?? d?.decidedAt;
    const state = d?.state === "proposed" ? "proposed, not applied" : d?.state === "not_applied" ? "not applied" : by === "officer" ? "signed by the officer" : "applied automatically";
    const replay = d?.replayAsOf ? ` <span class="tag tag--replay">${esc(d.replayLabel ?? `Replay as of ${d.replayAsOf}`)}</span>` : "";
    out.push({
      html: `${statusChip(status)} <span>${esc(state[0].toUpperCase() + state.slice(1))}, ${esc(fmtTime(at))}${cur ? `, decision <code>${idHtml(cur.decision_id)}</code>` : ""}${d?.runId ? `, run <code>${esc(d.runId)}</code>` : ""}.</span>${replay}`,
      ev: d?.evidenceId ? [d.evidenceId] : [],
    });
  }
  const firings = (d?.firings ?? []).filter((f) => DECIDING.has(f.effect));
  const groups = groupFirings(firings);
  const conflicts = Array.isArray(trace?.hmem?.conflicts) ? trace.hmem.conflicts : [];
  const ruleLines = groups.map(([rule, fs]) => {
    const plains = [...new Set(fs.map((f) => plainReason(rule, f.reason)))];
    // A conflict settled after the decision says so here.
    const settled = conflicts.filter((c) => c.status !== "queued" && fs.some((f) => String(f.reason).includes(c.id)));
    const text = `${plains.slice(0, 2).join("; ")}${plains.length > 2 ? `; and ${plains.length - 2} more` : ""}${settled.length ? ` (conflict since settled by ${settled[0].resolution?.by ?? "the officer"})` : ""}`;
    return { html: `${ruleBadge(rule)} <strong>${esc(RULES[rule]?.name ?? rule)}:</strong> ${esc(text)}`, ev: [...new Set(fs.flatMap((f) => f.evidenceIds ?? []))] };
  });
  const room = 3;
  if (ruleLines.length > room) {
    const rest = groups.slice(room - 1);
    out.push(...ruleLines.slice(0, room - 1));
    out.push({ html: rest.map(([rule, fs]) => `${ruleBadge(rule)} ${esc(RULES[rule]?.name ?? rule)} (${fs.length})`).join(", "), ev: [...new Set(rest.flatMap(([, fs]) => fs.flatMap((f) => f.evidenceIds ?? [])))] });
  } else {
    out.push(...ruleLines);
  }
  if (d?.releasedOver?.length) out.push({ html: `Released by ${actorHtml(d.actor)} over the hold (${d.releasedOver.map((r) => ruleBadge(r)).join(" ")}).`, ev: d.evidenceId ? [d.evidenceId] : [] });
  const reason = d?.actor === "officer" ? (d.reason ?? null) : null;
  const curReason = cur?.actor === "officer" ? String(cur.reason ?? "").replace(/^officer (HOLD|BLOCK): /u, "") : null;
  if (reason || curReason) out.push({ html: `Officer's reason: <q>${esc(reason ?? curReason)}</q>${cur?.contract_id ? ` <span class="muted">(contract <code>${idHtml(cur.contract_id)}</code>)</span>` : ""}`, ev: [] });
  for (const c of conflicts.slice(0, ruleLines.length ? 0 : 2)) out.push({ html: esc(conflictLine(c)), ev: [] });
  const z = Array.isArray(trace?.zetaris) ? trace.zetaris : null;
  const zev = trace?.citations?.prior_decisions ?? null;
  if (z) {
    const row = cur ? z.find((r) => r.decision_id === cur.decision_id) : z[0];
    out.push({
      html: row ? `Zetaris returns this decision row from <code>clearance_usl.decision</code>: the closed loop holds.` : `Zetaris <code>clearance_usl.decision</code> has ${esc(z.length)} row(s) for this listing${cur ? `, not yet the current one` : ""}.`,
      ev: zev ? [zev] : [],
    });
  }
  return out;
}

/** The trace for one GTIN and market (the /api/why reply). */
export function renderWhy(trace) {
  if (!trace || typeof trace !== "object") return `<p class="muted">No trace.</p>`;
  const lines = Array.isArray(trace.lines) ? trace.lines : [];
  const events = ledgerEvents(trace.hmem);
  const reads = events.filter((e) => e.read);
  const acts = events.filter((e) => !e.read);
  const plain = plainLines(trace);
  const zone = zoneName();
  const item = (e) => `<li class="ledger__item${e.officer ? " ledger__item--officer" : ""}">
          <time class="ledger__t" datetime="${esc(new Date(e.t).toISOString())}">${esc(fmtTime(e.t, true))}</time>
          <span class="ledger__who">${actorHtml(e.actor)}</span>
          <span class="ledger__what"><span class="ledger__action">${esc(e.action)}</span> <code>${esc(e.memory)}</code>${e.text ? ` <span class="ledger__text">${esc(e.text)}</span>` : ""}${e.refs.length ? ` ${evidenceChips(null, e.refs, { max: 3 })}` : ""}</span>
        </li>`;
  return `<section class="why">
    <ol class="why__plain">${plain.map((l) => `<li>${l.html}${l.ev.length ? ` ${evidenceChips(null, l.ev, { max: 4 })}` : ""}</li>`).join("") || `<li class="muted">No decision on record for this listing.</li>`}</ol>
    <p class="small muted">Times in ${esc(zone || "local time")}. Hover or focus a chip to see what it cites; open it for the SQL, rows, licence and timestamps.</p>
    <details class="why__more"><summary>Full trace, as the server wrote it (${esc(lines.length)} lines)</summary>
      <ol class="why__lines">${lines.map((l) => `<li>${linkEvidenceIds(l)}</li>`).join("") || `<li class="muted">The server returned no trace lines.</li>`}</ol>
    </details>
    <details class="why__more"><summary>Ledger, in time order (${esc(acts.length)} change${acts.length === 1 ? "" : "s"}${reads.length ? `, ${esc(reads.length)} read line${reads.length === 1 ? "" : "s"} folded` : ""})</summary>
      ${acts.length ? `<ol class="ledger">${acts.map(item).join("")}</ol>` : `<p class="muted">The ledger has no changes for this listing.</p>`}
      ${reads.length ? `<details class="why__reads"><summary>Reads of these memories (${esc(reads.length)})</summary><ol class="ledger">${reads.map(item).join("")}</ol></details>` : ""}
    </details>
  </section>`;
}

/** The evidence runs a trace cites, fetched once so its chips can say what they are. */
export async function loadTraceEvidence(trace) {
  const ids = new Set([...(trace?.lines ?? []).flatMap(evidenceIdsIn), ...(trace?.hmem?.decision?.firings ?? []).flatMap((f) => f.evidenceIds ?? []), trace?.hmem?.decision?.evidenceId, trace?.citations?.prior_decisions].filter(Boolean));
  const runs = new Set([...ids].map((id) => runOfEvidence(id)).filter(Boolean));
  await Promise.all(
    [...runs].slice(0, 6).map(async (run) => {
      const r = await api(`/api/evidence/${encodeURIComponent(run)}`);
      if (r.ok) rememberEvidence(r.data?.records ?? []);
    }),
  );
}

export async function openWhy(gtin, market, opts = {}) {
  const entry = (opts.push ? pushDrawer : openDrawer)({ title: "Why this decision?", kicker: `${gtin} ${market}`, html: `<p class="muted" role="status">Loading the ledger trace…</p>` });
  const r = await api(`/api/why/${encodeURIComponent(gtin)}/${encodeURIComponent(market)}`);
  if (!r.ok) return updateDrawer(entry, { html: renderError(r) });
  await loadTraceEvidence(r.data);
  updateDrawer(entry, { title: whyTitle(r.data), html: renderWhy(r.data) });
}
