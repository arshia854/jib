import { describe, it, expect, vi, beforeEach } from "vitest";

// Same rationale as lib/data/admin-users.test.ts/lib/auth/session.test.ts:
// @/auth (NextAuth's own signOut) needs a real Next.js request context to
// run at all, and this route's own job is just "calls signOut and clears
// the legacy cookie" - so @/auth is mocked wholesale, matching this
// codebase's established convention for route tests that only need to
// assert a call happened, not exercise NextAuth's real internals (see
// auth.test.ts for the one file that does exercise a real @/auth export).
vi.mock("@/auth", () => ({
  signOut: vi.fn(async () => {}),
}));

const cookieJar = new Map<string, string>([["jeeb_session", "some-legacy-token"]]);
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  })),
}));

import { signOut } from "@/auth";
import { POST } from "@/app/api/auth/logout/route";
import { LEGACY_SESSION_COOKIE } from "@/lib/auth/session";

const mockedSignOut = vi.mocked(signOut);

beforeEach(() => {
  mockedSignOut.mockClear();
  cookieJar.set(LEGACY_SESSION_COOKIE, "some-legacy-token");
});

describe("POST /api/auth/logout", () => {
  it("calls NextAuth's signOut without a redirect", async () => {
    await POST();
    expect(mockedSignOut).toHaveBeenCalledWith({ redirect: false });
  });

  it("clears the legacy pre-NextAuth session cookie", async () => {
    expect(cookieJar.has(LEGACY_SESSION_COOKIE)).toBe(true);
    await POST();
    expect(cookieJar.has(LEGACY_SESSION_COOKIE)).toBe(false);
  });

  it("succeeds (ok: true) even when no legacy cookie was present to begin with", async () => {
    cookieJar.delete(LEGACY_SESSION_COOKIE);
    const res = await POST();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true });
  });

  it("returns { ok: true }", async () => {
    const res = await POST();
    const data = await res.json();
    expect(data).toEqual({ ok: true });
  });
});
