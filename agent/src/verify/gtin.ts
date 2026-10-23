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

export function extractUpcs(noticeText: string): { accepted: AcceptedUpc[]; rejected: RejectedUpc[] } {
  const text = noticeText.normalize("NFC");
  const accepted: AcceptedUpc[] = [];
  const rejected: RejectedUpc[] = [];
  const seen = new Set<string>();

  for (const run of findDigitRuns(text)) {
    const keyword = keywordBefore(text, run.start);
    const hasKeyword = keyword !== null;
    const len = run.digits.length;

    if (lengthAllows(len, hasKeyword)) {
      tryAccept(run.raw, run.start, run.end, keyword, seen, accepted, rejected);
      continue;
    }

    // Split at group boundaries into consecutive codes only if every piece validates.
    if (run.groups.length >= 2) {
      const pieces: { raw: string; start: number; end: number; digits: string }[] = [];
      let buf = run.groups[0]!;
      for (let i = 1; i < run.groups.length; i++) {
        const g = run.groups[i]!;
        const combined = buf.digits + g.digits;
        if (lengthAllows(combined.length, hasKeyword) || lengthAllows(buf.digits.length, hasKeyword)) {
          // Prefer completing a valid-length piece ending at previous group.
          if (lengthAllows(buf.digits.length, hasKeyword)) {
            pieces.push(buf);
            buf = g;
            continue;
          }
        }
        const nextCombined = buf.digits + g.digits;
        buf = {
          raw: text.slice(buf.start, g.end),
          start: buf.start,
          end: g.end,
          digits: nextCombined,
        };
      }
      pieces.push(buf);

      if (
        pieces.length >= 2 &&
        pieces.every((p) => {
          const n = normalise(p.raw);
          return n.ok || (lengthAllows(p.digits.length, hasKeyword) && !n.ok);
        }) &&
        pieces.every((p) => lengthAllows(p.digits.length, hasKeyword))
      ) {
        for (const p of pieces) {
          tryAccept(p.raw, p.start, p.end, keyword, seen, accepted, rejected);
        }
        continue;
      }
    }

    // Odd length that is not a candidate: ignore short noise (dates fragments, LOT) unless
    // it looked like a barcode run with a keyword or a long digit string.
    if (len >= 8) {
      rejected.push({ raw_code: run.raw.slice(0, 40), reason: "length", start: run.start, end: run.end });
    }
  }

  return { accepted, rejected };
}
