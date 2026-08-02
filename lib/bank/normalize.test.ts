import { describe, it, expect } from "vitest";
import { normalizeText } from "@/lib/bank/normalize";

describe("normalizeText", () => {
  it("converts Persian-Indic digits to English digits", () => {
    expect(normalizeText("۱۲۳۴۵۶۷۸۹۰")).toBe("1234567890");
  });

  it("converts Arabic-Indic digits to English digits", () => {
    expect(normalizeText("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });

  it("converts mixed Persian and Arabic-Indic digits in the same string", () => {
    expect(normalizeText("۵۰ و ٣٠")).toBe("50 و 30");
  });

  it("normalizes Arabic Yeh (ي) to Persian Yeh (ی)", () => {
    expect(normalizeText("ايران")).toBe("ایران");
  });

  it("normalizes Arabic Kaf (ك) to Persian Kaf (ک)", () => {
    expect(normalizeText("بانك")).toBe("بانک");
  });

  it("normalizes mixed Arabic and Persian characters in the same string", () => {
    expect(normalizeText("بانك ملي ايران")).toBe("بانک ملی ایران");
  });

  it("removes left-to-right marks (U+200E)", () => {
    expect(normalizeText("مبلغ‎ ۱۰۰")).toBe("مبلغ 100");
  });

  it("removes right-to-left marks (U+200F)", () => {
    expect(normalizeText("مبلغ‏ ۱۰۰")).toBe("مبلغ 100");
  });

  it("preserves zero-width non-joiners (نیم‌فاصله) as semantically meaningful", () => {
    expect(normalizeText("می‌کنم")).toBe("می‌کنم");
  });

  it("preserves ZWNJ in a real word while stripping LRM/RLM/ZWSP/BOM around it", () => {
    const zwnj = "‌";
    const lrm = "‎";
    const rlm = "‏";
    const zwsp = "​";
    const bom = "﻿";
    const input = `${bom}${lrm}می${zwnj}خواستم${rlm}${zwsp}`;
    expect(normalizeText(input)).toBe(`می${zwnj}خواستم`);
  });

  it("removes byte order marks", () => {
    expect(normalizeText("﻿سلام")).toBe("سلام");
  });

  it("collapses multiple consecutive spaces into one", () => {
    expect(normalizeText("سلام     دنیا")).toBe("سلام دنیا");
  });

  it("treats line breaks as spaces", () => {
    expect(normalizeText("سلام\nدنیا")).toBe("سلام دنیا");
  });

  it("treats Windows-style line breaks as a single space", () => {
    expect(normalizeText("سلام\r\nدنیا")).toBe("سلام دنیا");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeText("   سلام دنیا   ")).toBe("سلام دنیا");
  });

  it("handles a combination of digits, characters, marks, and spacing together", () => {
    expect(
      normalizeText("  بانك‏  ملي\n\nايران   ۱۲۳٤٥  ")
    ).toBe("بانک ملی ایران 12345");
  });
});
