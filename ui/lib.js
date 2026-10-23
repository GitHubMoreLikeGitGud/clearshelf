// Shared helpers for the officer UI. Nothing here touches document, window or EventSource
// at import time, so the view modules (and their render tests) can be imported in Node.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

/** Every piece of data that reaches HTML goes through this (text and attribute values). */
export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"'`]/gu, (c) => ESC[c]);
}
export const esc = escapeHtml;

/** A URL is shown as a link only when it is plain http(s). */
export function safeUrl(u) {
  return typeof u === "string" && /^https?:\/\/[^\s"'<>]+$/iu.test(u) ? u : null;
}

export const STATUSES = ["CLEAR", "CLEAR_WITH_STATEMENT", "HOLD", "BLOCK"];

const STATUS_CLASS = { CLEAR: "clear", CLEAR_WITH_STATEMENT: "cws", HOLD: "hold", BLOCK: "block", RELEASE: "clear" };

/**
 * Decision chip: colour plus a glyph plus the word, so status never rests on colour alone.
 * `proposed` marks a proposal that waits for a signature: dashed outline, no tick, and the
 * word "proposed", so it never reads as an applied decision.
 */
export function statusChip(status, opts = {}) {
  const s = String(status ?? "");
  const cls = STATUS_CLASS[s] ?? "neutral";
  const text = s.replaceAll("_", " ");
  if (opts.proposed && s) {
    return `<span class="chip chip--${cls} chip--proposed${opts.large ? " chip--lg" : ""}" data-status="${esc(s)}" data-proposed="yes">${esc(text)}<span class="chip__prop">proposed</span></span>`;
  }
  return `<span class="chip chip--${cls}${opts.large ? " chip--lg" : ""}" data-status="${esc(s)}"><span class="chip__glyph" aria-hidden="true"></span>${esc(text)}</span>`;
}

// ---------- policy rules in plain English ----------

/** The policy's rule codes (agent/src/policy/decide.ts) with a plain name and what each does. */
export const RULES = {
  R0: { name: "Investigation incomplete", what: "the product row or its ingredient reading is missing or incomplete, so nothing can be cleared yet" },
  R1: { name: "Recall of this barcode", what: "an FDA recall names this exact barcode: an open one blocks or holds, a closed one within 24 months holds" },
  R2: { name: "Name-only recall match", what: "a recall names the brand or product but not the barcode: a person reviews it; a close name match holds" },
  R3: { name: "Data-quality rule failed", what: "a Zetaris data-quality rule found an invalid record for this barcode: hold" },
  R4: { name: "Unresolved contradiction", what: "sources or checks disagree and nobody has settled it yet: hold" },
  R5: { name: "Allergens verified", what: "allergens verified and nothing above: clear with an allergen statement, after the officer signs" },
  R6: { name: "No allergens", what: "no allergens and the label fully read: clear, after the officer signs" },
  ESC: { name: "Escalated", what: "an approved memory rule or the brief made the decision stricter" },
};

export function ruleTitle(rule) {
  const r = RULES[rule];
  return r ? `${rule}: ${r.name}. ${r.what[0].toUpperCase()}${r.what.slice(1)}.` : String(rule ?? "");
}

/** A rule badge: the code, with its plain name as a tooltip and for screen readers; `named` shows the name too. */
export function ruleBadge(rule, opts = {}) {
  const r = RULES[rule];
  const name = r ? r.name : "";
  return `<span class="rule" title="${esc(ruleTitle(rule))}"><span aria-hidden="true">${esc(rule)}</span><span class="sr-only">${esc(rule)}${name ? `, ${esc(name)}` : ""}</span></span>${opts.named && name ? `<span class="rule__name">${esc(name)}</span>` : ""}`;
}

/** The legend for a set of rule codes: each badge with its plain name. */
export function ruleLegend(rules, opts = {}) {
  const list = [...new Set((rules ?? []).filter(Boolean))].filter((r) => RULES[r]);
  if (!list.length) return "";
  return `<p class="rule-legend${opts.cls ? ` ${esc(opts.cls)}` : ""}">${opts.label ? `<span class="rule-legend__k">${esc(opts.label)}</span>` : ""}${list.map((r) => `<span class="rule-legend__i">${ruleBadge(r)} ${esc(RULES[r].name)}</span>`).join("")}</p>`;
}

const SOURCE_CLASS = {
  regulator: "the FDA recall",
  off_labels: "the Open Food Facts labels",
  off_tag: "the Open Food Facts allergen tags",
  label_claim: "the label's claim",
  label_verified: "the label text (verified)",
  officer: "the officer",
};
const GROUP_WORD = { gluten_cereal: "gluten", tree_nut: "tree nuts", peanut: "peanuts", soy: "soya", crustacean: "crustaceans", mollusc: "molluscs", sulphite: "sulphites" };

/** A plain word for an allergen group code ("tree_nut" -> "tree nuts"). */
export function groupWord(g) {
  const k = String(g ?? "");
  return GROUP_WORD[k] ?? k.replaceAll("_", " ");
}

/** A plain name for an H-MEM source class ("regulator" -> "the FDA recall"). */
export function sourceClassWord(c) {
  return SOURCE_CLASS[c] ?? `${String(c ?? "a source").replaceAll("_", " ")}`;
}

const DQ_PLAIN = { has_ingredients: "No ingredient list", english_label: "Label not in English" };
const NOTICE_RE = /\b([FH]-\d{4}-\d{4})\b/u;

/**
 * One plain sentence for a policy firing's reason, readable in a second. The exact reason
 * stays next to it on screen; this never replaces it.
 */
export function plainReason(rule, reason) {
  const r = String(reason ?? "");
  let m;
  const notice = (NOTICE_RE.exec(r) ?? [])[1] ?? "";
  const status = (/\((?:Class [IV]+, )?(Ongoing|Terminated|Completed|Pending)/u.exec(r) ?? [])[1] ?? "";
  if (rule === "R1") {
    if (/active US recall/u.test(r)) return `Open US recall of this barcode (FDA ${notice}): blocked`;
    if (/UK units not covered/u.test(r)) return `US recall of this barcode (FDA ${notice}, ${status || "open"}); UK units are not covered, so it is held for you`;
    if (/active recall of this GTIN/u.test(r)) return `Open recall of this barcode (FDA ${notice}) that may reach the UK`;
    if (/lot codes not matched/u.test(r)) return `Recalled by the FDA (${notice}, ${status ? status.toLowerCase() : "closed"}) within 24 months; lot codes not checked`;
    if (/outside the/u.test(r)) return `Old FDA recall (${notice}), outside the 24-month window`;
    return `FDA recall of this barcode (${notice}): held for review`;
  }
  if (rule === "R2") return "A recall closely matches this product's name (not its barcode): confirm or dismiss it";
  if (rule === "R3") {
    if ((m = /^DQ (\w+) on (\w+): (\d+)/u.exec(r))) {
      if (DQ_PLAIN[m[1]]) return DQ_PLAIN[m[1]];
      if (m[1] === "market_code") return `Allergen code on ${m[2].replaceAll("_", " ")} is not valid for this market`;
      return `Data-quality rule ${m[1]} failed on ${m[2].replaceAll("_", " ")}`;
    }
    if (/incomplete/u.test(r)) return "The data-quality check did not finish";
    return "A data-quality rule failed";
  }
  if (rule === "R4") {
    const kind = (/^unresolved contradiction \((\w+)\)/u.exec(r) ?? [])[1] ?? "";
    const body = r.replace(/^unresolved contradiction \(\w+\): /u, "");
    if (kind === "memory_conflict" && (m = /queued for the officer: (\w+) (contains|may contain|may_contain) \((\w+), mem-\d+\) vs (?:free from|free_from) \((\w+), mem-\d+\)/u.exec(body))) {
      const a = m[3] === "regulator" ? "FDA" : sourceClassWord(m[3]).replace(/^the /u, "");
      const b = m[4] === "label_claim" || m[4] === "off_labels" ? "the label" : sourceClassWord(m[4]);
      return `${a[0].toUpperCase()}${a.slice(1)} says ${groupWord(m[1])}; ${b} says ${groupWord(m[1])}-free: you decide`;
    }
    if (kind === "claim_not_supported" && (m = /claim "([^"]+)" is not supported: (.+)$/u.exec(body))) return `Label claims "${m[1]}", but ${m[2]} is recorded against it`;
    if (kind === "model_vs_verifier" && (m = /reads "([^"]+)" as (\w+)(?: \(([^)]+)\))? .*?the model missed it/u.exec(body))) return `The model missed "${m[1]}" (${m[3] ?? groupWord(m[2])}); the verifier found it`;
    if (kind === "model_vs_verifier") return `The model and the verifier disagree: ${body}`;
    if (kind === "rule_conflict" && /coconut/iu.test(body)) return `${notice ? `FDA ${notice}` : "The FDA notice"} calls coconut a tree nut; UK and current US rules do not`;
    if (kind === "rule_conflict") return `Two labelling rules disagree: ${body.split(":")[0]}`;
    if (kind === "recall_vs_label" && (m = /reports undeclared (\w+)/u.exec(body))) return `FDA reports undeclared ${groupWord(m[1])}; the label text shows no ${groupWord(m[1])}`;
    if (kind === "declared_vs_extraction" && (m = /tags declare (\w+)/u.exec(body))) return `Open Food Facts tags say ${groupWord(m[1])}; the label text shows none`;
    if (kind === "untrusted_text") return "The label text contains instruction-like text: correct the source, then re-clear";
    return body.length > 90 ? `${body.slice(0, 90)}…` : body;
  }
  if (rule === "R0") {
    if ((m = /(\d+) unparsed fragment/u.exec(r))) return `${m[1]} piece${m[1] === "1" ? "" : "s"} of the ingredient text could not be read`;
    if (/no ingredient text/u.test(r)) return "No ingredient text to read";
    if (/no clearance_usl\.product row/u.test(r)) return "Product not found in Zetaris";
    if (/extraction gave no valid output/u.test(r)) return "The model could not read the ingredients";
    return "The investigation did not finish";
  }
  if (rule === "R5") return "Verified allergens and nothing against it: clear with an allergen statement, only on the officer's signature";
  if (rule === "R6") return "No allergens and nothing against it: clear, only on the officer's signature";
  if (rule === "ESC") return `Made stricter: ${r.replace(/^escalated by /u, "")}`;
  return r;
}

const RULE_ORDER = ["R1", "R2", "R3", "R4", "R0", "ESC", "R5", "R6"];

/** Firings grouped by rule, in rule order, keeping their order within a rule. */
export function groupFirings(firings) {
  const by = new Map();
  for (const f of Array.isArray(firings) ? firings : []) {
    if (!by.has(f.rule)) by.set(f.rule, []);
    by.get(f.rule).push(f);
  }
  const rank = (r) => (RULE_ORDER.includes(r) ? RULE_ORDER.indexOf(r) : RULE_ORDER.length);
  return [...by.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

/**
 * The decision in one sentence, e.g. "Held: recalled by the FDA (H-1328-2026, terminated)
 * within 24 months; no ingredient list, label not in English and 2 contradictions for you to settle."
 */
export function decisionSentence(status, firings) {
  const groups = groupFirings((firings ?? []).filter((f) => f.effect !== "INFO" && f.effect !== "REVIEW"));
  const verb = { HOLD: "Held", BLOCK: "Blocked", CLEAR: "Clear", CLEAR_WITH_STATEMENT: "Clear with a statement" }[status] ?? String(status ?? "");
  const bits = [];
  for (const [rule, fs] of groups) {
    if (rule === "R4") bits.push(`${fs.length} contradiction${fs.length === 1 ? "" : "s"} for you to settle`);
    else if (rule === "R3" || rule === "R0") bits.push([...new Set(fs.map((f) => plainReason(rule, f.reason)))].map((x) => x[0].toLowerCase() + x.slice(1)).join(", "));
    else if (rule === "R5") bits.push("allergens verified and nothing against it");
    else if (rule === "R6") bits.push("no allergens and nothing against it");
    else {
      const p = plainReason(rule, fs[0].reason).replace(/: (blocked|held for review)$/u, "").replace(/, so it is held for you$/u, "");
      bits.push(/^(FDA|US|UK)/u.test(p) ? p : p[0].toLowerCase() + p.slice(1));
    }
  }
  if (!bits.length) return `${verb}.`;
  const list = bits.length > 1 ? `${bits.slice(0, -1).join("; ")} and ${bits[bits.length - 1]}` : bits[0];
  return `${verb}: ${list}.`;
}

/** An id that may wrap only at its hyphens (decision, contract and run ids). */
export function idHtml(id) {
  return esc(id).replaceAll("-", "-<wbr>");
}

// A US street address inside FDA free text: the rule the gateway's templates apply in SQL.
// Evidence stored before the templates removed addresses is shown with the same rule applied.
const ADDRESS_SRC = "[0-9][0-9]* [A-Z0-9 .-]+? (STREET|ST|AVENUE|AVE|ROAD|RD|BOULEVARD|BLVD|DRIVE|DR|LANE|LN|WAY|PARKWAY|PKWY|HIGHWAY|HWY|COURT|CT|PLACE|PL|CIRCLE|CIR|PLAZA|TERRACE|TRAIL|PIKE)[.]?(,? (SUITE|STE|UNIT|BLDG|BUILDING|#) ?[A-Z0-9-]+)?,? *[A-Z][A-Z .-]+, *[A-Z][A-Z] *[0-9][0-9][0-9][0-9][0-9](-[0-9][0-9][0-9][0-9])?";

/** Text with any US street address replaced by "[address removed]". */
export function noAddress(text) {
  return typeof text === "string" ? text.replace(new RegExp(ADDRESS_SRC, "giu"), "[address removed]") : text;
}

export function hasAddress(text) {
  return typeof text === "string" && new RegExp(ADDRESS_SRC, "iu").test(text);
}

const VERDICT_CLASS = { SUPPORTED: "clear", PARTLY_SUPPORTED: "hold", NOT_SUPPORTED: "block", UNTESTED: "neutral" };
export function verdictChip(verdict) {
  const v = String(verdict ?? "");
  return `<span class="chip chip--${VERDICT_CLASS[v] ?? "neutral"}" data-verdict="${esc(v)}">${esc(v.replaceAll("_", " "))}</span>`;
}

/** A plain neutral tag, e.g. "pending signature", "not cleared". */
export function tag(text, kind = "neutral") {
  return `<span class="tag tag--${esc(kind)}">${esc(text)}</span>`;
}

const RUN_OF_EV = /^ev-([rw]\d{8}T\d{6}[0-9a-f]{4})-(\d{2,4})$/u;

/** The run an evidence id belongs to (ids embed it), else the given fallback. */
export function runOfEvidence(id, fallback = null) {
  const m = RUN_OF_EV.exec(String(id ?? ""));
  return m ? m[1] : fallback;
}

/** Short label for a chip: the record number within its run. */
export function evShort(id) {
  const m = RUN_OF_EV.exec(String(id ?? ""));
  return m ? m[2] : String(id ?? "");
}

// What each evidence id is, once its record has been fetched: chips then say what they cite.
const EV_KIND_WORD = { zetaris_sql: "SQL", dq: "SQL", model_extraction: "Model", verifier: "Check", memory: "Memory", world_model: "World", policy: "Policy" };
const EV_KIND_LONG = {
  zetaris_sql: "Lightning SQL through Zetaris",
  dq: "Zetaris data-quality SQL",
  model_extraction: "local model call (Nemotron)",
  verifier: "deterministic verifier",
  memory: "H-MEM memory",
  world_model: "World Model",
  policy: "decision policy",
};
const knownEvidence = new Map();

/** Remembers what each record is (kind, template, claim) so its chips can say so. */
export function rememberEvidence(records) {
  for (const r of Array.isArray(records) ? records : []) {
    if (r && typeof r.id === "string") knownEvidence.set(r.id, { kind: r.kind ?? null, template_id: r.template_id ?? null, claim: typeof r.claim === "string" ? r.claim : "" });
  }
}

export function evidenceInfo(id) {
  return knownEvidence.get(id) ?? null;
}

/** The kind a chip shows: the record's own kind when known, else the caller's hint (a tool name's kind). */
function kindOf(id, hint) {
  return knownEvidence.get(id)?.kind ?? hint ?? null;
}

/** The record kind a loop tool writes ("zetaris.product" -> zetaris_sql). */
export function kindOfTool(tool) {
  const t = String(tool ?? "");
  if (t === "zetaris.dq_gate") return "dq";
  if (t.startsWith("zetaris.")) return "zetaris_sql";
  if (t.startsWith("extract.")) return "model_extraction";
  if (t.startsWith("memory.")) return "memory";
  if (t.startsWith("world.")) return "world_model";
  if (t.startsWith("policy.")) return "policy";
  return null;
}

function chip(id, run, hint) {
  const info = knownEvidence.get(id);
  const kind = kindOf(id, hint);
  const word = EV_KIND_WORD[kind] ?? "Record";
  const n = evShort(id);
  const what = `${word === "Record" ? "Evidence" : `${word} record`} ${n}${info?.template_id ? ` (${info.template_id})` : ""}`;
  const title = `${what}${kind ? `, ${EV_KIND_LONG[kind] ?? kind}` : ""}${info?.claim ? `: ${info.claim.length > 220 ? `${info.claim.slice(0, 220)}…` : info.claim}` : ""}`;
  return `<button type="button" class="ev" data-ev="${esc(id)}" data-run="${esc(runOfEvidence(id, run) ?? "")}" data-kind="${esc(kind ?? "unknown")}" title="${esc(title)}" aria-label="${esc(title)}"><span class="ev__k" aria-hidden="true">${esc(word)}</span><span class="ev__n" aria-hidden="true">${esc(n)}</span></button>`;
}

/**
 * Evidence chips for one claim. Each chip is a button that names what it cites (SQL, Model,
 * Memory, Policy…); clicking any opens the drawer with every id of the group, starting at the
 * one clicked. `max` folds a long list into "+N more". A claim without ids renders a visible gap.
 */
export function evidenceChips(runId, ids, opts = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && x))];
  if (!list.length) return `<span class="evs evs--none">${opts.noneText !== undefined ? esc(opts.noneText) : "no evidence id"}</span>`;
  const run = runId ?? runOfEvidence(list[0]);
  const max = typeof opts.max === "number" && opts.max > 0 && list.length > opts.max + 1 ? opts.max : list.length;
  let chips = list.slice(0, max).map((id) => chip(id, run, opts.kind)).join("");
  if (max < list.length) chips += `<button type="button" class="ev ev--more" data-ev="${esc(list[max])}" data-run="${esc(runOfEvidence(list[max], run) ?? "")}" aria-label="${esc(`${list.length - max} more evidence records`)}">+${esc(list.length - max)} more</button>`;
  return `<span class="evs" data-run="${esc(run ?? "")}" data-ids="${esc(list.join(" "))}">${chips}</span>`;
}

/** One button for many records: "17 records: 9 SQL, 3 Model, 1 Policy…", opening them all. */
export function evidenceSummary(runId, ids, opts = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && x))];
  if (!list.length) return `<span class="evs evs--none">no evidence id</span>`;
  const counts = new Map();
  for (const id of list) {
    const w = EV_KIND_WORD[kindOf(id, opts.kind)] ?? "other";
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n} ${w}`);
  const run = runId ?? runOfEvidence(list[0]);
  const label = `${list.length} evidence record${list.length === 1 ? "" : "s"}${parts.length ? `: ${parts.join(", ")}` : ""}`;
  return `<span class="evs" data-run="${esc(run ?? "")}" data-ids="${esc(list.join(" "))}"><button type="button" class="ev ev--all" data-ev="${esc(list[0])}" data-run="${esc(runOfEvidence(list[0], run) ?? "")}" aria-label="${esc(`Open ${label}`)}">${esc(label)}</button></span>`;
}

/** The replay banner, with the server's text exactly as sent. Empty when there is no banner. */
export function replayBanner(text) {
  if (typeof text !== "string" || !text) return "";
  return `<div class="replay"><strong class="replay__text">${esc(text)}</strong><span class="replay__note">Replayed data: decisions see only notices reported on or before the replay date. Nothing here arrived live.</span></div>`;
}

/** Escaped text with evidence ids inside it turned into chips (for server-written trace lines). */
export function linkEvidenceIds(text) {
  const parts = String(text ?? "").split(/(ev-[rw]\d{8}T\d{6}[0-9a-f]{4}-\d{2,4})/u);
  return parts.map((p, i) => (i % 2 ? evidenceChips(null, [p]) : esc(p))).join("");
}

/** Every evidence id named inside a piece of text. */
export function evidenceIdsIn(text) {
  return [...String(text ?? "").matchAll(/ev-[rw]\d{8}T\d{6}[0-9a-f]{4}-\d{2,4}/gu)].map((m) => m[0]);
}

/** A fact line without its trailing "[ev-…, ev-…]" list (the chips beside it carry those ids). */
export function stripEvidenceRefs(text) {
  return String(text ?? "").replace(/\s*\[ev-[rw]\d{8}T\d{6}[0-9a-f]{4}-\d{2,4}(?:,\s*ev-[rw]\d{8}T\d{6}[0-9a-f]{4}-\d{2,4})*\]/gu, "");
}

// ---------- formatting ----------

/** "+0800" -> "+08:00" so Date can parse the gateway's timestamps everywhere. */
export function parseTime(t) {
  if (t === null || t === undefined || t === "") return null;
  if (typeof t === "number") return new Date(t);
  const s = String(t).replace(/([+-]\d{2})(\d{2})$/u, "$1:$2");
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n) => String(n).padStart(2, "0");

/** Local date and time, e.g. "23 Oct 16:29". */
export function fmtTime(t, withSeconds = false) {
  const d = parseTime(t);
  if (!d) return "";
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  const zone = zoneName(d);
  return `${d.getDate()} ${mon} ${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? `:${pad(d.getSeconds())}` : ""}${zone ? ` ${zone}` : ""}`;
}

/** The clock time only ("16:29:35"), for lists whose heading names the time zone. */
export function fmtClock(t) {
  const d = parseTime(t);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : "";
}

/** The browser's time zone at that moment, as a short name ("BST", "GMT+8"): every time shown says its zone. */
export function zoneName(d = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

export function fmtNum(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "";
  return Number(n).toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined) return "";
  const n = Number(ms);
  return n >= 1000 ? `${fmtNum(n / 1000, 1)} s` : `${fmtNum(n)} ms`;
}

/** Minutes between two timestamps as plain words. */
export function fmtGap(fromT, toT) {
  const a = parseTime(fromT);
  const b = parseTime(toT);
  if (!a || !b) return null;
  const min = Math.round((b.getTime() - a.getTime()) / 60000);
  if (min < 0) return null;
  if (min < 120) return `${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

export function plural(n, one, many = `${one}s`) {
  return `${fmtNum(n)} ${n === 1 ? one : many}`;
}

/** Visible field, or a red "missing" for a required one that is absent. */
export function fieldOrMissing(value, render = (v) => esc(v)) {
  if (value === undefined || value === null || value === "") return `<span class="missing">missing</span>`;
  return render(value);
}

export function errorText(res) {
  const d = res?.data;
  const msg = d && typeof d === "object" && typeof d.error === "string" ? d.error : `request failed (${res?.status ?? "network"})`;
  const code = d && typeof d === "object" && typeof d.code === "string" ? d.code : null;
  const kind = res?.status === 403 ? "Refused" : res?.status === 409 ? "Conflict" : "Error";
  return `${kind} ${res?.status ?? ""}${code ? ` ${code}` : ""}: ${msg}`;
}

export function renderError(res) {
  return `<p class="msg msg--error" role="alert">${esc(errorText(res))}</p>`;
}

// ---------- network ----------

/** JSON in and out. Resolves to { ok, status, data } so callers can show 403 and 409 bodies. */
export async function api(path, { method = "GET", body } = {}) {
  const init = { method, headers: { accept: "application/json" } };
  if (body !== undefined) {
    init.method = method === "GET" ? "POST" : method;
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(path, init);
    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text.slice(0, 300), code: "not_json" };
      }
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: `the agent server did not answer (${e?.message ?? e})`, code: "network" } };
  }
}

