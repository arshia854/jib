import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { POST } from "@/app/api/log-error/route";

const mockedGetSession = vi.mocked(getSession);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/log-error", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Deliberately not built from Date.now()/a long digit run: logError()
// redacts any 9+-consecutive-digit sequence in `message` before storing it
// (Phase 6 privacy audit - see lib/error-log.test.ts), which would silently
// swap this fixture's own id out of the stored row and break the
// exact-message lookups below. random-base36 avoids that.
const testRoute = `TEST-LOG-ERROR-ROUTE-${Math.random().toString(36).slice(2, 10)}`;

afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { route: "client" } });
  await prisma.$disconnect();
});

beforeEach(() => {
  mockedGetSession.mockReset();
});

describe("POST /api/log-error", () => {
  it("rejects a missing/empty message (400) and writes nothing", async () => {
    mockedGetSession.mockResolvedValue(null);
    const countBefore = await prisma.errorLog.count({ where: { route: "client" } });

    const res = await POST(makeRequest({ stack: "Error: x" }));
    expect(res.status).toBe(400);

    const countAfter = await prisma.errorLog.count({ where: { route: "client" } });
    expect(countAfter).toBe(countBefore);
  });

  it("rejects a whitespace-only message (400)", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ message: "   " }));
    expect(res.status).toBe(400);
  });

  it("unauthenticated request: still logs the error, with userId null", async () => {
    mockedGetSession.mockResolvedValue(null);
    const message = `${testRoute}-anonymous`;

    const res = await POST(makeRequest({ message, stack: "Error: boom\n  at x" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true });

    const row = await prisma.errorLog.findFirst({ where: { route: "client", message }, orderBy: { id: "desc" } });
    expect(row).not.toBeNull();
    expect(row!.userId).toBeNull();
    expect(row!.stack).toContain("boom");
  });

  it("authenticated request: logs the error with the session's userId attached", async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-LOG-ERROR-USER-${Date.now()}` } });
    mockedGetSession.mockResolvedValue({ userId: user.id, onboarded: true, role: "user" });
    const message = `${testRoute}-authenticated`;

    const res = await POST(makeRequest({ message }));
    expect(res.status).toBe(200);

    const row = await prisma.errorLog.findFirst({ where: { route: "client", message }, orderBy: { id: "desc" } });
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(user.id);

    await prisma.errorLog.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("stack is optional - omitting it still succeeds and stores null", async () => {
    mockedGetSession.mockResolvedValue(null);
    const message = `${testRoute}-no-stack`;

    const res = await POST(makeRequest({ message }));
    expect(res.status).toBe(200);

    const row = await prisma.errorLog.findFirst({ where: { route: "client", message }, orderBy: { id: "desc" } });
    expect(row?.stack).toBeNull();
  });
});
