import { describe, it, expect } from "vitest";
import { groupTransferPairs, type GroupableTransaction } from "./group-transfer-pairs";

const cash = { id: 1, name: "نقدی" };
const savings = { id: 2, name: "پس‌انداز" };

function tx(overrides: Partial<GroupableTransaction> & { id: number }): GroupableTransaction {
  return {
    transferGroupId: null,
    type: "expense",
    amount: 100000,
    date: new Date("2026-09-01T00:00:00.000Z"),
    description: null,
    account: cash,
    ...overrides,
  };
}

describe("groupTransferPairs", () => {
  it("merges a matched expense/income pair sharing a transferGroupId into one transfer row", () => {
    const date = new Date("2026-09-05T00:00:00.000Z");
    const rows = groupTransferPairs([
      tx({
        id: 1,
        transferGroupId: "g1",
        type: "expense",
        amount: 500000,
        date,
        description: "انتقال بین حساب‌ها",
        account: cash,
      }),
      tx({
        id: 2,
        transferGroupId: "g1",
        type: "income",
        amount: 500000,
        date,
        description: "انتقال بین حساب‌ها",
        account: savings,
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      kind: "transfer",
      transferGroupId: "g1",
      amount: 500000,
      date,
      description: "انتقال بین حساب‌ها",
      fromAccount: cash,
      toAccount: savings,
    });
  });

  it("leaves regular (non-transfer) transactions untouched and unmerged", () => {
    const rows = groupTransferPairs([
      tx({ id: 1, transferGroupId: null, type: "expense", amount: 20000 }),
      tx({ id: 2, transferGroupId: null, type: "income", amount: 900000 }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ kind: "transaction", ...tx({ id: 1, transferGroupId: null, type: "expense", amount: 20000 }) });
    expect(rows[1].kind).toBe("transaction");
  });

  it("merges a transfer pair while leaving other ungrouped transactions in the same list alone", () => {
    const date = new Date("2026-09-05T00:00:00.000Z");
    const rows = groupTransferPairs([
      tx({ id: 1, transferGroupId: null, type: "expense", amount: 30000 }),
      tx({ id: 2, transferGroupId: "g1", type: "expense", amount: 500000, date, account: cash }),
      tx({ id: 3, transferGroupId: "g1", type: "income", amount: 500000, date, account: savings }),
      tx({ id: 4, transferGroupId: null, type: "income", amount: 1200000 }),
    ]);

    expect(rows.map((r) => r.kind)).toEqual(["transaction", "transfer", "transaction"]);
    expect((rows[1] as { transferGroupId: string }).transferGroupId).toBe("g1");
  });

  it("falls back to rendering a lone leg as a normal transaction when its pair isn't in this slice (e.g. split across a page boundary)", () => {
    const rows = groupTransferPairs([
      tx({ id: 1, transferGroupId: "g1", type: "expense", amount: 500000, account: cash }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("transaction");
    expect((rows[0] as { transferGroupId: string | null }).transferGroupId).toBe("g1");
  });

  it("does not double-count or drop rows when three legs somehow share one transferGroupId", () => {
    const rows = groupTransferPairs([
      tx({ id: 1, transferGroupId: "g1", type: "expense", account: cash }),
      tx({ id: 2, transferGroupId: "g1", type: "income", account: savings }),
      tx({ id: 3, transferGroupId: "g1", type: "expense", account: cash }),
    ]);

    // Not exactly 2 legs - treated as the "pair not fully resolvable"
    // fallback (same as the split-pair case above), so all three render as
    // plain transactions rather than being merged or silently dropped.
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.kind === "transaction")).toBe(true);
  });
});
