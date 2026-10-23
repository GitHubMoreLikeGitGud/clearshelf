// The live investigation stream: the Markovian loop's planner calls and tool steps, and the
// recall watch's sweep progress, as they arrive over server-sent events. renderStreamEvent is pure.

import { esc, evidenceChips, fmtClock, fmtMs, fmtNum, kindOfTool, noAddress, on, ruleBadge, statusChip, stripEvidenceRefs } from "../lib.js";

const STREAM_TYPES = [
  "clear.started", "loop.chunk_start", "loop.planner", "loop.tool", "loop.chunk_end", "clear.done",
  "decision.written", "approval.queued", "job.failed", "contract.refused",
  "watch.sweep_started", "watch.notice", "watch.exact_match", "watch.name_match", "watch.clear_started", "watch.action", "watch.approval_queued", "watch.recheck", "watch.sweep_done",
];

function who(d) {
  return d.gtin ? `<code>${esc(d.gtin)}</code>${d.market ? ` ${esc(d.market)}` : ""}` : "";
}

/** One stream line, or "" for an event the stream does not show. */
export function renderStreamEvent(type, d = {}) {
  const t = d.at ? `<time class="s__t" datetime="${esc(d.at)}">${esc(fmtClock(d.at))}</time>` : `<span class="s__t"></span>`;
  const line = (cls, body) => `<li class="s s--${cls}">${t}${body}</li>`;
  switch (type) {
    case "clear.started":
      return line("start", `<span class="s__b">Investigation started for ${who(d)}${d.run_id ? `, run <code>${esc(d.run_id)}</code>` : ""}${d.banner ? ` <span class="tag tag--replay">${esc(d.banner)}</span>` : ""}</span>`);
    case "loop.chunk_start":
      return line("chunk", `<span class="s__b"><span class="s__chunk">Chunk ${esc(d.chunk)}</span> ${who(d)} starts with ${esc(fmtNum(d.carryover_tokens))} tokens of carried state <span class="label">estimated (chars/4)</span></span>`);
    case "loop.planner":
      return line(
        "plan",
        `<span class="s__b"><span class="s__k">Planner</span> ${d.valid ? `chose <code>${esc(d.tool ?? "no action")}</code>` : `<span class="cross">invalid reply</span>`}${d.thought ? `; its note, as written: <q class="s__thought">${esc(d.thought)}</q>` : ""} <span class="s__m">${esc(fmtNum(d.prompt_tokens))} prompt / ${esc(fmtNum(d.eval_tokens))} out tokens <span class="label">measured</span>${d.attempts > 1 ? `, ${esc(d.attempts)} attempts` : ""}</span></span>`,
      );
    case "loop.tool":
      return line(
        d.ok ? "tool" : "fail",
        `<span class="s__b"><span class="s__k">${d.source === "fallback" ? "Fallback step" : "Tool"}</span> <code>${esc(d.tool)}</code> ${d.ok ? `<span class="tick" aria-label="succeeded">✓</span>` : `<span class="cross" aria-label="failed">✗</span>`} ${esc(noAddress(stripEvidenceRefs(d.fact)))} ${evidenceChips(d.run_id ?? null, d.evidence_ids, { kind: kindOfTool(d.tool), max: 4 })}${d.fallback_reason ? ` <span class="s__m">fallback: ${esc(d.fallback_reason)}</span>` : ""} <span class="s__m">${esc(fmtMs(d.latency_ms))}</span></span>`,
      );
    case "loop.chunk_end":
      return line("chunk", `<span class="s__b"><span class="s__chunk">Chunk ${esc(d.chunk)} ends</span> state ${esc(fmtNum(d.state_tokens))} tokens <span class="label">estimated (chars/4)</span>${d.complete ? ", checklist complete" : ""}</span>`);
    case "clear.done":
      return line("done", `<span class="s__b">Decision for ${who(d)}: ${statusChip(d.status, { proposed: !d.applied && !!d.queue_id })} ${(d.rules ?? []).map((r) => ruleBadge(r)).join(" ")}${d.applied ? ", applied automatically" : d.queue_id ? ", waiting for the officer's signature" : ""}${d.chunks ? `, ${esc(d.chunks)} chunks` : ""}</span>`);
    case "decision.written":
      return line("done", `<span class="s__b">Decision row written for ${who(d)}: ${statusChip(d.status)} <code>${esc(d.decision_id)}</code>${d.visible_in_zetaris === true ? ", visible in Zetaris" : d.visible_in_zetaris === false ? ", not yet visible in Zetaris" : ""}</span>`);
    case "approval.queued":
    case "watch.approval_queued":
      return line("queue", `<span class="s__b">Queued for the officer: ${who(d)} ${d.status ? statusChip(d.status, { proposed: true }) : ""} <code>${esc(d.queue_id ?? "")}</code></span>`);
    case "job.failed":
      return line("fail", `<span class="s__b"><span class="cross">Job failed</span> ${esc(d.kind ?? "")}: ${esc(d.error ?? "")}</span>`);
    case "contract.refused":
      return line("fail", `<span class="s__b">Contract refused (${esc(d.code ?? "")})${d.reason ? `: ${esc(d.reason)}` : ""}</span>`);
    case "watch.sweep_started":
      return line("start", `<span class="s__b">Sweep <code>${esc(d.sweep_id)}</code> (${esc(d.kind)}) for notices after ${esc(d.window?.after)} up to ${esc(d.window?.up_to)}${d.banner ? ` <span class="tag tag--replay">${esc(d.banner)}</span>` : ""}</span>`);
    case "watch.notice":
      return line(
        "tool",
        `<span class="s__b"><span class="s__k">${esc(String(d.source ?? "").toUpperCase())} notice</span> <code>${esc(d.notice_id)}</code> ${esc(d.date ?? "")}${d.status ? ` ${esc(d.status)}` : ""}; ${d.exact_gtins?.length ? `names ${esc(d.exact_gtins.join(", "))}` : "no catalogue GTIN"}${d.name_candidates?.length ? `; name candidates ${esc(d.name_candidates.join(", "))}` : ""}${d.guard_hit ? ` <span class="cross">guard hit</span>` : ""}</span>`,
      );
    case "watch.exact_match":
      return line("hit", `<span class="s__b"><span class="s__k">Exact GTIN match</span> <code>${esc(d.notice_id)}</code> names <code>${esc(d.gtin)}</code> (${esc((d.by ?? []).join(", "))})</span>`);
    case "watch.name_match":
      return line("queue", `<span class="s__b"><span class="s__k">Name-only match</span> <code>${esc(d.notice_id)}</code> and ${who(d)}, similarity ${esc(fmtNum(d.similarity, 2))}; for review, no status change</span>`);
    case "watch.clear_started":
      return line("start", `<span class="s__b">Re-clearing ${who(d)}: ${esc(d.trigger ?? "")}</span>`);
    case "watch.action":
      return line("done", `<span class="s__b">Action for ${who(d)}: ${statusChip(d.status, { proposed: !d.applied })} ${(d.rules ?? []).map((r) => ruleBadge(r)).join(" ")}${d.applied ? ", applied automatically" : ", waiting for a signature"}${d.visible_in_zetaris ? ", visible in Zetaris" : ""}</span>`);
    case "watch.recheck":
      return line("tool", `<span class="s__b">Closed-loop recheck through Zetaris: ${esc(fmtNum(Array.isArray(d.rows) ? d.rows.length : d.rows))} row(s) ${evidenceChips(null, d.evidence_id ? [d.evidence_id] : [])}</span>`);
    case "watch.sweep_done":
      return line("done", `<span class="s__b">Sweep <code>${esc(d.sweep_id)}</code> done in ${esc(fmtMs(d.wall_ms))}: ${esc(fmtNum(d.notices))} notice(s), ${esc(fmtNum(d.exact_matches))} exact, ${esc(fmtNum(d.name_matches))} name-only, ${esc(fmtNum((d.actions ?? []).length))} action(s)</span>`);
    default:
      return "";
  }
}

/**
 * Appends events to a list as they arrive. filter(type, data) picks the events; the list keeps
 * the newest `keep` lines. Returns the unsubscribe function.
 */
export function mountStream(listEl, { filter = () => true, keep = 400, onLine } = {}) {
  const offs = STREAM_TYPES.map((type) =>
    on(type, (d) => {
      if (!filter(type, d)) return;
      const html = renderStreamEvent(type, d);
      if (!html) return;
      const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
      listEl.insertAdjacentHTML("beforeend", html);
      while (listEl.children.length > keep) listEl.firstElementChild.remove();
      if (atBottom) listEl.scrollTop = listEl.scrollHeight;
      onLine?.(type, d);
    }),
  );
  return () => offs.forEach((f) => f());
}
