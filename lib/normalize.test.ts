import { describe, it, expect } from "vitest";
import { normalizeText, toLatinDigits } from "@/lib/normalize";

describe("normalizeText", () => {
  it("normalizes Arabic Yeh/Kaf, strips punctuation, and collapses whitespace", () => {
    expect(normalizeText("كتاب، سلام!")).toBe("کتاب سلام");
  });
});

describe("toLatinDigits", () => {
  it("converts Persian-Indic digits to Latin", () => {
    expect(toLatinDigits("۱۲۳۴۵۶۷۸۹۰")).toBe("1234567890");
  });

  it("converts Arabic-Indic digits to Latin", () => {
    expect(toLatinDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });

  it("leaves Latin digits and other text untouched", () => {
    expect(toLatinDigits("abc123")).toBe("abc123");
  });

  it("handles Persian and Latin digits mixed in the same string", () => {
    expect(toLatinDigits("۵۰ and 20")).toBe("50 and 20");
  });
});
