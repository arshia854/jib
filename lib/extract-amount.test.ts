import { describe, it, expect } from "vitest";
import { extractAmount } from "@/lib/extract-amount";

describe("extractAmount", () => {
  it("no longer exempts an explicit تومن-suffixed small number from the bare-number x1000 rule", () => {
    expect(extractAmount("۵۰ تومن")).toBe(50000);
  });

  it("applies the هزار scale word", () => {
    expect(extractAmount("۲۵۰ هزار تومن")).toBe(250000);
  });

  it("applies the میلیون scale word", () => {
    expect(extractAmount("۱۵ میلیون تومن")).toBe(15000000);
  });

  it("converts ریال to toman (÷10)", () => {
    expect(extractAmount("۵۰۰ ریال")).toBe(50);
  });

  it("resolves spelled-out numbers via normalizePersianNumberWords, same as the digit equivalent", () => {
    expect(extractAmount("پنجاه تومن")).toBe(extractAmount("۵۰ تومن"));
  });

  it("bails when multiple numbers appear", () => {
    expect(extractAmount("۲ تا ۵۰ تومنی")).toBeNull();
  });

  it("bails on a decimal with a unit attached (punctuation-stripped into two adjacent numbers, not a bare X.Y pair)", () => {
    expect(extractAmount("۱۲.۵ تومن")).toBeNull();
  });

  it("bails on zero", () => {
    expect(extractAmount("۰ تومن")).toBeNull();
  });

  // A literal minus sign can't reach the numeric-token check at all: "-"
  // is stripped by normalizeText's punctuation handling before tokens are
  // split, and NUMBER_TOKEN (/^\d+$/) never matches a sign character
  // anyway - so `value` is structurally always >= 0. There is no raw-text
  // input that produces a negative token; the <= 0 guard only ever
  // fires on zero in practice.
  it("has no reachable path to a negative parsed value", () => {
    expect(extractAmount("-۵۰ تومن")).toBe(50000);
  });

  it("bails on an empty string", () => {
    expect(extractAmount("")).toBeNull();
  });

  it("resolves a single number written with mixed Persian/Latin digits", () => {
    expect(extractAmount("۵0 تومن")).toBe(50000);
  });

  it("bails when Persian and Latin digits form two separate numbers", () => {
    expect(extractAmount("قیمت 20 و ۵۰ تومن")).toBeNull();
  });

  describe("bare numbers, with or without a plain تومان/تومن (magnitude-based x1000 rule)", () => {
    it("multiplies a bare 1-9999 number by 1000", () => {
      expect(extractAmount("۸۰")).toBe(80000);
    });

    it("multiplies a bare number even with unrelated surrounding words, as long as none is a recognized unit", () => {
      expect(extractAmount("ناهار ۸۰ خوردم")).toBe(80000);
    });

    it("multiplies a 4-digit number by 1000 too - inflation means these are still colloquial shorthand", () => {
      expect(extractAmount("۱۳۰۰ شام")).toBe(1_300_000);
    });

    it("leaves a bare number unchanged once it's 10,000 or more", () => {
      expect(extractAmount("۵۰۰۰۰")).toBe(50000);
    });

    it("does not re-inflate an explicit تومن-suffixed number once it's already 10,000 or more", () => {
      expect(extractAmount("۵۰۰۰۰ تومن")).toBe(50000);
    });

    it("boundary: 1 -> 1000", () => {
      expect(extractAmount("۱")).toBe(1000);
    });

    it("boundary: 9999 -> 9999000", () => {
      expect(extractAmount("۹۹۹۹")).toBe(9_999_000);
    });

    it("boundary: 10000 -> unchanged", () => {
      expect(extractAmount("۱۰۰۰۰")).toBe(10000);
    });

    it("real-world phrasing: '۵۰ تومن ناهار خوردم' means 50,000 toman", () => {
      expect(extractAmount("۵۰ تومن ناهار خوردم")).toBe(50000);
    });

    it("هزار stays unaffected by the raised ceiling - already resolves correctly on its own", () => {
      expect(extractAmount("۵۰ هزار تومن")).toBe(50000);
    });
  });

  describe('"X و Y" / "X.Y" combined pattern', () => {
    it('resolves "X و Y" as X million + Y thousand', () => {
      expect(extractAmount("۱ و ۱۰۰")).toBe(1_100_000);
    });

    it('resolves "X.Y" the same way', () => {
      expect(extractAmount("۱.۱۰۰")).toBe(1_100_000);
    });

    it("bails when either part of the pair is out of the 1-999 range", () => {
      expect(extractAmount("۱۵۰۰ و ۱۰۰")).toBeNull();
    });

    it("bails when the pair isn't the entire text", () => {
      expect(extractAmount("قیمت ۱ و ۱۰۰ تومن")).toBeNull();
    });
  });

  describe("spelled-out Persian number words (normalized to digits before the existing pipeline)", () => {
    it('resolves "سی تومن سیگار" (thirty toman cigarettes) via the bare-number x1000 rule', () => {
      expect(extractAmount("سی تومن سیگار")).toBe(30000);
    });

    it('resolves "دویست هزار تومن" via the هزار scale word rule', () => {
      expect(extractAmount("دویست هزار تومن")).toBe(200000);
    });

    it('resolves "صد و پنجاه" (150) via the bare-number x1000 rule', () => {
      expect(extractAmount("صد و پنجاه")).toBe(150000);
    });

    it("ordinary digit-based behavior is unaffected: bare digit magnitude rule", () => {
      expect(extractAmount("۸۰")).toBe(80000);
    });

    it("ordinary digit-based behavior is unaffected: still bails on multiple numbers", () => {
      expect(extractAmount("۲ تا ۵۰ تومنی")).toBeNull();
    });
  });

  describe("no space between a number and the following unit word", () => {
    it('resolves "۱۰۰هزارتومن" the same as "۱۰۰ هزار تومن"', () => {
      expect(extractAmount("۱۰۰هزارتومن")).toBe(extractAmount("۱۰۰ هزار تومن"));
    });

    it('resolves "۸۰تومن" the same as "۸۰ تومن"', () => {
      expect(extractAmount("۸۰تومن")).toBe(extractAmount("۸۰ تومن"));
    });

    it('resolves "ناهار۸۰خوردم" the same as "ناهار ۸۰ خوردم"', () => {
      expect(extractAmount("ناهار۸۰خوردم")).toBe(extractAmount("ناهار ۸۰ خوردم"));
    });

    it("still bails when two separate glued number+word groups appear in one string", () => {
      expect(extractAmount("۲تومن و ۵۰تومن")).toBeNull();
    });
  });
});
