import { describe, it, expect } from "vitest";
import { extractDate, tehranIsoDate } from "@/lib/extract-date";

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

  it("resolves هفته پیش to 7 days ago", () => {
    expect(extractDate("هفته پیش ۲۰۰ تومن آبمیوه خوردم", NOW)).toBe("2026-07-23");
  });

  it("does not treat bare هفته (without پیش) as a week-ago signal", () => {
    expect(extractDate("هفته دیگه میرم مسافرت", NOW)).toBe("2026-07-30");
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

  // 21:00 UTC on the 29th is already 00:30 on the 30th in Tehran.
  it("uses Tehran's calendar day, not UTC's, just after local midnight", () => {
    const justAfterTehranMidnight = new Date("2026-07-29T21:00:00Z");
    expect(extractDate("ناهار ۵۰ تومن", justAfterTehranMidnight)).toBe("2026-07-30");
    expect(extractDate("دیروز ناهار ۵۰ تومن", justAfterTehranMidnight)).toBe("2026-07-29");
  });
});

describe("tehranIsoDate", () => {
  it("rolls over at 00:00 Tehran time (20:30 UTC)", () => {
    expect(tehranIsoDate(new Date("2026-07-29T20:29:00Z"))).toBe("2026-07-29");
    expect(tehranIsoDate(new Date("2026-07-29T20:30:00Z"))).toBe("2026-07-30");
  });

  it("applies the day offset across month and year boundaries", () => {
    expect(tehranIsoDate(new Date("2026-08-01T12:00:00Z"), -1)).toBe("2026-07-31");
    expect(tehranIsoDate(new Date("2027-01-01T12:00:00Z"), -2)).toBe("2026-12-30");
  });
});
