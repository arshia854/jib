import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));
// Only reached by a quick submit - lets those tests see what the background
// enrichment workflow would have been started with.
vi.mock("workflow/api", () => ({
  start: vi.fn(async () => ({})),
}));

import { start } from "workflow/api";
import { getSession } from "@/lib/auth/session";
import { GET, POST } from "@/app/api/transactions/route";
import {
  MAX_TRANSACTION_TEXT_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_TRANSACTION_AMOUNT,
  DEFAULT_TRANSACTIONS_PAGE_SIZE,
  MAX_TRANSACTIONS_PAGE_SIZE,
} from "@/lib/limits";

const mockedGetSession = vi.mocked(getSession);
const mockedStart = vi.mocked(start);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/transactions${query}`);
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

describe("POST /api/transactions - length limits", () => {
  let userId: number;
  let accountId: number;
  let categoryName: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSACTIONS-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));

    const account = await prisma.financeAccount.create({ data: { userId, name: "حساب تست", type: "cash" } });
    accountId = account.id;

    categoryName = "دسته تست تراکنش";
    await prisma.category.create({
      data: { userId, name: categoryName, icon: "🧪", color: "#3B82F6", type: "expense" },
    });
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      amount: 10000,
      type: "expense",
      category: categoryName,
      accountId,
      rawInput: "خرید تست ۱۰۰۰۰",
      ...overrides,
    };
  }

  it("rejects a rawInput over MAX_TRANSACTION_TEXT_LENGTH (400)", async () => {
    const res = await POST(makeRequest(validBody({ rawInput: "ا".repeat(MAX_TRANSACTION_TEXT_LENGTH + 1) })));
    expect(res.status).toBe(400);
  });

  it("rejects a description over MAX_DESCRIPTION_LENGTH (400)", async () => {
    const res = await POST(makeRequest(validBody({ description: "ب".repeat(MAX_DESCRIPTION_LENGTH + 1) })));
    expect(res.status).toBe(400);
  });

  it("rejects a category name over MAX_NAME_LENGTH (400)", async () => {
    const res = await POST(makeRequest(validBody({ category: "پ".repeat(MAX_NAME_LENGTH + 1) })));
    expect(res.status).toBe(400);
  });

  it("accepts values exactly at each limit (201)", async () => {
    const res = await POST(
      makeRequest(
        validBody({
          rawInput: "ت".repeat(MAX_TRANSACTION_TEXT_LENGTH),
          description: "ث".repeat(MAX_DESCRIPTION_LENGTH),
        })
      )
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.transaction.rawInput.length).toBe(MAX_TRANSACTION_TEXT_LENGTH);
    expect(data.transaction.description.length).toBe(MAX_DESCRIPTION_LENGTH);
  });

  it("rejects an idempotencyKey over MAX_IDEMPOTENCY_KEY_LENGTH (400)", async () => {
    const res = await POST(makeRequest(validBody({ idempotencyKey: "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1) })));
    expect(res.status).toBe(400);
  });

  it("accepts an idempotencyKey exactly at MAX_IDEMPOTENCY_KEY_LENGTH (201)", async () => {
    const res = await POST(makeRequest(validBody({ idempotencyKey: "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH) })));
    expect(res.status).toBe(201);
  });
});

// Transactions checklist (docs/roadmap-status.md, Phase 16): "malformed
// input" and "ownership" at the route level specifically - the equivalent
// data-layer behavior (createTransaction's own InvalidCategoryError/
// InvalidAccountError) already has coverage in lib/data/transactions.test.ts,
// but this route's own body-parsing/validation and error->status mapping
// had no direct test before this session.
describe("POST /api/transactions - malformed input", () => {
  let userId: number;
  let accountId: number;
  let categoryName: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSACTIONS-ROUTE-MALFORMED-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));

    const account = await prisma.financeAccount.create({ data: { userId, name: "حساب تست نامعتبر", type: "cash" } });
    accountId = account.id;

    categoryName = "دسته تست نامعتبر";
    await prisma.category.create({
      data: { userId, name: categoryName, icon: "🧪", color: "#3B82F6", type: "expense" },
    });
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  function validBody(overrides: Record<string, unknown> = {}) {
    return { amount: 10000, type: "expense", category: categoryName, accountId, rawInput: "خرید تست", ...overrides };
  }

  it("returns 401 when there is no session", async () => {
    mockedGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeRequest(validBody()));
    expect(res.status).toBe(401);
  });

  it("rejects a missing amount (400)", async () => {
    const res = await POST(makeRequest(validBody({ amount: undefined })));
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric amount (400)", async () => {
    const res = await POST(makeRequest(validBody({ amount: "not-a-number" })));
    expect(res.status).toBe(400);
  });

  it("rejects a zero/negative amount (400)", async () => {
    const zero = await POST(makeRequest(validBody({ amount: 0 })));
    expect(zero.status).toBe(400);
    const negative = await POST(makeRequest(validBody({ amount: -500 })));
    expect(negative.status).toBe(400);
  });

  it("rejects Infinity/-Infinity amounts (400)", async () => {
    const pos = await POST(makeRequest(validBody({ amount: Infinity })));
    expect(pos.status).toBe(400);
    const neg = await POST(makeRequest(validBody({ amount: -Infinity })));
    expect(neg.status).toBe(400);
  });

  it("rejects an amount over MAX_TRANSACTION_AMOUNT (400), and does not persist it", async () => {
    const res = await POST(makeRequest(validBody({ amount: MAX_TRANSACTION_AMOUNT + 1 })));
    expect(res.status).toBe(400);
    const res2 = await POST(makeRequest(validBody({ amount: 99999999999999 })));
    expect(res2.status).toBe(400);
    const rows = await prisma.transaction.findMany({ where: { userId, amount: { gt: MAX_TRANSACTION_AMOUNT } } });
    expect(rows).toHaveLength(0);
  });

  it("accepts an amount exactly at MAX_TRANSACTION_AMOUNT (201)", async () => {
    const res = await POST(makeRequest(validBody({ amount: MAX_TRANSACTION_AMOUNT })));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.transaction.amount).toBe(MAX_TRANSACTION_AMOUNT);
  });

  it("rejects an invalid type (400)", async () => {
    const res = await POST(makeRequest(validBody({ type: "savings" })));
    expect(res.status).toBe(400);
  });

  it("rejects a missing category (400)", async () => {
    const res = await POST(makeRequest(validBody({ category: undefined })));
    expect(res.status).toBe(400);
  });

  it("rejects a missing rawInput (400)", async () => {
    const res = await POST(makeRequest(validBody({ rawInput: undefined })));
    expect(res.status).toBe(400);
  });

  it("rejects a missing/non-integer accountId (400)", async () => {
    const missing = await POST(makeRequest(validBody({ accountId: undefined })));
    expect(missing.status).toBe(400);
    const nonInteger = await POST(makeRequest(validBody({ accountId: 1.5 })));
    expect(nonInteger.status).toBe(400);
  });

  it("400s (InvalidCategoryError) for a category name that doesn't exist for this user", async () => {
    const res = await POST(makeRequest(validBody({ category: "دسته‌ای که وجود ندارد" })));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(typeof data.error).toBe("string");
  });

  it("400s (InvalidAccountError) for an accountId that doesn't exist/belong to this user", async () => {
    const res = await POST(makeRequest(validBody({ accountId: 999_999_995 })));
    expect(res.status).toBe(400);
  });

  it("a well-formed request creates a transaction (201)", async () => {
    const res = await POST(makeRequest(validBody()));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.transaction.amount).toBe(10000);
    expect(data.transaction.type).toBe("expense");
    expect(data.transaction.userId).toBe(userId);
  });
});

// SEC-10 (docs/roadmap-status.md): route-level coverage for the optional
// client-generated idempotency key - lib/data/transactions.test.ts already
// covers createTransaction()'s own dedup/concurrency logic directly, so
// this only needs to confirm the route wires the field through correctly
// and that the HTTP-level contract (response shape/status) holds.
describe("POST /api/transactions - idempotency (SEC-10)", () => {
  let userId: number;
  let accountId: number;
  let categoryName: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSACTIONS-ROUTE-IDEMPOTENCY-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));

    const account = await prisma.financeAccount.create({ data: { userId, name: "حساب تست", type: "cash" } });
    accountId = account.id;

    categoryName = "دسته تست idempotency route";
    await prisma.category.create({
      data: { userId, name: categoryName, icon: "🧪", color: "#3B82F6", type: "expense" },
    });
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      amount: 10000,
      type: "expense",
      category: categoryName,
      accountId,
      rawInput: "خرید تست idempotency",
      ...overrides,
    };
  }

  it("creates normally (201) when no idempotencyKey is sent - existing callers unaffected", async () => {
    const res = await POST(makeRequest(validBody()));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.transaction.idempotencyKey).toBeNull();
  });

  it("a repeated idempotencyKey returns the same transaction (201, same id, no second row)", async () => {
    const key = `route-test-key-${Date.now()}`;
    const first = await POST(makeRequest(validBody({ idempotencyKey: key })));
    expect(first.status).toBe(201);
    const firstData = await first.json();

    const second = await POST(makeRequest(validBody({ idempotencyKey: key, amount: 55555 })));
    expect(second.status).toBe(201);
    const secondData = await second.json();

    expect(secondData.transaction.id).toBe(firstData.transaction.id);
    expect(secondData.transaction.amount).toBe(firstData.transaction.amount);

    const rows = await prisma.transaction.findMany({ where: { userId, idempotencyKey: key } });
    expect(rows).toHaveLength(1);
  });
});

describe("POST /api/transactions - quick submit enrichment kickoff", () => {
  let userId: number;
  let accountId: number;
  const categoryName = "دسته تست quick route";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSACTIONS-ROUTE-QUICK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));

    const account = await prisma.financeAccount.create({ data: { userId, name: "حساب تست", type: "cash" } });
    accountId = account.id;
    await prisma.category.create({
      data: { userId, name: categoryName, icon: "🧪", color: "#3B82F6", type: "expense" },
    });
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  function quickBody(overrides: Record<string, unknown> = {}) {
    return {
      amount: 50000,
      type: "expense",
      category: categoryName,
      accountId,
      rawInput: "۵۰ هزار قهوه",
      date: "2026-09-25",
      quick: true,
      ...overrides,
    };
  }

  it("tells the workflow to keep a hand-picked date", async () => {
    mockedStart.mockClear();
    const res = await POST(makeRequest(quickBody({ dateIsManual: true })));
    expect(res.status).toBe(201);
    const { transaction } = await res.json();

    expect(mockedStart).toHaveBeenCalledWith(expect.anything(), [
      userId,
      transaction.id,
      "۵۰ هزار قهوه",
      { keepDate: true },
    ]);
  });

  it("lets the workflow set the date when it wasn't picked by hand", async () => {
    mockedStart.mockClear();
    const res = await POST(makeRequest(quickBody()));
    expect(res.status).toBe(201);
    const { transaction } = await res.json();

    expect(mockedStart).toHaveBeenCalledWith(expect.anything(), [
      userId,
      transaction.id,
      "۵۰ هزار قهوه",
      { keepDate: false },
    ]);
  });
});

// Phase 4.1 pagination coverage (docs/roadmap-status.md - "GET
// /api/transactions has zero pagination"). GET had no test coverage at all
// before this. rowCount is deliberately not a multiple of the page size so
// the second/last page is a genuine partial page, not a coincidentally-full
// one.
describe("GET /api/transactions - pagination", () => {
  let userId: number;
  let accountId: number;
  const rowCount = DEFAULT_TRANSACTIONS_PAGE_SIZE + 3;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSACTIONS-ROUTE-GET-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));

    const account = await prisma.financeAccount.create({ data: { userId, name: "حساب تست GET", type: "cash" } });
    accountId = account.id;

    const category = await prisma.category.create({
      data: { userId, name: "دسته تست GET", icon: "🧪", color: "#666666", type: "expense" },
    });

    await prisma.transaction.createMany({
      data: Array.from({ length: rowCount }, (_, i) => ({
        userId,
        accountId,
        categoryId: category.id,
        amount: i + 1,
        type: "expense",
        rawInput: `تراکنش GET ${i + 1}`,
        date: new Date(2026, 2, i + 1),
      })),
    });
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("401s when not signed in", async () => {
    mockedGetSession.mockResolvedValueOnce(null);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it("defaults to page 1 / DEFAULT_TRANSACTIONS_PAGE_SIZE with pagination metadata, newest date first", async () => {
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.page).toBe(1);
    expect(data.pageSize).toBe(DEFAULT_TRANSACTIONS_PAGE_SIZE);
    expect(data.total).toBe(rowCount);
    expect(data.totalPages).toBe(2);
    expect(data.transactions).toHaveLength(DEFAULT_TRANSACTIONS_PAGE_SIZE);
    expect(data.transactions[0].amount).toBe(rowCount);
  });

  it("honors ?page=2 for the remainder", async () => {
    const res = await GET(makeGetRequest("?page=2"));
    const data = await res.json();

    expect(data.page).toBe(2);
    expect(data.transactions).toHaveLength(rowCount - DEFAULT_TRANSACTIONS_PAGE_SIZE);
    expect(data.transactions[0].amount).toBe(rowCount - DEFAULT_TRANSACTIONS_PAGE_SIZE);
  });

  it("falls back to page 1 for invalid ?page values", async () => {
    for (const invalid of ["0", "-1", "abc"]) {
      const res = await GET(makeGetRequest(`?page=${invalid}`));
      const data = await res.json();
      expect(data.page).toBe(1);
    }
  });

  it("clamps ?pageSize above MAX_TRANSACTIONS_PAGE_SIZE down to the cap", async () => {
    const res = await GET(makeGetRequest("?pageSize=999999"));
    const data = await res.json();

    expect(data.pageSize).toBe(MAX_TRANSACTIONS_PAGE_SIZE);
    // rowCount is well under the cap here, so this also confirms the clamp
    // doesn't truncate below what's actually available.
    expect(data.transactions).toHaveLength(rowCount);
  });

  it("preserves orderBy date desc within the returned page", async () => {
    const res = await GET(makeGetRequest());
    const data = await res.json();
    const amounts = data.transactions.map((t: { amount: number }) => t.amount);

    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
  });
});
