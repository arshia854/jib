// Phase A3 (docs/roadmap-status.md savings roadmap): collapses the two
// Transaction rows that make up one internal transfer (see
// prisma/schema.prisma's own comment on Transaction.transferGroupId, and
// lib/data/transfers.ts's createTransfer) into a single render item, so a
// transfer never shows up in a list as two separate income/expense rows.
//
// Deliberately a plain, DB-free pure function rather than a change to
// lib/data/transactions.ts's listTransactions() itself: that function (and
// getDashboardData() in lib/data/dashboard.ts) also backs GET
// /api/transactions and other callers that expect a flat list of raw
// Transaction rows - folding pairs together there would silently change
// that shared return shape for every consumer, not just the two UI list
// pages that actually need grouped rows. Instead, each page (a real
// "list-assembly" server component - see app/app/page.tsx and
// app/app/dashboard/page.tsx) calls this itself, right after fetching, on
// whatever page/slice of transactions it already has.
//
// That "whatever page/slice it already has" is the important constraint:
// both listTransactions() and getDashboardData()'s recentTransactions are
// genuinely paginated/limited at the database level (skip/take, or
// take: 5) - this function only ever sees one page's worth of rows, never
// the full table. createTransfer() always writes both legs with the exact
// same `date` and in the same request, so in practice they land adjacent
// in a `date desc` ordering and almost always fall on the same page - but
// nothing about the schema *guarantees* that (a huge burst of same-instant
// activity, or a transfer sitting exactly at a page boundary, could split
// a pair across two fetches). When that happens, this function still finds
// only one leg of a given transferGroupId in its input and - rather than
// hide it, or throw - renders it as a normal single transaction, same as
// any other row. No data is ever silently dropped; a split pair is just a
// known, accepted degradation to "looks like a regular transaction that
// happens to be categorized as انتقال بین حساب‌ها" instead of an "انتقال"
// line, rather than a crash or a missing row.
export interface TransferAccountRef {
  id: number;
  name: string;
}

export interface GroupableTransaction {
  id: number;
  transferGroupId: string | null;
  type: string;
  amount: number;
  date: Date;
  description: string | null;
  account: TransferAccountRef;
}

export interface TransferPairRow {
  kind: "transfer";
  transferGroupId: string;
  amount: number;
  date: Date;
  description: string | null;
  fromAccount: TransferAccountRef;
  toAccount: TransferAccountRef;
}

export type TransactionRowInput<T extends GroupableTransaction> = { kind: "transaction" } & T;

export type GroupedRow<T extends GroupableTransaction> = TransactionRowInput<T> | TransferPairRow;

export function groupTransferPairs<T extends GroupableTransaction>(transactions: T[]): GroupedRow<T>[] {
  const legsByGroup = new Map<string, T[]>();
  for (const t of transactions) {
    if (!t.transferGroupId) continue;
    const legs = legsByGroup.get(t.transferGroupId);
    if (legs) {
      legs.push(t);
    } else {
      legsByGroup.set(t.transferGroupId, [t]);
    }
  }

  const consumed = new Set<number>();
  const rows: GroupedRow<T>[] = [];

  for (const t of transactions) {
    if (consumed.has(t.id)) continue;

    const legs = t.transferGroupId ? legsByGroup.get(t.transferGroupId) : undefined;
    if (t.transferGroupId && legs && legs.length === 2) {
      const [fromLeg, toLeg] = legs[0].type === "expense" ? legs : [legs[1], legs[0]];
      consumed.add(legs[0].id);
      consumed.add(legs[1].id);
      rows.push({
        kind: "transfer",
        transferGroupId: t.transferGroupId,
        amount: fromLeg.amount,
        date: fromLeg.date,
        description: fromLeg.description,
        fromAccount: fromLeg.account,
        toAccount: toLeg.account,
      });
      continue;
    }

    // Either not part of a transfer at all, or the pair's other leg isn't
    // in this slice (see this file's own top-of-file comment) - either way,
    // render it as a normal single row rather than dropping it.
    rows.push({ kind: "transaction", ...t });
  }

  return rows;
}
