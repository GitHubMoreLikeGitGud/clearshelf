// Telemetry: the footer (model, measured speed, VRAM, cloud calls, cold vs warm) and the
// tokens-per-chunk chart. Every number keeps its label; an absent value reads "not measured".

import { api, esc, fmtMs, fmtNum, on } from "../lib.js";

const NOT_MEASURED = `<span class="nm">not measured</span>`;
const MEASURED = "measured";
const ESTIMATED = "estimated (chars/4)";

function item(k, v, note = "", title = "", cls = "") {
  return `<div class="tele__item${cls ? ` ${cls}` : ""}"${title ? ` title="${esc(title)}"` : ""}><span class="tele__top"><span class="tele__k">${esc(k)}</span>${note ? ` <span class="tele__n">${note}</span>` : ""}</span><span class="tele__v">${v}</span></div>`;
}

const sumTok = (t) => (t && typeof t.in === "number" && typeof t.out === "number" ? t.in + t.out : null);
const arrow = (a, b, fmt) => (a === null || a === undefined || b === null || b === undefined ? `<span class="nm">not measured</span>` : `${esc(fmt(a))} → ${esc(fmt(b))}`);

/**
 * All four measured figures of the cold-versus-warm pair, the ones that did not improve as
 * well as the ones that did: chunks, planner tokens, tool-model tokens, wall time.
 */
export function coldWarmFigures(cw) {
  const n = (v) => fmtNum(v);
  return `<span class="cw"><span class="cw__f"><span class="cw__k">chunks</span> ${arrow(cw.cold.chunks, cw.warm.chunks, n)}</span><span class="cw__f"><span class="cw__k">planner</span> ${arrow(sumTok(cw.cold.planner_tokens), sumTok(cw.warm.planner_tokens), n)}</span><span class="cw__f"><span class="cw__k">tool</span> ${arrow(sumTok(cw.cold.tool_model_tokens), sumTok(cw.warm.tool_model_tokens), n)}</span><span class="cw__f"><span class="cw__k">time</span> ${arrow(cw.cold.wall_ms, cw.warm.wall_ms, (ms) => `${fmtNum(ms / 1000, 1)} s`)}</span></span>`;
}

