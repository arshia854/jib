import { describe, it, expect } from "vitest";
import { toGregorian } from "jalaali-js";
import {
  currentJalaaliMonthLabel,
  formatCompactToman,
  formatJalaaliDate,
  formatJalaaliDateTime,
  formatJalaaliYear,
  formatToman,
  getJalaaliMonthRange,
  jalaaliMonthKeyToFullLabel,
  jalaaliWeekKeyToLabel,
  jalaaliYearKeyToLabel,
  periodKeyToShortLabel,
} from "@/lib/format";

describe("formatCompactToman", () => {
  it("renders zero as a plain Persian digit", () => {
    expect(formatCompactToman(0)).toBe("۰");
  });

  it("renders amounts under 1000 as plain digits", () => {
    expect(formatCompactToman(950)).toBe("۹۵۰");
  });

  it("uses هزار from 1000 up", () => {
    expect(formatCompactToman(850_000)).toBe("۸۵۰ هزار");
  });

  it("uses میلیون with at most one decimal", () => {
    expect(formatCompactToman(2_300_000)).toBe("۲٫۳ میلیون");
    expect(formatCompactToman(2_340_000)).toBe("۲٫۳ میلیون");
  });

  it("uses میلیارد", () => {
    expect(formatCompactToman(1_500_000_000)).toBe("۱٫۵ میلیارد");
  });

  it("prefixes negatives with a real minus sign (U+2212), not a hyphen", () => {
    expect(formatCompactToman(-1_200_000)).toBe("−۱٫۲ میلیون");
    expect(formatCompactToman(-850_000)).toBe("−۸۵۰ هزار");
    expect(formatCompactToman(-850_000)).not.toContain("-");
  });

  it("rolls rounding up into the next unit instead of showing ۱۰۰۰ هزار", () => {
    expect(formatCompactToman(999_999)).toBe("۱ میلیون");
    expect(formatCompactToman(-999_999)).toBe("−۱ میلیون");
    expect(formatCompactToman(999_999_999)).toBe("۱ میلیارد");
    expect(formatCompactToman(999.6)).toBe("۱ هزار");
  });

  it("does not sign a negative that rounds to zero", () => {
    expect(formatCompactToman(-0.4)).toBe("۰");
  });

  it("never appends the تومان suffix", () => {
    expect(formatCompactToman(5_000_000)).not.toContain("تومان");
  });
});

describe("periodKeyToShortLabel", () => {
  it("month: bare month name", () => {
    expect(periodKeyToShortLabel("1404-02", "month")).toBe("اردیبهشت");
  });

  it("week: week number only, Persian digits, no year", () => {
    expect(periodKeyToShortLabel("1404-W05", "week")).toBe("هفته ۵");
    expect(periodKeyToShortLabel("1404-W12", "week")).toBe("هفته ۱۲");
  });

  it("year: Persian-digit year", () => {
    expect(periodKeyToShortLabel("1404", "year")).toBe("۱۴۰۴");
  });

  it("falls back to the key when it doesn't match the granularity's format", () => {
    expect(periodKeyToShortLabel("garbage", "month")).toBe("garbage");
    expect(periodKeyToShortLabel("1404-05", "week")).toBe("1404-05");
    expect(periodKeyToShortLabel("abc", "year")).toBe("abc");
  });
});

describe("formatJalaaliYear", () => {
  it("uses Persian digits with no thousands separator", () => {
    expect(formatJalaaliYear(1404)).toBe("۱۴۰۴");
  });
});

describe("jalaaliYearKeyToLabel", () => {
  it("does not group the year", () => {
    expect(jalaaliYearKeyToLabel("1404")).toBe("۱۴۰۴");
  });

  it("falls back to the key when it isn't numeric", () => {
    expect(jalaaliYearKeyToLabel("abc")).toBe("abc");
  });
});

describe("Jalaali years are never grouped with a thousands separator", () => {
  // 12 Mordad 1404, 14:05 local time.
  const { gy, gm, gd } = toGregorian(1404, 5, 12);
  const date = new Date(gy, gm - 1, gd, 14, 5);

  it("formatJalaaliDate", () => {
    expect(formatJalaaliDate(date)).toBe("۱۲ مرداد ۱۴۰۴");
  });

  it("formatJalaaliDateTime", () => {
    expect(formatJalaaliDateTime(date)).toBe("۱۲ مرداد ۱۴۰۴ - ۱۴:۰۵");
  });

  it("jalaaliMonthKeyToFullLabel", () => {
    expect(jalaaliMonthKeyToFullLabel("1404-05")).toBe("مرداد ۱۴۰۴");
  });

  it("jalaaliWeekKeyToLabel", () => {
    expect(jalaaliWeekKeyToLabel("1404-W05")).toBe("هفته ۵ - ۱۴۰۴");
  });

  it("currentJalaaliMonthLabel", () => {
    expect(currentJalaaliMonthLabel(date)).toBe("مرداد ۱۴۰۴");
  });

  it("getJalaaliMonthRange label", () => {
    expect(getJalaaliMonthRange(date).label).toBe("مرداد ۱۴۰۴");
  });

  it("still groups money amounts (guard against over-fixing)", () => {
    expect(formatToman(1_404_000)).toContain("٬");
  });
});
