import { describe, it, expect } from "vitest";
import { findMatchingAccount } from "@/lib/accounts";
import { getBankLabel } from "@/lib/bank/labels";

describe("findMatchingAccount", () => {
  it("returns the account when a bank-type account's name exactly matches the bank's label", () => {
    const label = getBankLabel("mellat");
    const accounts = [
      { id: 1, name: label, type: "bank" },
      { id: 2, name: "نقدی", type: "cash" },
    ];
    expect(findMatchingAccount(accounts, label)).toEqual({ id: 1, name: label, type: "bank" });
  });

  it("returns null when bank-type accounts exist but none match the label", () => {
    const accounts = [
      { id: 1, name: getBankLabel("mellat"), type: "bank" },
      { id: 2, name: getBankLabel("saman"), type: "bank" },
    ];
    expect(findMatchingAccount(accounts, getBankLabel("tejarat"))).toBeNull();
  });

  it("returns null when the matching name exists but on a non-bank account (checks type, not just name)", () => {
    const label = getBankLabel("mellat");
    const accounts = [{ id: 1, name: label, type: "cash" }];
    expect(findMatchingAccount(accounts, label)).toBeNull();
  });

  it("returns null for an empty accounts array", () => {
    expect(findMatchingAccount([], getBankLabel("mellat"))).toBeNull();
  });

  it("returns the matching bank account, not just the first bank-type account, when multiple exist", () => {
    const label = getBankLabel("saman");
    const accounts = [
      { id: 1, name: getBankLabel("mellat"), type: "bank" },
      { id: 2, name: label, type: "bank" },
      { id: 3, name: getBankLabel("tejarat"), type: "bank" },
    ];
    expect(findMatchingAccount(accounts, label)).toEqual({ id: 2, name: label, type: "bank" });
  });

  // findMatchingAccount takes a plain label string and has no concept of "unknown" -
  // that filtering happens one level up, in add-transaction-form.tsx's
  // getMissingBankAccountLabel, which bails out before ever calling this helper
  // when transaction.bank === "unknown". So there's no "unknown" case to test here;
  // if getBankLabel("unknown") were ever passed in directly, this helper would just
  // do an ordinary exact-match lookup against that string like any other label.
});
