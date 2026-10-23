import { describe, expect, it } from "vitest";
import { lexiconScan } from "../src/verify/lexicon.ts";
import { SYNTHETIC_INGREDIENTS } from "./fixtures/synthetic-ingredients.ts";

describe("synthetic ingredient fixtures", () => {
  it("are all marked synthetic and cover the five label languages", () => {
    expect(SYNTHETIC_INGREDIENTS.every((f) => f.synthetic === true)).toBe(true);
    expect(new Set(SYNTHETIC_INGREDIENTS.map((f) => f.lang))).toEqual(new Set(["en", "de", "fr", "es", "it"]));
  });

  it("scan with hit offsets that point at the matched text", () => {
    for (const f of SYNTHETIC_INGREDIENTS) {
      for (const h of lexiconScan(f.text)) {
        expect(f.text.normalize("NFC").slice(h.start, h.end)).toBe(h.term);
      }
    }
  });
});
