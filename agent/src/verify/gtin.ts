/** GS1 GTIN check digit, normalisation and UPC extraction from recall notice text. */

export function checkDigitOk(digits: string): boolean {
  if (!/^\d{8}$|^\d{11,14}$/u.test(digits)) return false;
  // 11-digit codes are validated only after padding in normalise; bare 11 is not a GS1 length.
  if (digits.length === 11) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

export type NormaliseOk = { ok: true; gtin13: string; transform: string };
export type NormaliseErr = { ok: false; reason: "check_digit" | "gtin14_case_level" | "length" };
export type NormaliseResult = NormaliseOk | NormaliseErr;

function stripSeparators(raw: string): { digits: string; grouped: boolean } {
  const trimmed = raw.trim();
  if (/^\d+$/u.test(trimmed)) return { digits: trimmed, grouped: false };
  // Single spaces or hyphens between digit groups only.
  if (/^\d+(?:[ -]\d+)+$/u.test(trimmed)) {
    return { digits: trimmed.replace(/[ -]/gu, ""), grouped: true };
  }
  const compact = trimmed.replace(/[ -]/gu, "");
  if (/^\d+$/u.test(compact) && /[ -]/u.test(trimmed)) {
    return { digits: compact, grouped: true };
  }
  return { digits: compact, grouped: /[ -]/u.test(trimmed) };
}

function withGrouped(transform: string, grouped: boolean): string {
  return grouped ? `${transform}_grouped` : transform;
}

export function normalise(raw: string): NormaliseResult {
  const { digits, grouped } = stripSeparators(raw);
  if (!/^\d+$/u.test(digits)) return { ok: false, reason: "length" };

  if (digits.length === 13) {
    if (!checkDigitOk(digits)) return { ok: false, reason: "check_digit" };
    return { ok: true, gtin13: digits, transform: withGrouped("ean13_exact", grouped) };
  }
  if (digits.length === 12) {
    const gtin13 = `0${digits}`;
    if (!checkDigitOk(digits) || !checkDigitOk(gtin13)) return { ok: false, reason: "check_digit" };
    return { ok: true, gtin13, transform: withGrouped("upc12_pad13", grouped) };
  }
  if (digits.length === 14) {
    if (digits[0] !== "0") return { ok: false, reason: "gtin14_case_level" };
    if (!checkDigitOk(digits)) return { ok: false, reason: "check_digit" };
    const gtin13 = digits.slice(1);
    if (!checkDigitOk(gtin13)) return { ok: false, reason: "check_digit" };
    return { ok: true, gtin13, transform: withGrouped("gtin14_strip0", grouped) };
  }
  if (digits.length === 8) {
    const gtin13 = digits.padStart(13, "0");
    if (!checkDigitOk(digits) || !checkDigitOk(gtin13)) return { ok: false, reason: "check_digit" };
    return { ok: true, gtin13, transform: withGrouped("ean8_pad13", grouped) };
  }
  if (digits.length === 11) {
    const gtin13 = `00${digits}`;
    // Missing check digit is never computed: the padded 13 must already pass.
    if (!checkDigitOk(gtin13)) return { ok: false, reason: "check_digit" };
    return { ok: true, gtin13, transform: withGrouped("upc11_pad13", grouped) };
  }
  return { ok: false, reason: "length" };
}

export interface AcceptedUpc {
  raw_code: string;
  gtin13: string;
  transform: string;
  start: number;
  end: number;
  keyword: string | null;
}

export interface RejectedUpc {
  raw_code: string;
  reason: string;
  start: number;
  end: number;
}

const KEYWORD_RE = /\b(UPC|GTIN|EAN|barcode)\b/giu;

function keywordBefore(text: string, index: number): string | null {
  const window = text.slice(Math.max(0, index - 40), index);
  let last: string | null = null;
  for (const m of window.matchAll(KEYWORD_RE)) {
    last = m[1]!.toUpperCase() === "BARCODE" ? "barcode" : m[1]!.toUpperCase();
  }
  return last;
}

interface DigitRun {
  raw: string;
  start: number;
  end: number;
  digits: string;
  groups: { raw: string; start: number; end: number; digits: string }[];
}

function findDigitRuns(text: string): DigitRun[] {
  const runs: DigitRun[] = [];
  // A run is one or more digit groups separated only by single spaces or hyphens.
  const re = /\d+(?:[ -]\d+)*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (raw.length > 40) continue;
    const start = m.index;
    const end = start + raw.length;
    const groups = [...raw.matchAll(/\d+/gu)].map((g) => ({
      raw: g[0],
      start: start + (g.index ?? 0),
      end: start + (g.index ?? 0) + g[0].length,
      digits: g[0],
    }));
    runs.push({
      raw,
      start,
      end,
      digits: groups.map((g) => g.digits).join(""),
      groups,
    });
  }
  return runs;
}

/** The run without its first digit group. */
function restOf(text: string, run: DigitRun): DigitRun {
  const groups = run.groups.slice(1);
  const start = groups[0]!.start;
  const end = run.end;
  return { raw: text.slice(start, end), start, end, digits: groups.map((g) => g.digits).join(""), groups };
}

