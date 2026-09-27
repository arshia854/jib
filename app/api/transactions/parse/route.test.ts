import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/nvidia-ai", () => ({
  chatCompletion: vi.fn(),
  AI_PROVIDER: "nvidia-nim",
}));

import { getSession } from "@/lib/auth/session";
import { chatCompletion } from "@/lib/nvidia-ai";
import { POST } from "@/app/api/transactions/parse/route";
import { MAX_TRANSACTION_TEXT_LENGTH } from "@/lib/limits";
import { TRANSACTION_PARSE_USER_RULE } from "@/lib/rate-limit";

const mockedGetSession = vi.mocked(getSession);
const mockedChatCompletion = vi.mocked(chatCompletion);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/transactions/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

// A real bank-SMS fixture (reused from lib/bank/parse-bank-sms.test.ts) -
// deterministically parsed by parseBankSms with no AI/network call, so it
// exercises this route's length check against a genuinely legitimate,
// realistically-sized input rather than an arbitrary short string.
const TEJARAT_SMS = `بانک تجارت
حساب:0145059220990
برداشت:1,500,000 ریال
از طريق: شتاب
مانده:134,866 ریال`;

describe("POST /api/transactions/parse - length limits", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-PARSE-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
  });

  it("rejects text over MAX_TRANSACTION_TEXT_LENGTH (400)", async () => {
    const res = await POST(makeRequest({ text: "ا".repeat(MAX_TRANSACTION_TEXT_LENGTH + 1) }));
    expect(res.status).toBe(400);
  });

  it("accepts text exactly at MAX_TRANSACTION_TEXT_LENGTH", async () => {
    // Padding a real, deterministically-parsed bank SMS fixture out to
    // exactly the limit - still resolves via parseBankSms (no AI call), so
    // this doesn't depend on lib/nvidia-ai being reachable in tests.
    const padded = TEJARAT_SMS + "ا".repeat(MAX_TRANSACTION_TEXT_LENGTH - TEJARAT_SMS.length);
    expect(padded.length).toBe(MAX_TRANSACTION_TEXT_LENGTH);
    const res = await POST(makeRequest({ text: padded }));
    expect(res.status).toBe(200);
  });

  it("does not reject a real, realistically-sized bank SMS fixture", async () => {
    const res = await POST(makeRequest({ text: TEJARAT_SMS }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.parsed.source).toBe("bank-sms");
  });
});

// AI checklist item: "provider error" - end-to-end through this route.
// lib/nvidia-ai.test.ts already unit-tests that a failed HTTP call makes
// chatCompletion() itself reject; this had no test proving what happens
// when parseTransactionWithAI's own AI call (the one real chatCompletion()
// call site inside it, reached only past the deterministic bank-SMS/
// merchant fast paths) actually fails.
describe("POST /api/transactions/parse - AI provider failure", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-PARSE-ROUTE-AI-FAIL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("returns 502 and records an ErrorLog row when the AI call fails, for text that isn't bank-SMS/merchant-resolvable", async () => {
    mockedChatCompletion.mockRejectedValueOnce(new Error("NVIDIA NIM: connection refused"));

    // No digits, no recognizable bank/merchant signal - parseTransactionWithAI
    // can only resolve this via the real AI call (mocked to fail above).
    const res = await POST(makeRequest({ text: "امروز یک چیزی خریدم ولی یادم نیست چی بود" }));

    expect(res.status).toBe(502);
    const data = await res.json();
    // Fixed client-facing message - the raw provider error text must not
    // reach the client...
    expect(data.error).toBe("متن پردازش نشد. لطفاً دوباره تلاش کنید.");
    expect(data.error).not.toContain("connection refused");

    // ...but is still what gets logged server-side.
    const row = await prisma.errorLog.findFirst({
      where: { route: "transactions/parse", userId },
      orderBy: { id: "desc" },
    });
    expect(row).not.toBeNull();
    expect(row!.message).toContain("connection refused");
  });

  // UserFacingParseError (lib/ai/parse-transaction.ts) is the one error type
  // whose message is written for the user, so it's the one passed through
  // verbatim instead of the generic message above.
  it("passes a UserFacingParseError's message through: AI returned non-JSON text", async () => {
    mockedChatCompletion.mockResolvedValueOnce("این اصلاً JSON نیست");

    const res = await POST(makeRequest({ text: "امروز یک چیزی خریدم ولی یادم نیست چی بود" }));

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("متوجه متن تراکنش نشدم. لطفاً واضح‌تر بنویسید.");
  });

  it("passes a UserFacingParseError's message through: AI JSON failed shape validation", async () => {
    mockedChatCompletion.mockResolvedValueOnce('{"amount": -5}');

    const res = await POST(makeRequest({ text: "امروز یک چیزی خریدم ولی یادم نیست چی بود" }));

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("پاسخ هوش مصنوعی ساختار نامعتبری داشت. دوباره تلاش کنید.");
  });
});

// Batch mode (components/transactions/batch-add-transaction-form.tsx) calls
// this exact route once per row, unmodified - no separate rate-limit rule,
// no bypass. This proves TRANSACTION_PARSE_USER_RULE (lib/rate-limit.ts)
// still fires past its limit for a single user regardless of how many
// individual requests that user's client sends, batch or otherwise -
// batch mode gets no more AI-call budget than the single-transaction flow
// already had.
describe("POST /api/transactions/parse - rate limiting (what batch mode relies on)", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-PARSE-ROUTE-RATE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
  });

  it("allows exactly TRANSACTION_PARSE_USER_RULE.limit calls for one user, then 429s the next one", async () => {
    // Deterministic bank-sms fast path (see TEJARAT_SMS above) - no AI call,
    // so hammering this doesn't depend on lib/nvidia-ai being reachable.
    for (let i = 0; i < TRANSACTION_PARSE_USER_RULE.limit; i++) {
      const res = await POST(makeRequest({ text: TEJARAT_SMS }));
      expect(res.status).toBe(200);
    }

    const limited = await POST(makeRequest({ text: TEJARAT_SMS }));
    expect(limited.status).toBe(429);
    const data = await limited.json();
    expect(typeof data.retryAfterSeconds).toBe("number");
    expect(data.retryAfterSeconds).toBeGreaterThan(0);
  }, 30000);
});