// ---------- server-sent events: one EventSource per page ----------

let source = null;
const handlers = new Map();
const connListeners = new Set();
let connState = "connecting";

function dispatch(type, ev) {
  let data = {};
  try {
    data = JSON.parse(ev.data);
  } catch {
    data = {};
  }
  for (const fn of handlers.get(type) ?? []) {
    try {
      fn(data, type, ev.lastEventId);
    } catch (e) {
      console.error(`handler for ${type} failed`, e);
    }
  }
  for (const fn of handlers.get("*") ?? []) {
    try {
      fn(data, type, ev.lastEventId);
    } catch (e) {
      console.error("handler for * failed", e);
    }
  }
}

const KNOWN_EVENTS = [
  "job.queued", "job.started", "job.done", "job.failed",
  "clear.started", "clear.log", "clear.done",
  "loop.chunk_start", "loop.planner", "loop.tool", "loop.chunk_end",
  "decision.written", "approval.queued", "approval.resolved", "approval.superseded",
  "contract.signed", "contract.refused",
  "memory.recorded", "memory.officer_reason", "memory.conflict_resolved", "memory.dream_approved", "memory.dream_rejected", "memory.dreamed",
  "world.recorded", "world.merge_resolved", "world.fsa_ingested",
  "officer.reason",
  "watch.state", "watch.sweep_started", "watch.notice", "watch.exact_match", "watch.name_match", "watch.clear_started", "watch.action",
  "watch.approval_queued", "watch.approval_superseded", "watch.recheck", "watch.world", "watch.feeds_refresh", "watch.sweep_done",
];