function tryAccept(
  raw: string,
  start: number,
  end: number,
  keyword: string | null,
  seen: Set<string>,
  accepted: AcceptedUpc[],
  rejected: RejectedUpc[],
): void {
  const result = normalise(raw);
  if (!result.ok) {
    rejected.push({ raw_code: raw.slice(0, 40), reason: result.reason, start, end });
    return;
  }
  if (seen.has(result.gtin13)) return;
  seen.add(result.gtin13);
  accepted.push({
    raw_code: raw.slice(0, 40),
    gtin13: result.gtin13,
    transform: result.transform,
    start,
    end,
    keyword,
  });
}

function lengthAllows(len: number, hasKeyword: boolean): boolean {
  if (len === 12 || len === 13 || len === 14) return true;
  if ((len === 8 || len === 11) && hasKeyword) return true;
  return false;
}

type Piece = { raw: string; start: number; end: number; digits: string };

function pieceOf(text: string, groups: DigitRun["groups"], i: number, j: number): Piece {
  const start = groups[i]!.start;
  const end = groups[j]!.end;
  return { raw: text.slice(start, end), start, end, digits: groups.slice(i, j + 1).map((g) => g.digits).join("") };
}

/** Split a run at group boundaries into consecutive codes that all pass normalise, or null. */
function partitionAllValid(text: string, run: DigitRun, hasKeyword: boolean): Piece[] | null {
  const n = run.groups.length;
  const best: (Piece[] | null)[] = new Array(n + 1).fill(null);
  best[n] = [];
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i; j < n; j++) {
      const p = pieceOf(text, run.groups, i, j);
      if (p.digits.length > 14) break;
      if (!lengthAllows(p.digits.length, hasKeyword) || !normalise(p.raw).ok) continue;
      const rest = best[j + 1];
      if (rest) {
        best[i] = [p, ...rest];
        break;
      }
    }
  }
  return best[0] && best[0].length >= 2 ? best[0] : null;
}

/** An ungrouped 12-14 digit code followed only by a short number ("UPC 816929000119 12 oz").
 * Grouped prefixes are not tried: cutting digits off a grouped case code could pass a check digit by chance. */
function validPrefix(text: string, run: DigitRun): Piece | null {
  const first = run.groups[0]!;
  const tail = run.digits.length - first.digits.length;
  if (first.digits.length < 12 || first.digits.length > 14 || tail > 3) return null;
  const p = pieceOf(text, run.groups, 0, 0);
  return normalise(p.raw).ok ? p : null;
}

export function extractUpcs(noticeText: string): { accepted: AcceptedUpc[]; rejected: RejectedUpc[] } {
  const text = noticeText.normalize("NFC");
  const accepted: AcceptedUpc[] = [];
  const rejected: RejectedUpc[] = [];
  const seen = new Set<string>();

  for (let run of findDigitRuns(text)) {
    // "H-1328-2026", "F-0636-2025", "L-240915": a single letter and hyphen in front means an id, not a barcode.
    // A word and hyphen ("UPC-816929000119", "EAN-13 4056489125846") does not.
    if (/(?:^|[^A-Za-z])[A-Za-z]-$/u.test(text.slice(Math.max(0, run.start - 3), run.start))) continue;
    // "10-MAY-2025": the year of a written date.
    if (/(?:^|[^A-Za-z])(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-$/iu.test(text.slice(Math.max(0, run.start - 5), run.start))) {
      continue;
    }
    let keyword = keywordBefore(text, run.start);
    // "EAN-13 4056489125846", "GTIN-14 00816929000119", "EAN8 12345670": the format's digit count is
    // not part of the code. It is dropped only when the run is not a valid code as written.
    const format = /(?:^|[^A-Za-z])(UPC|GTIN|EAN)-?$/iu.exec(text.slice(Math.max(0, run.start - 6), run.start));
    if (format && run.groups.length >= 2 && ["8", "12", "13", "14"].includes(run.groups[0]!.digits)) {
      if (!(lengthAllows(run.digits.length, true) && normalise(run.raw).ok)) {
        run = restOf(text, run);
        keyword = format[1]!.toUpperCase();
      }
    }
    const hasKeyword = keyword !== null;
    const len = run.digits.length;

    // Eight digits after "UPC" are a zero-suppressed UPC-E, which is not expanded here;
    // padding it like an EAN-8 would give a wrong GTIN.
    if (len === 8 && keyword === "UPC") {
      rejected.push({ raw_code: run.raw.slice(0, 40), reason: "upc_e_not_expanded", start: run.start, end: run.end });
      continue;
    }

    if (lengthAllows(len, hasKeyword) && normalise(run.raw).ok) {
      tryAccept(run.raw, run.start, run.end, keyword, seen, accepted, rejected);
      continue;
    }

    if (run.groups.length >= 2) {
      const pieces = partitionAllValid(text, run, hasKeyword);
      if (pieces) {
        for (const p of pieces) tryAccept(p.raw, p.start, p.end, keyword, seen, accepted, rejected);
        continue;
      }
      const prefix = validPrefix(text, run);
      if (prefix) {
        tryAccept(prefix.raw, prefix.start, prefix.end, keyword, seen, accepted, rejected);
        continue;
      }
    }

    if (lengthAllows(len, hasKeyword)) {
      tryAccept(run.raw, run.start, run.end, keyword, seen, accepted, rejected);
    } else if (len >= 8) {
      rejected.push({ raw_code: run.raw.slice(0, 40), reason: "length", start: run.start, end: run.end });
    }
  }

  return { accepted, rejected };
}
