import { describe, it, expect } from "vitest";
import { extractDate } from "@/lib/extract-date";

const NOW = new Date("2026-07-30T12:00:00Z");

describe("extractDate", () => {
  it("defaults to today when no date keyword is mentioned", () => {
    expect(extractDate("ناهار ۵۰ تومن", NOW)).toBe("2026-07-30");
  });

  it("resolves an explicit امروز keyword to today", () => {
    expect(extractDate("امروز ناهار ۵۰ تومن", NOW)).toBe("2026-07-30");
  });

  it("resolves دیروز to yesterday", () => {
    expect(extractDate("دیروز اسنپ ۸۰ تومن", NOW)).toBe("2026-07-29");
  });

  it("resolves پریروز to the day before yesterday", () => {
    expect(extractDate("پریروز ۲۰۰ تومن خرید", NOW)).toBe("2026-07-28");
  });

  it("defaults to today for an unrecognized date phrase (no fuzzy parsing)", () => {
    expect(extractDate("سه شنبه پیش ۵۰ تومن", NOW)).toBe("2026-07-30");
  });

  it("bails to null on contradictory date signals", () => {
    expect(extractDate("دیروز یا پریروز یادم نیست", NOW)).toBeNull();
  });

  it("defaults to today for an empty string", () => {
    expect(extractDate("", NOW)).toBe("2026-07-30");
  });
});
