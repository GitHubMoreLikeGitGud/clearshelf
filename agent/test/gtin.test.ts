import { describe, expect, it } from "vitest";
import { checkDigitOk, extractUpcs, normalise } from "../src/verify/gtin.ts";

describe("checkDigitOk", () => {
  it("accepts known GS1 check digits", () => {
    // 81692900011 → weights from right *3,*1,... sum 71 → check 9
    expect(checkDigitOk("816929000119")).toBe(true);
    // same as EAN-13 with leading 0
    expect(checkDigitOk("0816929000119")).toBe(true);
    // 405648912584 → sum 104 → check 6
    expect(checkDigitOk("4056489125846")).toBe(true);
    // GTIN-8: 1234567 → sum 60 → check 0
    expect(checkDigitOk("12345670")).toBe(true);
  });

  it("rejects wrong check digits and odd lengths", () => {
    expect(checkDigitOk("4056489125840")).toBe(false);
    expect(checkDigitOk("123")).toBe(false);
  });
});

describe("normalise", () => {
  it("pads a 12-digit UPC-A", () => {
    // check digit 9 as above
    expect(normalise("816929000119")).toEqual({
      ok: true,
      gtin13: "0816929000119",
      transform: "upc12_pad13",
    });
  });

  it("keeps a 13-digit EAN exact", () => {
    // check digit 6 as above
    expect(normalise("4056489125846")).toEqual({
      ok: true,
      gtin13: "4056489125846",
      transform: "ean13_exact",
    });
  });

  it("strips a GTIN-14 with indicator 0", () => {
    // 0 + 0816929000119; check digit of the 14-digit form must still pass GS1
    // 00816929000119: body 0081692900011 → same check 9 as the 13
    expect(normalise("00816929000119")).toEqual({
      ok: true,
      gtin13: "0816929000119",
      transform: "gtin14_strip0",
    });
  });

  it("rejects a GTIN-14 with non-zero indicator", () => {
    // indicator 1 + 0816929000119 → 10816929000119 (check digit recomputed below)
    // body 1081692900011: from right 1*3+1+0*3+0+0*3+9*1+2*3+9*1+6*3+1*1+8*3+0*1+1*3
    // = 3+1+0+0+0+9+6+9+18+1+24+0+3 = 74 → check 6 → 10816929000116
    expect(normalise("10816929000116")).toEqual({ ok: false, reason: "gtin14_case_level" });
  });

  it("pads GTIN-8 and UPC-11 when digits alone are passed", () => {
    // check 0 as above
    expect(normalise("12345670")).toEqual({
      ok: true,
      gtin13: "0000012345670",
      transform: "ean8_pad13",
    });
    // UPC-A 012345678905 (check 5); drop leading 0 → 12345678905; pad 00 → 0012345678905
    expect(normalise("12345678905")).toEqual({
      ok: true,
      gtin13: "0012345678905",
      transform: "upc11_pad13",
    });
  });

  it("rejects bad check digit and length", () => {
    expect(normalise("4056489125840")).toEqual({ ok: false, reason: "check_digit" });
    expect(normalise("12345")).toEqual({ ok: false, reason: "length" });
  });

  it("records grouped separators on the transform", () => {
    expect(normalise("8 16929 00011 9")).toEqual({
      ok: true,
      gtin13: "0816929000119",
      transform: "upc12_pad13_grouped",
    });
    expect(normalise("8-16929-00011-9")).toEqual({
      ok: true,
      gtin13: "0816929000119",
      transform: "upc12_pad13_grouped",
    });
  });
});

describe("extractUpcs", () => {
  it("extracts grouped UPC forms with keyword", () => {
    const a = extractUpcs("UPC 8 16929 00011 9");
    expect(a.accepted).toEqual([
      {
        raw_code: "8 16929 00011 9",
        gtin13: "0816929000119",
        transform: "upc12_pad13_grouped",
        start: expect.any(Number),
        end: expect.any(Number),
        keyword: "UPC",
      },
    ]);
    const b = extractUpcs("UPC: 8-16929-00011-9");
    expect(b.accepted[0]?.gtin13).toBe("0816929000119");
    expect(b.accepted[0]?.transform).toBe("upc12_pad13_grouped");
  });

  it("extracts EAN-8 only with a keyword; bare 8 digits are ignored", () => {
    // check 0
    const withKw = extractUpcs("EAN 12345670");
    expect(withKw.accepted).toEqual([
      expect.objectContaining({
        gtin13: "0000012345670",
        transform: "ean8_pad13",
        keyword: "EAN",
      }),
    ]);
    expect(extractUpcs("lot code 12345670").accepted).toEqual([]);
  });

  it("pads an 11-digit code after UPC code:", () => {
    // check 5 as above
    const r = extractUpcs("UPC code: 12345678905");
    expect(r.accepted).toEqual([
      expect.objectContaining({
        gtin13: "0012345678905",
        transform: "upc11_pad13",
      }),
    ]);
  });

  it("rejects a wrong check digit without dropping it", () => {
    const r = extractUpcs("GTIN 4056489125840");
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual([
      expect.objectContaining({ raw_code: "4056489125840", reason: "check_digit" }),
    ]);
  });

  it("does not extract dates, LOT numbers or recall numbers", () => {
    expect(extractUpcs("LOT 240915").accepted).toEqual([]);
    expect(extractUpcs("packed 2026-09-15").accepted).toEqual([]);
    expect(extractUpcs("recall F-0636-2025").accepted).toEqual([]);
  });

  it("extracts two codes separated by comma or and", () => {
    // 816929000119 check 9; 4056489125846 check 6
    const a = extractUpcs("UPC 816929000119, 4056489125846");
    expect(a.accepted.map((x) => x.gtin13).sort()).toEqual(["0816929000119", "4056489125846"]);
    const b = extractUpcs("UPC 816929000119 and 4056489125846");
    expect(b.accepted.map((x) => x.gtin13).sort()).toEqual(["0816929000119", "4056489125846"]);
  });

  it("accepts the same GTIN-13 only once", () => {
    const r = extractUpcs("UPC 816929000119 and UPC 0816929000119");
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]?.gtin13).toBe("0816929000119");
  });
});

