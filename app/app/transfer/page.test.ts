import { describe, expect, it } from "vitest";
import { MAX_TRANSACTION_AMOUNT } from "@/lib/limits";
import { parseTransferPrefill } from "./page";

const accounts = [{ id: 1 }, { id: 2 }, { id: 7 }];

describe("parseTransferPrefill", () => {
  it("passes through valid from/to/amount/note", () => {
    expect(parseTransferPrefill({ from: "1", to: "7", amount: "250000", note: "hello" }, accounts)).toEqual({
      from: 1,
      to: 7,
      amount: 250000,
      note: "hello",
    });
  });

  it("returns all-undefined when no params were given", () => {
    expect(parseTransferPrefill({}, accounts)).toEqual({
      from: undefined,
      to: undefined,
      amount: undefined,
      note: undefined,
    });
  });

  it("ignores ids that don't parse to a number or aren't one of the user's own accounts", () => {
    expect(parseTransferPrefill({ from: "abc", to: "999" }, accounts)).toMatchObject({ from: undefined, to: undefined });
    expect(parseTransferPrefill({ from: "", to: "1.5" }, accounts)).toMatchObject({ from: undefined, to: undefined });
    expect(parseTransferPrefill({ from: "0", to: "-1" }, accounts)).toMatchObject({ from: undefined, to: undefined });
  });

  it("validates each param independently", () => {
    expect(parseTransferPrefill({ from: "2", to: "999", amount: "abc" }, accounts)).toMatchObject({
      from: 2,
      to: undefined,
      amount: undefined,
    });
  });

  it("accepts amounts up to and including MAX_TRANSACTION_AMOUNT, and rejects zero/negative/non-finite/over-max", () => {
    expect(parseTransferPrefill({ amount: String(MAX_TRANSACTION_AMOUNT) }, accounts).amount).toBe(MAX_TRANSACTION_AMOUNT);
    expect(parseTransferPrefill({ amount: String(MAX_TRANSACTION_AMOUNT + 1) }, accounts).amount).toBeUndefined();
    expect(parseTransferPrefill({ amount: "0" }, accounts).amount).toBeUndefined();
    expect(parseTransferPrefill({ amount: "-5" }, accounts).amount).toBeUndefined();
    expect(parseTransferPrefill({ amount: "Infinity" }, accounts).amount).toBeUndefined();
    expect(parseTransferPrefill({ amount: "NaN" }, accounts).amount).toBeUndefined();
    expect(parseTransferPrefill({ amount: "" }, accounts).amount).toBeUndefined();
  });

  it("passes note through as-is, but drops a non-string (repeated ?note= arrives as an array at runtime)", () => {
    expect(parseTransferPrefill({ note: "پیاده‌سازی استراتژی ۵۰/۳۰/۲۰" }, accounts).note).toBe("پیاده‌سازی استراتژی ۵۰/۳۰/۲۰");
    expect(parseTransferPrefill({ note: ["a", "b"] as unknown as string }, accounts).note).toBeUndefined();
  });
});
