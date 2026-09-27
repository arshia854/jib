import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/prices/get-live-prices", async () => {
  const actual = await vi.importActual<typeof import("@/lib/prices/get-live-prices")>("@/lib/prices/get-live-prices");
  return { ...actual, getLivePrices: vi.fn() };
});

import { getSession } from "@/lib/auth/session";
import { getLivePrices, LivePriceUnavailableError } from "@/lib/prices/get-live-prices";
import { GET } from "@/app/api/assets/live-prices/route";

const mockedGetSession = vi.mocked(getSession);
const mockedGetLivePrices = vi.mocked(getLivePrices);

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/assets/live-prices", () => {
  it("returns 401 when there is no session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the raw gold/usd/bitcoin per-unit prices when available", async () => {
    mockedGetSession.mockResolvedValue(asSession(1));
    mockedGetLivePrices.mockResolvedValue({
      goldGramPricePerUnit: 5_000_000,
      usdPricePerUnit: 700_000,
      bitcoinPricePerUnit: 80_000_000_000,
      fetchedAt: new Date(),
      stale: false,
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      unavailable: false,
      goldGramPricePerUnit: 5_000_000,
      usdPricePerUnit: 700_000,
      bitcoinPricePerUnit: 80_000_000_000,
      stale: false,
    });
  });

  it("returns { unavailable: true } (200, not 500) when no price has ever been fetched", async () => {
    mockedGetSession.mockResolvedValue(asSession(1));
    mockedGetLivePrices.mockRejectedValue(new LivePriceUnavailableError("قیمت لحظه‌ای در دسترس نیست."));

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unavailable: true });
  });

  it("propagates an unexpected (non-LivePriceUnavailableError) failure", async () => {
    mockedGetSession.mockResolvedValue(asSession(1));
    mockedGetLivePrices.mockRejectedValue(new Error("boom"));

    await expect(GET()).rejects.toThrow("boom");
  });
});
