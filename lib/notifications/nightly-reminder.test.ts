import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/data/push-subscriptions", () => ({
  listUserIdsWithPushSubscriptions: vi.fn(),
}));
vi.mock("@/lib/notifications/send-push", () => ({
  sendPushToUser: vi.fn(),
}));
vi.mock("@/lib/observability/report-error", () => ({
  reportError: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { listUserIdsWithPushSubscriptions } from "@/lib/data/push-subscriptions";
import { sendPushToUser } from "@/lib/notifications/send-push";
import { reportError } from "@/lib/observability/report-error";
import { logger } from "@/lib/observability/logger";
import { runNightlyReminderJob } from "@/lib/notifications/nightly-reminder";

const mockedListUserIds = vi.mocked(listUserIdsWithPushSubscriptions);
const mockedSendPush = vi.mocked(sendPushToUser);
const mockedReportError = vi.mocked(reportError);
const mockedLoggerInfo = vi.mocked(logger.info);

describe("runNightlyReminderJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when no users have a push subscription", async () => {
    mockedListUserIds.mockResolvedValue([]);

    const result = await runNightlyReminderJob();

    expect(result).toEqual({ attempted: 0, succeeded: 0 });
    expect(mockedSendPush).not.toHaveBeenCalled();
    expect(mockedLoggerInfo).toHaveBeenCalledTimes(1);
  });

  it("sends a nightly_reminder push to every user with a subscription", async () => {
    mockedListUserIds.mockResolvedValue([1, 2, 3]);
    mockedSendPush.mockResolvedValue(undefined as never);

    const result = await runNightlyReminderJob();

    expect(result).toEqual({ attempted: 3, succeeded: 3 });
    expect(mockedSendPush).toHaveBeenCalledTimes(3);
    for (const [userId, data] of mockedSendPush.mock.calls) {
      expect([1, 2, 3]).toContain(userId);
      expect(data.type).toBe("nightly_reminder");
      expect(typeof data.title).toBe("string");
      expect(data.title.length).toBeGreaterThan(0);
      expect(typeof data.body).toBe("string");
      expect(data.body.length).toBeGreaterThan(0);
    }
  });

  it("sends across more users than one batch (BATCH_SIZE=20) without dropping any", async () => {
    const userIds = Array.from({ length: 45 }, (_, i) => i + 1);
    mockedListUserIds.mockResolvedValue(userIds);
    mockedSendPush.mockResolvedValue(undefined as never);

    const result = await runNightlyReminderJob();

    expect(result).toEqual({ attempted: 45, succeeded: 45 });
    expect(mockedSendPush).toHaveBeenCalledTimes(45);
  });

  it("reports but continues past a single user's send failure", async () => {
    mockedListUserIds.mockResolvedValue([1, 2, 3]);
    mockedSendPush.mockImplementation(async (userId) => {
      if (userId === 2) throw new Error("push failed");
      return undefined as never;
    });

    const result = await runNightlyReminderJob();

    expect(result).toEqual({ attempted: 3, succeeded: 2 });
    expect(mockedSendPush).toHaveBeenCalledTimes(3);
    expect(mockedReportError).toHaveBeenCalledTimes(1);
    expect(mockedReportError.mock.calls[0][0].userId).toBe(2);
  });

  it("reports and returns a zero summary, without throwing, when listing users fails", async () => {
    mockedListUserIds.mockRejectedValue(new Error("db down"));

    await expect(runNightlyReminderJob()).resolves.toEqual({ attempted: 0, succeeded: 0 });
    expect(mockedSendPush).not.toHaveBeenCalled();
    expect(mockedReportError).toHaveBeenCalledTimes(1);
  });
});
