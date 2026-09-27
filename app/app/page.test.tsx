// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// This page has no existing test file (checked - no page.tsx anywhere in
// the repo is unit-tested; component tests cover components instead), so
// this is the first. Mocked the same two seams route tests already mock
// data through (getCurrentUser instead of route tests' getSession, and
// getDashboardData directly rather than the prisma calls it wraps) rather
// than hitting the real test DB, since this page's only new behavior is
// purely presentational (wrapping SavingsCard in a Link) and doesn't need
// real data to exercise.
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: vi.fn(),
}));
vi.mock("@/lib/data/dashboard", () => ({
  getDashboardData: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { getCurrentUser } from "@/lib/auth/session";
import { getDashboardData } from "@/lib/data/dashboard";
import DashboardPage from "@/app/app/page";

const mockedGetCurrentUser = vi.mocked(getCurrentUser);
const mockedGetDashboardData = vi.mocked(getDashboardData);

function baseDashboardData(overrides: Partial<Awaited<ReturnType<typeof getDashboardData>>> = {}) {
  return {
    totalBalance: 1000000,
    savingsBalance: 2540000,
    hasSavingsAccount: false,
    monthLabel: "شهریور",
    monthIncome: 0,
    monthExpense: 0,
    categoryBreakdown: [],
    recentTransactions: [],
    balanceInGoldGrams: null,
    balanceInUsd: null,
    incomeReaction: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DashboardPage (app/app/page.tsx) - savings sub-row on BalanceCard", () => {
  it("does not render the savings sub-row (or a link to /app/transfer) when the user has no savings account", async () => {
    mockedGetCurrentUser.mockResolvedValue({ id: 1, name: null } as Awaited<ReturnType<typeof getCurrentUser>>);
    mockedGetDashboardData.mockResolvedValue(baseDashboardData({ hasSavingsAccount: false }));

    render(await DashboardPage());

    expect(screen.queryByText("پس‌انداز")).toBeNull();
    expect(screen.queryByRole("link", { name: /پس‌انداز/ })).toBeNull();
  });

  it("renders the savings sub-row with the real balance, linked to /app/transfer, when the user has a savings account", async () => {
    mockedGetCurrentUser.mockResolvedValue({ id: 1, name: null } as Awaited<ReturnType<typeof getCurrentUser>>);
    mockedGetDashboardData.mockResolvedValue(
      baseDashboardData({ hasSavingsAccount: true, savingsBalance: 2540000 })
    );

    render(await DashboardPage());

    expect(screen.getByText("۲٬۵۴۰٬۰۰۰ تومان")).toBeDefined();
    const link = screen.getByRole("link", { name: /پس‌انداز/ });
    expect(link.getAttribute("href")).toBe("/app/transfer");
  });
});

describe("DashboardPage (app/app/page.tsx) - income-reaction banner", () => {
  it("renders the banner when getDashboardData returns an incomeReaction, and not otherwise", async () => {
    mockedGetCurrentUser.mockResolvedValue({ id: 1, name: null } as Awaited<ReturnType<typeof getCurrentUser>>);

    mockedGetDashboardData.mockResolvedValue(baseDashboardData());
    const { unmount } = render(await DashboardPage());
    expect(screen.queryByText(/طبق برنامه‌ات/)).toBeNull();
    unmount();

    mockedGetDashboardData.mockResolvedValue(
      baseDashboardData({
        incomeReaction: {
          incomeTransactionId: 7,
          incomeAmount: 1_000_000,
          items: [
            {
              strategyId: 1,
              label: "۵۰/۳۰/۲۰",
              percent: 20,
              suggestedAmount: 200_000,
              transferHref: "/app/transfer?from=1&to=2&amount=200000",
            },
          ],
        },
      })
    );
    render(await DashboardPage());
    expect(screen.getByText(/طبق برنامه‌ات/)).toBeDefined();
    expect(screen.getByText("طبق «۵۰/۳۰/۲۰» (۲۰٪): ۲۰۰٬۰۰۰ تومان")).toBeDefined();
    expect(screen.getByRole("link", { name: /انتقال/ }).getAttribute("href")).toBe("/app/transfer?from=1&to=2&amount=200000");
  });
});