describe("extractUpcs review fixes", () => {
  it("keeps a code followed by a short number (pack size)", () => {
    // 816929000119: check 9 as above
    const r = extractUpcs("UPC 816929000119 12 oz");
    expect(r.accepted.map((x) => x.gtin13)).toEqual(["0816929000119"]);
  });

  it("splits two grouped codes written back to back", () => {
    // 8 16929 00011 9 (check 9) and 4 056489 125846 (check 6)
    const r = extractUpcs("UPC 8 16929 00011 9 4 056489 125846");
    expect(r.accepted.map((x) => x.gtin13)).toEqual(["0816929000119", "4056489125846"]);
  });

  it("rejects eight digits after UPC as an unexpanded UPC-E, never as an EAN-8", () => {
    // 0 004564 3 is UPC-E for UPC-A 000450000063; padding it as EAN-8 would give 0000000045643.
    const r = extractUpcs("UPC: 0 004564 3");
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual([expect.objectContaining({ reason: "upc_e_not_expanded" })]);
  });

  it("never reads a recall number near a UPC as a barcode", () => {
    const r = extractUpcs("UPC 816929000119 (recall F-0636-2025, H-1328-2026)");
    expect(r.accepted.map((x) => x.gtin13)).toEqual(["0816929000119"]);
    expect(r.rejected).toEqual([]);
  });

  it("keeps a GTIN-14 case code rejected rather than cutting a GTIN-13 out of it", () => {
    // 10816929000116: indicator 1, check 6 as above
    const r = extractUpcs("Case GTIN 1 0816929 000116");
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual([expect.objectContaining({ reason: "gtin14_case_level" })]);
  });
});

describe("extractUpcs second review fixes", () => {
  it("reads a code written after a keyword and hyphen", () => {
    // 816929000119: body 81692900011, from right 1*3+1+0*3+0+0*3+9+2*3+9+6*3+1+8*3 = 71 -> check 9
    expect(extractUpcs("UPC-816929000119").accepted).toEqual([
      expect.objectContaining({ gtin13: "0816929000119", transform: "upc12_pad13", keyword: "UPC" }),
    ]);
    expect(extractUpcs("barcode-816929000119").accepted).toEqual([
      expect.objectContaining({ gtin13: "0816929000119", keyword: "barcode" }),
    ]);
  });

  it("drops the format's digit count after EAN-, GTIN- or UPC-", () => {
    // 4056489125846: body 405648912584, from right 4*3+8+5*3+2+1*3+9+8*3+4+6*3+5+0*3+4 = 104 -> check 6
    expect(extractUpcs("EAN-13 4056489125846").accepted).toEqual([
      expect.objectContaining({ raw_code: "4056489125846", gtin13: "4056489125846", transform: "ean13_exact", keyword: "EAN" }),
    ]);
    // 00816929000119: body 0081692900011 sums like 81692900011 (leading zeros add 0) = 71 -> check 9
    expect(extractUpcs("GTIN-14 00816929000119").accepted).toEqual([
      expect.objectContaining({ gtin13: "0816929000119", transform: "gtin14_strip0", keyword: "GTIN" }),
    ]);
    // 12345670: body 1234567, from right 7*3+6+5*3+4+3*3+2+1*3 = 60 -> check 0
    expect(extractUpcs("EAN-8 12345670").accepted).toEqual([
      expect.objectContaining({ gtin13: "0000012345670", transform: "ean8_pad13" }),
    ]);
    expect(extractUpcs("UPC-12 816929000119").accepted.map((x) => x.gtin13)).toEqual(["0816929000119"]);
    expect(extractUpcs("EAN13 4056489125846").accepted.map((x) => x.gtin13)).toEqual(["4056489125846"]);
  });

  it("keeps a leading group that is part of a valid code", () => {
    // 8 16929 00011 9 is 816929000119 (check 9 as above); the 8 is its number-system digit
    expect(extractUpcs("UPC-8 16929 00011 9").accepted).toEqual([
      expect.objectContaining({ gtin13: "0816929000119", transform: "upc12_pad13_grouped" }),
    ]);
  });

  it("still skips recall numbers and lot ids after a single letter and hyphen", () => {
    const r = extractUpcs("UPC-816929000119, recall F-0636-2025 and H-1328-2026, lot L-240915");
    expect(r.accepted.map((x) => x.gtin13)).toEqual(["0816929000119"]);
    expect(r.rejected).toEqual([]);
  });

  it("does not read the year of a written date as the start of a code", () => {
    const r = extractUpcs("UPC 816929000119 best by 10-MAY-2025 01-03-2025");
    expect(r.accepted.map((x) => x.gtin13)).toEqual(["0816929000119"]);
    expect(r.rejected).toEqual([]);
  });
});
