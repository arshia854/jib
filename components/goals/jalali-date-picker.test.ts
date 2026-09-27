import { describe, it, expect } from "vitest";
import { addJalaaliMonths, daysBetween } from "./jalali-date-picker";

describe("addJalaaliMonths", () => {
  it("adds months within the same year", () => {
    expect(addJalaaliMonths(1404, 3, 2)).toEqual({ jy: 1404, jm: 5 });
  });

  it("wraps forward into the next year", () => {
    expect(addJalaaliMonths(1404, 11, 3)).toEqual({ jy: 1405, jm: 2 });
  });

  it("wraps forward across more than one year boundary", () => {
    expect(addJalaaliMonths(1404, 10, 15)).toEqual({ jy: 1406, jm: 1 });
  });

  it("lands exactly on Esfand (month 12) without overflowing into the next year", () => {
    expect(addJalaaliMonths(1404, 6, 6)).toEqual({ jy: 1404, jm: 12 });
  });

  it("handles a negative offset (month navigation going backward)", () => {
    expect(addJalaaliMonths(1404, 1, -1)).toEqual({ jy: 1403, jm: 12 });
  });
});

describe("daysBetween", () => {
  it("returns 0 for the same day", () => {
    expect(daysBetween(new Date(2026, 5, 10), new Date(2026, 5, 10))).toBe(0);
  });

  it("returns a positive count for a future date", () => {
    expect(daysBetween(new Date(2026, 5, 10), new Date(2026, 5, 20))).toBe(10);
  });

  it("returns a negative count for a past date", () => {
    expect(daysBetween(new Date(2026, 5, 10), new Date(2026, 5, 1))).toBe(-9);
  });

  it("counts off calendar fields, not a raw 24h-multiple subtraction (DST-safe)", () => {
    // Time-of-day on either side shouldn't change the whole-day count.
    expect(daysBetween(new Date(2026, 5, 10, 23, 30), new Date(2026, 5, 11, 0, 30))).toBe(1);
  });
});