function setConn(s) {
  connState = s;
  for (const fn of connListeners) fn(s);
}

function ensureSource() {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource("/api/events");
  for (const t of KNOWN_EVENTS) source.addEventListener(t, (ev) => dispatch(t, ev));
  source.addEventListener("open", () => setConn("live"));
  source.addEventListener("error", () => setConn(source && source.readyState === 2 ? "closed" : "reconnecting"));
}

/** Subscribe to an SSE event type ("*" for every known type). Returns the unsubscribe function. */
export function on(type, fn) {
  ensureSource();
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type)?.delete(fn);
}

export function onConnection(fn) {
  ensureSource();
  connListeners.add(fn);
  fn(connState);
  return () => connListeners.delete(fn);
}

// ---------- intake stages (docs/api.md tool-to-stage map) ----------

export const STAGES = ["registering in Zetaris", "fetching", "reading", "verifying", "deciding"];

const STAGE_OF_TOOL = {
  "registrar.register_off": 0,
  "zetaris.product": 1,
  "zetaris.declared": 1,
  "zetaris.recalls_by_gtin": 1,
  "zetaris.recalls_by_name": 1,
  "zetaris.market_list": 1,
  "world.lookup": 1,
  "extract.ingredients": 2,
  "extract.notice": 2,
  "zetaris.dq_gate": 3,
  "memory.recall": 3,
  "policy.propose": 4,
};

/** Stage index for a tool name, or null for a tool outside the map. */
export function stageOfTool(tool) {
  return Object.hasOwn(STAGE_OF_TOOL, tool) ? STAGE_OF_TOOL[tool] : null;
}

export const ZETARIS_HOME = "http://localhost:3000/";
export const OFFICER = "officer";