function coldWarmTitle(cw) {
  const io = (t) => (t ? `${fmtNum(t.in)} in / ${fmtNum(t.out)} out` : "not measured");
  return `Same SKU (${cw.gtin ?? ""} ${cw.market ?? ""}) cleared cold, then warm (${cw.label}). Chunks ${fmtNum(cw.cold.chunks)} → ${fmtNum(cw.warm.chunks)}. Planner tokens ${io(cw.cold.planner_tokens)} → ${io(cw.warm.planner_tokens)}. Tool-model tokens ${io(cw.cold.tool_model_tokens)} → ${io(cw.warm.tool_model_tokens)}${cw.warm.extraction_reused ? " (the extraction was reused from memory)" : ""}. Wall time ${fmtMs(cw.cold.wall_ms)} → ${fmtMs(cw.warm.wall_ms)}.`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** The cold and warm runs of the newest cold-vs-warm measurement, as stored. */
function coldWarm(cw) {
  const runs = Array.isArray(cw?.runs) ? cw.runs : null;
  const cold = runs?.find((r) => r.mode === "cold");
  const warm = runs?.find((r) => r.mode === "warm");
  if (!cold || !warm) return null;
  return { cold, warm, label: cw.label ?? MEASURED, gtin: cw.gtin, market: cw.market };
}

/** Pure: the footer from GET /api/telemetry. */
export function renderFooter(t) {
  if (!t || typeof t !== "object") return `<div class="tele">${item("Telemetry", NOT_MEASURED)}</div>`;
  const host = t.model_host ? hostOf(t.model_host) : null;
  const parts = [];
  parts.push(item("Model", esc(t.model ?? "unknown"), host ? `Ollama on ${esc(host.replace(/:\d+$/u, ""))}` : "", host ? `Local Ollama at ${t.model_host}; the agent refuses any non-local model host` : ""));
  const tps = t.planner_tokens_per_s;
  const hasTps = tps && typeof tps.value === "number";
  parts.push(item("Planner", hasTps ? `${esc(fmtNum(tps.value))} tok/s` : NOT_MEASURED, hasTps ? `<span class="label">${esc(tps.label ?? MEASURED)}</span>, median of ${esc(fmtNum(tps.runs))}` : ""));
  const v = t.vram;
  const gpu = v && typeof v.whole_gpu_mib_peak === "number" ? v.whole_gpu_mib_peak : null;
  const model = v && Array.isArray(v.ollama_ps) && v.ollama_ps[0] && typeof v.ollama_ps[0].size_vram_mib === "number" ? v.ollama_ps[0].size_vram_mib : null;
  parts.push(
    item(
      "Peak VRAM",
      gpu === null && model === null ? NOT_MEASURED : `${gpu === null ? "not measured" : `${esc(fmtNum(gpu))} MiB GPU`}${model === null ? "" : `, model ${esc(fmtNum(model))} MiB`}`,
      gpu === null && model === null ? "" : `<span class="label">${esc(MEASURED)}</span>`,
      v?.label ?? "",
    ),
  );
  const refused = typeof t.refused_non_local_model_hosts === "number" ? t.refused_non_local_model_hosts : null;
  parts.push(item("Cloud model calls", `${esc(fmtNum(t.cloud_model_calls ?? 0))}${refused === null ? "" : `<span class="tele__sub">${esc(fmtNum(refused))} non-local refused</span>`}`, "", "Every model call goes to the local Ollama host; any other host is refused and counted"));
  const cw = coldWarm(t.cold_warm);
  parts.push(item("Cold → warm", cw ? coldWarmFigures(cw) : NOT_MEASURED, cw ? `tokens in+out, <span class="label">${esc(cw.label)}</span>` : "", cw ? coldWarmTitle(cw) : "", "tele__item--cw"));
  const chart = Array.isArray(t.latest_loop?.chart) ? t.latest_loop.chart : [];
  parts.push(
    item(
      "Per chunk",
      chart.length ? renderSparkline(chart) : NOT_MEASURED,
      chart.length ? `<span class="label">${esc(MEASURED)}</span> vs <span class="label">est.</span>` : "",
      chart.length ? `Latest run ${t.latest_loop.run_id ?? ""} (${t.latest_loop.gtin ?? ""} ${t.latest_loop.market ?? ""}): solid line, Markovian prompt per chunk (${MEASURED}); dashed line, full-history baseline (${ESTIMATED})` : "",
    ),
  );
  return `<div class="tele">${parts.join("")}</div>`;
}

function seriesOf(points) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => p && Number.isFinite(Number(p.chunk)));
  return {
    pts,
    measured: pts.map((p) => (Number.isFinite(Number(p.markovian_prompt_tokens_measured)) ? Number(p.markovian_prompt_tokens_measured) : null)),
    naive: pts.map((p) => (Number.isFinite(Number(p.naive_prompt_tokens_estimated)) ? Number(p.naive_prompt_tokens_estimated) : null)),
  };
}

