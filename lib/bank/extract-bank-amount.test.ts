import { describe, it, expect } from "vitest";
import { extractBankAmount } from "@/lib/bank/extract-bank-amount";

describe("extractBankAmount", () => {
  it("parses a plain comma-formatted amount", () => {
    expect(extractBankAmount("5,960,000")).toBe(5960000);
  });

  it("parses another plain comma-formatted amount", () => {
    expect(extractBankAmount("9,278,200")).toBe(9278200);
  });

  it("assumes toman when no currency word is present", () => {
    expect(extractBankAmount("خرید 9,278,200 از فروشگاه")).toBe(9278200);
  });

  it("assumes toman when تومان (not ریال) is the stated currency", () => {
    expect(extractBankAmount("مبلغ 9,278,200 تومان از حساب شما کسر شد")).toBe(9278200);
  });

  it("converts rial to toman by dividing by 10", () => {
    expect(extractBankAmount("1,500,000 ریال")).toBe(150000);
  });

  it("converts another rial amount to toman", () => {
    expect(extractBankAmount("7,000,000 ریال")).toBe(700000);
  });

  it("ignores a trailing debit sign and returns the positive magnitude", () => {
    expect(extractBankAmount("519,500-")).toBe(519500);
  });

  it("handles a trailing debit sign combined with a rial suffix", () => {
    expect(extractBankAmount("519,500- ریال")).toBe(51950);
  });

  it("normalizes Persian digits before parsing", () => {
    expect(extractBankAmount("۵,۹۶۰,۰۰۰")).toBe(5960000);
  });

  it("normalizes Arabic-Indic digits before parsing", () => {
    expect(extractBankAmount("٥,٩٦٠,٠٠٠")).toBe(5960000);
  });

  it("parses plain English digits unchanged", () => {
    expect(extractBankAmount("7,000,000")).toBe(7000000);
  });

  it("picks the amount attached to a برداشت keyword over a مانده balance", () => {
    expect(extractBankAmount("برداشت:1,500,000 مانده:134,866")).toBe(1500000);
  });

  it("picks the amount attached to a واریز keyword over a موجودی balance", () => {
    expect(extractBankAmount("واریز:2,000,000 موجودی:5,000,000")).toBe(2000000);
  });

  it("returns null when two amounts appear with no keyword to disambiguate them", () => {
    expect(extractBankAmount("1,500,000 134,866")).toBeNull();
  });

  it("returns null when two competing transaction keywords each have their own amount", () => {
    expect(extractBankAmount("برداشت:1,500,000 خرید:200,000")).toBeNull();
  });

  it("returns null when no valid amount is found in the text", () => {
    expect(extractBankAmount("کد تایید شما 48213 است")).toBeNull();
  });

  it("returns null for text with no digits at all", () => {
    expect(extractBankAmount("پیام بدون هیچ عددی")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractBankAmount("")).toBeNull();
  });

  // Phase 7.1: real bank SMS can mix digit scripts within a single message
  // (e.g. a Persian-digit amount alongside a Latin-digit account/card
  // suffix) - buildFlatTextWithLines normalizes each line independently
  // before scanning, so this must resolve identically to an all-one-script
  // message rather than silently failing on the mismatch.
  describe("mixed digit scripts within one message", () => {
    it("extracts a Persian-digit amount when an unrelated Latin-digit number (account suffix) appears elsewhere", () => {
      expect(extractBankAmount("برداشت:۹,۲۷۸,۲۰۰ از حساب 543133176713291")).toBe(9278200);
    });

    it("extracts an Arabic-Indic-digit amount alongside a Persian-digit balance on another line", () => {
      expect(extractBankAmount("برداشت:٩,٢٧٨,٢٠٠\nمانده:۶۳,۰۹۶,۴۷۲")).toBe(9278200);
    });

    it("extracts a Latin-digit amount attached to a keyword whose label uses Persian digits nearby", () => {
      // The "۱۴۰۴" year-like digits are just narrative text, not a
      // comma-grouped run, so they can never be mistaken for an amount
      // candidate in the first place - included to confirm they're inert.
      expect(extractBankAmount("سال ۱۴۰۴ - برداشت:1,500,000 ریال")).toBe(150000);
    });
  });

  describe("same-line keyword matching (label text between keyword and number)", () => {
    it("picks the amount when a label sits between the keyword and the number, on one line", () => {
      expect(
        extractBankAmount("خرید پایانه فروش: 9,278,200 مانده: 63,096,472")
      ).toBe(9278200);
    });

    it("still excludes a same-line balance figure even though a transaction keyword precedes it too", () => {
      // مانده is directly attached to its own number, so it must stay
      // excluded regardless of برداشت appearing earlier on the line.
      expect(extractBankAmount("برداشت خرید کارت: 1,500,000 مانده: 134,866")).toBe(1500000);
    });

    it("parses Sepah's real SMS (خرید پایانه فروش label separated from the amount)", () => {
      const SEPAH_SMS = `بانک سپه
خريد پايانه فروش: 9,278,200
حساب :543133176713291
مانده:63,096,472`;
      expect(extractBankAmount(SEPAH_SMS)).toBe(9278200);
    });
  });

  describe("trailing transaction phrase (keyword-less narrative sentence)", () => {
    it("picks the amount preceding 'از حساب شما پرید' even with no leading keyword on its line", () => {
      expect(extractBankAmount("7,000,000 ریال از حساب شما پرید")).toBe(700000);
    });

    it("parses Blu's real SMS (narrative debit phrasing, no keyword adjacent to the amount)", () => {
      const BLU_SMS = `بلو
برداشت پول
علی عزیز، 7,000,000 ریال از حساب شما پرید.
موجودی:17,192,269`;
      // Blu states the amount in ریال ("7,000,000 ریال"); per the
      // RIAL_TO_TOMAN_DIVISOR rule exercised elsewhere in this file
      // (e.g. "converts rial to toman by dividing by 10" above), that
      // converts to 700,000 toman — not the raw 7,000,000 figure.
      expect(extractBankAmount(BLU_SMS)).toBe(700000);
    });

    it("does not let the trailing phrase pick up the nearest number when that number is balance-adjacent", () => {
      // 17,192,269 is the number nearest the trailing phrase, but it's
      // directly attached to موجودی, so it must stay excluded — and
      // 1,500,000 has no qualifying signal of its own, so the result is
      // an unresolvable null rather than a wrong guess.
      expect(
        extractBankAmount("1,500,000 موجودی: 17,192,269 از حساب شما پرید")
      ).toBeNull();
    });
  });
});
