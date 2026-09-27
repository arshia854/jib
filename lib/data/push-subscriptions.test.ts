import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { listUserIdsWithPushSubscriptions } from "@/lib/data/push-subscriptions";

describe("listUserIdsWithPushSubscriptions", () => {
  let userWithOneSubId: number;
  let userWithTwoSubsId: number;
  let userWithNoSubId: number;

  beforeAll(async () => {
    const userWithOneSub = await prisma.user.create({
      data: { phoneNumber: `TEST-PUSH-SUB-ONE-${Date.now()}` },
    });
    userWithOneSubId = userWithOneSub.id;

    const userWithTwoSubs = await prisma.user.create({
      data: { phoneNumber: `TEST-PUSH-SUB-TWO-${Date.now()}` },
    });
    userWithTwoSubsId = userWithTwoSubs.id;

    const userWithNoSub = await prisma.user.create({
      data: { phoneNumber: `TEST-PUSH-SUB-NONE-${Date.now()}` },
    });
    userWithNoSubId = userWithNoSub.id;

    await prisma.pushSubscription.create({
      data: {
        userId: userWithOneSubId,
        endpoint: `TEST-ENDPOINT-ONE-${Date.now()}`,
        p256dh: "test-p256dh",
        auth: "test-auth",
      },
    });
    // Two subscriptions for the same user (e.g. two devices) - must collapse
    // to a single userId in the result, not appear twice.
    await prisma.pushSubscription.create({
      data: {
        userId: userWithTwoSubsId,
        endpoint: `TEST-ENDPOINT-TWO-A-${Date.now()}`,
        p256dh: "test-p256dh",
        auth: "test-auth",
      },
    });
    await prisma.pushSubscription.create({
      data: {
        userId: userWithTwoSubsId,
        endpoint: `TEST-ENDPOINT-TWO-B-${Date.now()}`,
        p256dh: "test-p256dh",
        auth: "test-auth",
      },
    });
  }, 20000);

  afterAll(async () => {
    await prisma.pushSubscription.deleteMany({
      where: { userId: { in: [userWithOneSubId, userWithTwoSubsId, userWithNoSubId] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [userWithOneSubId, userWithTwoSubsId, userWithNoSubId] } },
    });
    await prisma.$disconnect();
  }, 20000);

  it("returns exactly the userIds with at least one subscription, each once, excluding users with none", async () => {
    const result = await listUserIdsWithPushSubscriptions();

    expect(result).toContain(userWithOneSubId);
    expect(result).toContain(userWithTwoSubsId);
    expect(result).not.toContain(userWithNoSubId);
    expect(result.filter((id) => id === userWithTwoSubsId)).toHaveLength(1);
  });
});