function path(xs, ys) {
  let d = "";
  let pen = false;
  ys.forEach((y, i) => {
    if (y === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${xs[i].toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}

/** A footer-sized sparkline of the same two series (decorative; the numbers are in the chart). */
export function renderSparkline(points) {
  const { pts, measured, naive } = seriesOf(points);
  if (!pts.length) return NOT_MEASURED;
  const W = 96;
  const H = 22;
  const max = Math.max(1, ...measured.filter((x) => x !== null), ...naive.filter((x) => x !== null));
  const xs = pts.map((_, i) => (pts.length === 1 ? W / 2 : 2 + (i * (W - 4)) / (pts.length - 1)));
  const y = (v) => (v === null ? null : H - 2 - (v / max) * (H - 4));
  const last = measured[measured.length - 1];
  const lastNaive = naive[naive.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Latest run: ${esc(fmtNum(last))} prompt tokens in the last chunk, measured; the full-history baseline would be ${esc(fmtNum(lastNaive))}, estimated">
    <path class="spark__naive" d="${path(xs, naive.map(y))}"/><path class="spark__m" d="${path(xs, measured.map(y))}"/></svg>`;
}

/** Pure: the tokens-per-chunk chart (inline SVG) from LoopReport.chart. */
export function renderTokenChart(points, opts = {}) {
  const { pts, measured, naive } = seriesOf(points);
  if (!pts.length || measured.every((v) => v === null)) return `<p class="chart chart--empty muted">no chart data</p>`;
  const W = 560;
  const H = 210;
  const L = 52;
  const R = 16;
  const T = 18;
  const B = 34;
  const vals = [...measured, ...naive].filter((v) => v !== null);
  const rawMax = Math.max(...vals, 1);
  const step = rawMax > 4000 ? 1000 : rawMax > 2000 ? 500 : rawMax > 800 ? 250 : 100;
  const max = Math.ceil((rawMax * 1.08) / step) * step;
  const xs = pts.map((_, i) => (pts.length === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1)));
  const y = (v) => (v === null ? null : T + (H - T - B) * (1 - v / max));
  const ticks = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);
  const label = `Prompt tokens per chunk${opts.title ? ` for ${opts.title}` : ""}: Markovian measured ${measured.filter((v) => v !== null).map((v) => fmtNum(v)).join(", ")}; full-history baseline estimated ${naive.filter((v) => v !== null).map((v) => fmtNum(v)).join(", ")}.`;
  const grid = ticks
    .map((v) => `<line class="chart__grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="chart__tick" x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmtNum(v))}</text>`)
    .join("");
  const xlab = pts.map((p, i) => `<text class="chart__tick" x="${xs[i].toFixed(1)}" y="${H - B + 16}" text-anchor="middle">${esc(p.chunk)}</text>`).join("");
  // Each value label goes on the outside of its pair: above the higher point, below the lower one.
  const dots = (ys, others, cls) =>
    ys
      .map((v, i) => {
        if (v === null) return "";
        const above = others[i] === null || v >= others[i];
        const anchor = pts.length > 1 && i === 0 ? "start" : pts.length > 1 && i === pts.length - 1 ? "end" : "middle";
        const dx = anchor === "start" ? -3 : anchor === "end" ? 3 : 0;
        return `<circle class="${cls}" cx="${xs[i].toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.2"/><text class="chart__val ${cls}-val" x="${(xs[i] + dx).toFixed(1)}" y="${(y(v) + (above ? -8 : 16)).toFixed(1)}" text-anchor="${anchor}">${esc(fmtNum(v))}</text>`;
      })
      .join("");
  return `<figure class="chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">
      <title>${esc(label)}</title>
      ${grid}
      <line class="chart__axis" x1="${L}" x2="${L}" y1="${T}" y2="${H - B}"/>
      <line class="chart__axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
      ${xlab}
      <text class="chart__axislabel" x="${(L + W - R) / 2}" y="${H - 3}" text-anchor="middle">chunk</text>
      <path class="chart__naive" d="${path(xs, naive.map(y))}"/>
      <path class="chart__m" d="${path(xs, measured.map(y))}"/>
      ${dots(naive, measured, "chart__ndot")}
      ${dots(measured, naive, "chart__mdot")}
    </svg>
    <figcaption class="legend">
      <span class="legend__item"><span class="legend__swatch legend__swatch--m" aria-hidden="true"></span>Markovian prompt per chunk (measured)</span>
      <span class="legend__item"><span class="legend__swatch legend__swatch--n" aria-hidden="true"></span>full-history baseline (estimated, chars/4)</span>
    </figcaption>
  </figure>`;
}

/** Mounts the footer and refreshes it whenever a job finishes. Returns the unsubscribe function. */
export function mountFooter(el) {
  const load = async () => {
    const r = await api("/api/telemetry");
    el.innerHTML = r.ok ? renderFooter(r.data) : `<div class="tele">${item("Telemetry", `<span class="nm">${esc(r.data?.error ?? "not available")}</span>`)}</div>`;
  };
  load();
  return on("job.done", () => load());
}

/**
 * Fills every [data-mount="token-chart"] under root that names a run, GTIN and market
 * (data-run, data-gtin, data-market) from GET /api/loops/:run/:gtin/:market.
 */
export async function mountTokenCharts(root) {
  const els = [...root.querySelectorAll('[data-mount="token-chart"][data-run]')];
  await Promise.all(
    els.map(async (el) => {
      const run = el.getAttribute("data-run");
      const gtin = el.getAttribute("data-gtin");
      const market = el.getAttribute("data-market");
      el.innerHTML = `<p class="muted">Loading the loop report…</p>`;
      const r = await api(`/api/loops/${encodeURIComponent(run)}/${encodeURIComponent(gtin)}/${encodeURIComponent(market)}`);
      el.innerHTML = r.ok ? renderTokenChart(r.data?.loop?.chart, { title: `${gtin} ${market}` }) : `<p class="muted">${r.status === 404 ? "no loop report for this action" : esc(r.data?.error ?? "loop report not available")}</p>`;
    }),
  );
}
