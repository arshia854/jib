import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatToman } from "@/lib/format";

vi.mock("@/lib/data/savings-strategies", () => ({
  getMostRecentActiveSavingsStrategy: vi.fn(),
}));
vi.mock("@/lib/notifications/send-push", () => ({
  sendPushToUser: vi.fn(),
}));
vi.mock("@/lib/observability/report-error", () => ({
  reportError: vi.fn(),
}));

import { getMostRecentActiveSavingsStrategy } from "@/lib/data/savings-strategies";
import { sendPushToUser } from "@/lib/notifications/send-push";
import { reportError } from "@/lib/observability/report-error";
import { calculateSuggestedSavingsAmount, notifyIncomeSavingsSuggestion } from "@/lib/notifications/savings-suggestion";

const mockedGetStrategy = vi.mocked(getMostRecentActiveSavingsStrategy);
const mockedSendPush = vi.mocked(sendPushToUser);
const mockedReportError = vi.mocked(reportError);

describe("calculateSuggestedSavingsAmount", () => {
  it("returns null for a non-active strategy", () => {
    const result = calculateSuggestedSavingsAmount(
      { status: "paused", targetPercent: 20, targetAmount: null },
      10_000_000
    );
    expect(result).toBeNull();
  });

  it("computes a percent-based amount, rounded", () => {
    const result = calculateSuggestedSavingsAmount(
      { status: "active", targetPercent: 15, targetAmount: null },
      1_000_001
    );
    expect(result).toBe(Math.round(1_000_001 * 0.15));
  });

  it("returns a fixed target amount when it's below the income", () => {
    const result = calculateSuggestedSavingsAmount(
      { status: "active", targetPercent: null, targetAmount: 500_000 },
      2_000_000
    );
    expect(result).toBe(500_000);
  });

  it("caps a fixed target amount at the income amount - never suggests saving more than was earned", () => {
    const result = calculateSuggestedSavingsAmount(
      { status: "active", targetPercent: null, targetAmount: 3_000_000 },
      1_000_000
    );
    expect(result).toBe(1_000_000);
  });

  it("returns null when neither targetPercent nor targetAmount is set", () => {
    const result = calculateSuggestedSavingsAmount(
      { status: "active", targetPercent: null, targetAmount: null },
      1_000_000
    );
    expect(result).toBeNull();
  });

  it("returns null when the computed suggestion is zero", () => {
    const result = calculateSuggestedSavingsAmount({ status: "active", targetPercent: 10, targetAmount: null }, 0);
    expect(result).toBeNull();
  });
});

describe("notifyIncomeSavingsSuggestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing for an expense transaction", async () => {
    await notifyIncomeSavingsSuggestion(1, { type: "expense", amount: 1_000_000, transferGroupId: null });
    expect(mockedGetStrategy).not.toHaveBeenCalled();
    expect(mockedSendPush).not.toHaveBeenCalled();
  });

  it("does nothing for a transfer's income leg", async () => {
    await notifyIncomeSavingsSuggestion(1, { type: "income", amount: 1_000_000, transferGroupId: "group-1" });
    expect(mockedGetStrategy).not.toHaveBeenCalled();
    expect(mockedSendPush).not.toHaveBeenCalled();
  });

  it("does nothing when the user has no active strategy", async () => {
    mockedGetStrategy.mockResolvedValue(null);
    await notifyIncomeSavingsSuggestion(1, { type: "income", amount: 1_000_000, transferGroupId: null });
    expect(mockedSendPush).not.toHaveBeenCalled();
  });

  it("does nothing when the calculated suggestion is null", async () => {
    mockedGetStrategy.mockResolvedValue({
      id: 1,
      userId: 1,
      formulaType: "custom",
      status: "active",
      targetPercent: null,
      targetAmount: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    await notifyIncomeSavingsSuggestion(1, { type: "income", amount: 1_000_000, transferGroupId: null });
    expect(mockedSendPush).not.toHaveBeenCalled();
  });

  it("sends a push notification naming the real income and suggested amounts", async () => {
    mockedGetStrategy.mockResolvedValue({
      id: 1,
      userId: 1,
      formulaType: "fifty_thirty_twenty",
      status: "active",
      targetPercent: 20,
      targetAmount: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    await notifyIncomeSavingsSuggestion(1, { type: "income", amount: 10_000_000, transferGroupId: null });

    expect(mockedSendPush).toHaveBeenCalledTimes(1);
    const [userId, data] = mockedSendPush.mock.calls[0];
    expect(userId).toBe(1);
    expect(data.type).toBe("income_savings_suggestion");
    expect(data.body).toContain(formatToman(10_000_000));
    expect(data.body).toContain(formatToman(2_000_000));
  });

  it("reports but swallows an error from the strategy lookup", async () => {
    mockedGetStrategy.mockRejectedValue(new Error("db down"));
    await expect(
      notifyIncomeSavingsSuggestion(1, { type: "income", amount: 1_000_000, transferGroupId: null })
    ).resolves.toBeUndefined();
    expect(mockedReportError).toHaveBeenCalledTimes(1);
    expect(mockedSendPush).not.toHaveBeenCalled();
  });

  it("reports but swallows an error from sendPushToUser", async () => {
    mockedGetStrategy.mockResolvedValue({
      id: 1,
      userId: 1,
      formulaType: "pay_yourself_first",
      status: "active",
      targetPercent: 10,
      targetAmount: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    mockedSendPush.mockRejectedValue(new Error("push failed"));

    await expect(
      notifyIncomeSavingsSuggestion(1, { type: "income", amount: 1_000_000, transferGroupId: null })
    ).resolves.toBeUndefined();
    expect(mockedReportError).toHaveBeenCalledTimes(1);
  });
});
