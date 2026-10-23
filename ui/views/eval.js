// Evaluation: the measured report (docs/eval-report.md, from GET /api/eval/report) rendered as
// a page, so the last demo step can show the eval table. The markdown is the report's own text;
// every character is escaped before the few inline marks (bold, code, links) are applied.

import { api, esc, fmtTime, renderError, safeUrl } from "../lib.js";

function marks(s) {
  let out = esc(s);
  out = out.replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (m, text, url) => {
    const u = safeUrl(url.replaceAll("&amp;", "&"));
    return u ? `<a href="${esc(u)}" rel="noreferrer" target="_blank">${text}</a>` : text;
  });
  return out;
}

/** Inline code spans first (their text stays literal), then bold and links in the rest. */
function inline(s) {
  return String(s ?? "")
    .split(/`([^`]+)`/u)
    .map((part, i) => (i % 2 ? `<code>${esc(part)}</code>` : marks(part)))
    .join("");
}

function cells(line) {
  return line
    .replace(/^\s*\|/u, "")
    .replace(/\|\s*$/u, "")
    .split("|")
    .map((c) => c.trim());
}

/** Pure: a small, safe markdown renderer for the report (headings, paragraphs, lists, tables). */
export function renderReport(md) {
  const lines = String(md ?? "").replace(/\r\n?/gu, "\n").split("\n");
  const out = [];
  let i = 0;
  const toc = [];
  let headings = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    if ((m = /^(#{1,4}) (.*)$/u.exec(line))) {
      const level = Math.min(m[1].length + 1, 5);
      const id = `rep-h${++headings}`;
      if (level <= 3) toc.push({ id, text: m[2], level });
      out.push(`<h${level} id="${id}" class="report__h">${inline(m[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*\|/u.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/u.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|/u.test(lines[i])) body.push(cells(lines[i++]));
      out.push(`<div class="table-wrap"><table class="report__t"><thead><tr>${head.map((h) => `<th scope="col">${inline(h)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*[-*] /u.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*] /u.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*] /u, ""));
      out.push(`<ul class="report__l">${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4} |\s*\||\s*[-*] )/u.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  // Sections: the second heading level when the report has a single title above them.
  const lvl = toc.filter((t) => t.level === 2).length > 1 ? 2 : 3;
  const secs = toc.filter((t) => t.level === lvl);
  const nav = secs.length > 1 ? `<nav class="report__toc" aria-label="Sections"><ul>${secs.map((t) => `<li><a href="#${t.id}" data-jump-to="${t.id}">${inline(t.text)}</a></li>`).join("")}</ul></nav>` : "";
  return `${nav}<div class="report">${out.join("")}</div>`;
}

export function mount(el, ctx) {
  el.innerHTML = `<h1 class="view-h">Evaluation</h1><section class="panel"><div data-report><p class="muted" role="status">Loading the evaluation report…</p></div></section>`;
  const box = el.querySelector("[data-report]");
  api("/api/eval/report").then((r) => {
    if (!r.ok) {
      box.innerHTML = renderError(r);
      return;
    }
    box.innerHTML = `<p class="small muted">From <code>${esc(r.data.file)}</code>, updated ${esc(fmtTime(r.data.updated_at))}. Every figure carries its label (measured or estimated) in the report itself.</p>${renderReport(r.data.markdown)}`;
    ctx.setTitle("Evaluation");
  });
  // In-page section links scroll without changing the hash route.
  const onClick = (e) => {
    const a = e.target instanceof Element ? e.target.closest("[data-jump-to]") : null;
    if (!a) return;
    e.preventDefault();
    const t = document.getElementById(a.getAttribute("data-jump-to"));
    t?.scrollIntoView({ block: "start" });
  };
  el.addEventListener("click", onClick);
  return () => el.removeEventListener("click", onClick);
}
