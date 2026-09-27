import { describe, it, expect } from "vitest";
import { hasStrongIncomeSignal } from "@/lib/extract-income-signal";

describe("hasStrongIncomeSignal", () => {
  it("detects حقوق (salary)", () => {
    expect(hasStrongIncomeSignal("حقوق این ماه ریخت")).toBe(true);
  });

  it("detects درآمد (income)", () => {
    expect(hasStrongIncomeSignal("درآمد فریلنسری این هفته")).toBe(true);
  });

  it("detects دستمزد (wage)", () => {
    expect(hasStrongIncomeSignal("دستمزد کارگری گرفتم")).toBe(true);
  });

  it("detects پورسانت (commission)", () => {
    expect(hasStrongIncomeSignal("پورسانت فروش این ماه")).toBe(true);
  });

  it("detects عیدی (Eid bonus)", () => {
    expect(hasStrongIncomeSignal("عیدی امسال رو گرفتم")).toBe(true);
  });

  it("detects پاداش (bonus)", () => {
    expect(hasStrongIncomeSignal("پاداش پروژه رو گرفتم")).toBe(true);
  });

  it("detects استرداد (refund)", () => {
    expect(hasStrongIncomeSignal("استرداد مالیات امسال")).toBe(true);
  });

  it("detects دریافتی (amount received, noun form)", () => {
    expect(hasStrongIncomeSignal("دریافتی این ماه بیشتر بود")).toBe(true);
  });

  it("detects واریزی (incoming deposit, noun form)", () => {
    expect(hasStrongIncomeSignal("واریزی حقوق رسید")).toBe(true);
  });

  it("does NOT match the bare, ambiguous verb form واریز کردم (I deposited/paid - usually an expense)", () => {
    expect(hasStrongIncomeSignal("۵۰۰ به علی واریز کردم")).toBe(false);
  });

  it("does NOT match an ordinary expense sentence with none of the keywords", () => {
    expect(hasStrongIncomeSignal("۵۰ تومن ناهار خوردم")).toBe(false);
  });

  it("does NOT match a keyword as a mere substring of an unrelated word", () => {
    // "دریافتی" must match as a whole token, not as a substring of some
    // longer unrelated word that happens to contain it.
    expect(hasStrongIncomeSignal("غیردریافتی‌محورترین")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(hasStrongIncomeSignal("")).toBe(false);
  });
});
