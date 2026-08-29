import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/prices/get-live-prices", async () => {
  const actual = await vi.importActual<typeof import("@/lib/prices/get-live-prices")>("@/lib/prices/get-live-prices");
  return { ...actual, getLivePrices: vi.fn() };
});

import { getSession } from "@/lib/auth/session";
import { getLivePrices } from "@/lib/prices/get-live-prices";
import { GET, POST } from "@/app/api/assets/route";
import { PATCH, DELETE } from "@/app/api/assets/[id]/route";
import { MAX_NAME_LENGTH, MAX_ASSET_QUANTITY, MAX_ASSET_PRICE_PER_UNIT } from "@/lib/limits";

const mockedGetSession = vi.mocked(getSession);
const mockedGetLivePrices = vi.mocked(getLivePrices);

function makeRequest(method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

async function createTestUser(label: string) {
  const user = await prisma.user.create({
    data: { phoneNumber: `TEST-ASSETS-ROUTE-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  });
  return user.id;
}

async function cleanupUser(userId: number) {
  await prisma.asset.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/assets", () => {
  let userId: number;

  beforeAll(async () => {
    userId = await createTestUser("get");
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  it("returns 401 when there is no session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns an empty summary for a user with no assets", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.assets).toEqual([]);
    expect(data.totalValue).toBe(0);
  });

  it("includes a live-priced current value for a gold asset, using getLivePrices()", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    mockedGetLivePrices.mockResolvedValue({
      goldGramPricePerUnit: 5_000_000,
      usdPricePerUnit: 700_000,
      bitcoinPricePerUnit: 80_000_000_000,
      fetchedAt: new Date(),
      stale: false,
    });
    const asset = await prisma.asset.create({
      data: { userId, type: "gold", quantity: 2, purchasePricePerUnit: 4_000_000n },
    });

    try {
      const res = await GET();
      const data = await res.json();
      const gold = data.assets.find((a: { id: number }) => a.id === asset.id);
      expect(gold.currentValue).toBe(10_000_000);
      expect(gold.profitLossToman).toBe(2_000_000);
    } finally {
      await prisma.asset.delete({ where: { id: asset.id } });
    }
  });
});

describe("POST /api/assets", () => {
  let userId: number;

  beforeAll(async () => {
    userId = await createTestUser("post");
    mockedGetSession.mockResolvedValue(asSession(userId));
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  it("returns 401 when there is no session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await POST(makeRequest("POST", "/api/assets", { type: "gold", quantity: 1, purchasePricePerUnit: 1 }));
    expect(res.status).toBe(401);
  });

  describe("validation", () => {
    beforeAll(() => {
      mockedGetSession.mockResolvedValue(asSession(userId));
    });

    it("rejects an invalid type (400)", async () => {
      const res = await POST(makeRequest("POST", "/api/assets", { type: "silver", quantity: 1, purchasePricePerUnit: 1 }));
      expect(res.status).toBe(400);
    });

    it("rejects a non-positive quantity (400)", async () => {
      const res = await POST(makeRequest("POST", "/api/assets", { type: "gold", quantity: 0, purchasePricePerUnit: 1 }));
      expect(res.status).toBe(400);
    });

    it("rejects a quantity over MAX_ASSET_QUANTITY (400)", async () => {
      const res = await POST(
        makeRequest("POST", "/api/assets", { type: "gold", quantity: MAX_ASSET_QUANTITY + 1, purchasePricePerUnit: 1 })
      );
      expect(res.status).toBe(400);
    });

    it("rejects a purchasePricePerUnit over MAX_ASSET_PRICE_PER_UNIT (400)", async () => {
      const res = await POST(
        makeRequest("POST", "/api/assets", {
          type: "bitcoin",
          quantity: 1,
          purchasePricePerUnit: MAX_ASSET_PRICE_PER_UNIT + 1,
        })
      );
      expect(res.status).toBe(400);
    });

    it("rejects a custom asset with no name (400)", async () => {
      const res = await POST(makeRequest("POST", "/api/assets", { type: "custom", quantity: 1, purchasePricePerUnit: 1 }));
      expect(res.status).toBe(400);
    });

    it("rejects a custom asset name over MAX_NAME_LENGTH (400)", async () => {
      const res = await POST(
        makeRequest("POST", "/api/assets", {
          type: "custom",
          name: "الف".repeat(MAX_NAME_LENGTH + 1),
          quantity: 1,
          purchasePricePerUnit: 1,
        })
      );
      expect(res.status).toBe(400);
    });
  });

  it("creates a gold asset (live-priced - name/currentPricePerUnit ignored) and stores a per-BTC-sized price intact for bitcoin", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await POST(
      makeRequest("POST", "/api/assets", {
        type: "bitcoin",
        quantity: 0.01,
        purchasePricePerUnit: 80_000_000_000,
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.asset.purchasePricePerUnit).toBe(80_000_000_000);
    expect(data.asset.currentPricePerUnit).toBeNull();
  });

  it("creates a custom asset, defaulting currentPricePerUnit to purchasePricePerUnit when omitted", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await POST(
      makeRequest("POST", "/api/assets", {
        type: "custom",
        name: "دارایی دستی تست روت",
        quantity: 2,
        purchasePricePerUnit: 500_000,
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.asset.currentPricePerUnit).toBe(500_000);
  });
});

describe("PATCH/DELETE /api/assets/[id]", () => {
  let userId: number;
  let assetId: number;

  beforeAll(async () => {
    userId = await createTestUser("patch-delete");
    mockedGetSession.mockResolvedValue(asSession(userId));
    const created = await prisma.asset.create({
      data: { userId, type: "gold", quantity: 1, purchasePricePerUnit: 4_000_000n },
    });
    assetId = created.id;
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  it("PATCH returns 404 for a non-existent/foreign asset id", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await PATCH(makeRequest("PATCH", `/api/assets/999999999`, { quantity: 2 }), {
      params: Promise.resolve({ id: "999999999" }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH updates quantity", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await PATCH(makeRequest("PATCH", `/api/assets/${assetId}`, { quantity: 3 }), {
      params: Promise.resolve({ id: String(assetId) }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.asset.quantity).toBe(3);
  });

  it("DELETE removes the asset", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await DELETE(makeRequest("DELETE", `/api/assets/${assetId}`), {
      params: Promise.resolve({ id: String(assetId) }),
    });
    expect(res.status).toBe(200);
    expect(await prisma.asset.findUnique({ where: { id: assetId } })).toBeNull();
  });
});
