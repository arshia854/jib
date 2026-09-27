import { describe, it, expect } from "vitest";
import { periodToGregorianRange, getPreviousPeriod } from "@/lib/reports/period-range";

describe("periodToGregorianRange", () => {
  describe("week", () => {
    it("week 1 starts exactly on Farvardin 1 when Farvardin 1 is itself a Saturday", () => {
      // 1405-01-01 falls on a Saturday, so week 1 has no backward dip.
      const { start, end } = periodToGregorianRange("1405-W01", "week");
      expect(start).toEqual(new Date(2026, 2, 21));
      expect(end).toEqual(new Date(2026, 2, 28));
    });

    it("week 1 dips into the previous Jalaali year when Farvardin 1 isn't a Saturday", () => {
      // 1404-01-01 falls on a Friday, so week 1 starts 6 days earlier, on 1403-12-25.
      const { start, end } = periodToGregorianRange("1404-W01", "week");
      expect(start).toEqual(new Date(2025, 2, 15));
      expect(end).toEqual(new Date(2025, 2, 22));
    });

    it("rejects a malformed key", () => {
      expect(() => periodToGregorianRange("1404-20", "week")).toThrow(/هفته نامعتبر/);
    });

    it("rejects a week number outside 01-53", () => {
      expect(() => periodToGregorianRange("1404-W54", "week")).toThrow(/هفته نامعتبر/);
      expect(() => periodToGregorianRange("1404-W00", "week")).toThrow(/هفته نامعتبر/);
    });
  });

  describe("year", () => {
    it("returns the [start, end) bounds of a Jalaali year", () => {
      const { start, end } = periodToGregorianRange("1403", "year");
      expect(start).toEqual(new Date(2024, 2, 20));
      expect(end).toEqual(new Date(2025, 2, 21)); // 1404-01-01
    });

    it("rejects a malformed key", () => {
      expect(() => periodToGregorianRange("14030", "year")).toThrow(/سال نامعتبر/);
    });

    it("rejects a year outside jalaali-js's supported range", () => {
      expect(() => periodToGregorianRange("9999", "year")).toThrow(/سال نامعتبر/);
    });
  });

  describe("month (delegates to the existing, unchanged jalaaliMonthToGregorianRange)", () => {
    it("returns the same bounds the pre-generalization logic did", () => {
      const { start, end } = periodToGregorianRange("1403-01", "month");
      expect(start).toEqual(new Date(2024, 2, 20));
      expect(end).toEqual(new Date(2024, 3, 20));
    });
  });
});

describe("getPreviousPeriod", () => {
  it("week: last week, crossing a Jalaali year boundary (week 1 of 1404 -> week 52 of 1403)", () => {
    expect(getPreviousPeriod("1404-W01", "week")).toBe("1403-W52");

    // and the two ranges are contiguous, with no gap or overlap at the boundary
    const previousRange = periodToGregorianRange("1403-W52", "week");
    const currentRange = periodToGregorianRange("1404-W01", "week");
    expect(previousRange.end).toEqual(currentRange.start);
  });

  it("month: matches the old inline logic in app/app/reports/page.tsx at a year boundary", () => {
    expect(getPreviousPeriod("1403-01", "month")).toBe("1402-12");
  });

  it("year: last year", () => {
    expect(getPreviousPeriod("1404", "year")).toBe("1403");
  });
});
