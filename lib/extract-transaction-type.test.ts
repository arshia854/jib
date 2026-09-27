import { describe, it, expect } from "vitest";
import { extractIncomeSignal } from "@/lib/extract-transaction-type";

describe("extractIncomeSignal", () => {
  describe("income keywords", () => {
    it("detects حقوق (salary)", () => {
      expect(extractIncomeSignal("حقوق ۳۰ میلیون")).toBe(true);
    });

    it("detects درآمد (income)", () => {
      expect(extractIncomeSignal("درآمد فریلنسری ۵ میلیون")).toBe(true);
    });

    it("detects دریافتی (amount received)", () => {
      expect(extractIncomeSignal("دریافتی این ماه ۱۲ میلیون")).toBe(true);
    });

    it("matches a keyword mid-sentence and next to punctuation", () => {
      expect(extractIncomeSignal("امروز حقوق، ۳۰ میلیون")).toBe(true);
    });

    it("matches a keyword written with Arabic yeh/kaf variants normalized", () => {
      // "دريافتي" (Arabic ي) must normalize to the Persian form.
      expect(extractIncomeSignal("دريافتي ۲ میلیون")).toBe(true);
    });
  });

  describe("no income signal", () => {
    it("returns false for a plain expense text", () => {
      expect(extractIncomeSignal("۵۰ هزار تومن قهوه خوردم")).toBe(false);
    });

    it("returns false for an empty string", () => {
      expect(extractIncomeSignal("")).toBe(false);
    });

    // "واریز" alone is directionally ambiguous in free-form text - "۵۰۰ هزار
    // به علی واریز کردم" is the user PAYING someone (an expense) - so it must
    // not count as an income signal by itself. See the comment above
    // INCOME_KEYWORDS in lib/extract-transaction-type.ts. (It's only safe in
    // lib/bank/extract-bank-type.ts because a real bank SMS guarantees the
    // direction.)
    it("returns false for واریز alone, with no other income keyword", () => {
      expect(extractIncomeSignal("۵۰۰ هزار به علی واریز کردم")).toBe(false);
      expect(extractIncomeSignal("واریز ۲ میلیون")).toBe(false);
      expect(extractIncomeSignal("واریزی ۲ میلیون")).toBe(false);
    });

    it("still returns true when واریزی is accompanied by a real income keyword", () => {
      expect(extractIncomeSignal("واریزی حقوق ۳۰ میلیون")).toBe(true);
    });

    // Whole-token matching: "حقوقی" (legal) merely contains "حقوق". A
    // lawyer's fee is an expense; a substring match would flip it to income.
    it("does not match a keyword that is only a substring of an unrelated word", () => {
      expect(extractIncomeSignal("وکیل حقوقی ۵ میلیون")).toBe(false);
    });
  });
});
