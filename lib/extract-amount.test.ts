import { describe, it, expect } from "vitest";
import { extractAmount } from "@/lib/extract-amount";

describe("extractAmount", () => {
  it("resolves a bare number as toman (no unit)", () => {
    expect(extractAmount("۵۰ تومن")).toBe(50);
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

  it("bails on spelled-out numbers", () => {
    expect(extractAmount("پنجاه تومن")).toBeNull();
  });

  it("bails when multiple numbers appear", () => {
    expect(extractAmount("۲ تا ۵۰ تومنی")).toBeNull();
  });

  it("bails on decimals (punctuation-stripped into two adjacent numbers)", () => {
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
    expect(extractAmount("-۵۰ تومن")).toBe(50);
  });

  it("bails on an empty string", () => {
    expect(extractAmount("")).toBeNull();
  });

  it("resolves a single number written with mixed Persian/Latin digits", () => {
    expect(extractAmount("۵0 تومن")).toBe(50);
  });

  it("bails when Persian and Latin digits form two separate numbers", () => {
    expect(extractAmount("قیمت 20 و ۵۰ تومن")).toBeNull();
  });
});
