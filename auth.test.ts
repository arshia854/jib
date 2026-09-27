import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// next/headers' cookies() throws "called outside a request scope" when
// invoked directly (confirmed empirically - not something this codebase's
// existing route tests had to deal with before, since none of them call a
// route handler that touches cookies() for real). Mocked with a small
// in-memory jar so authorizePhoneOtp's cookie reads/writes/deletes are
// directly assertable, the same spirit as this codebase's other full-module
// vi.mock() replacements (see app/api/chat/route.test.ts's @/lib/nvidia-ai
// mock) rather than a partial/importActual mock.
const cookieJar = new Map<string, string>();
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

// The signIn callback lives inline in the NextAuth({...}) config (unlike
// authorizePhoneOtp, it was never extracted), and NextAuth doesn't expose
// its config's callbacks on what it returns. A pass-through mock records the
// config object auth.ts hands to the real NextAuth() so the callback can be
// called directly - NextAuth itself still runs unmodified.
const nextAuthConfig = vi.hoisted(() => ({ current: null as null | { callbacks: Record<string, (...args: never[]) => unknown> } }));
vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return {
    ...actual,
    default: (config: Parameters<typeof actual.default>[0]) => {
      nextAuthConfig.current = config as typeof nextAuthConfig.current;
      return actual.default(config);
    },
  };
});

// Pass-through spy: real bcrypt behavior unchanged, just lets the
// email-password timing tests below confirm a compare actually ran.
vi.mock("@/lib/auth/password", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/password")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { authorizePhoneOtp, DUMMY_PASSWORD_HASH } from "@/auth";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createOtpChallenge, OTP_COOKIE, MAX_ATTEMPTS } from "@/lib/auth/otp";
import {
  OtpExpiredError,
  OtpMaxAttemptsError,
  OtpRateLimitedError,
  OtpInvalidFormatError,
  OtpWrongCodeError,
  InvalidEmailPasswordError,
} from "@/lib/auth/errors";

const DUMMY_REQUEST = new Request("http://localhost/api/auth/callback/phone-otp");

// Every test uses its own phone number so OTP_VERIFY_PHONE_RULE's per-phone
// rate-limit counter (lib/rate-limit.ts, a module-level in-memory Map that
// persists for the whole process) can't make one test's calls count against
// another's - same convention as app/api/auth/register/route.test.ts's
// per-test X-Real-IP.
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `0912${String(1000000 + phoneCounter).slice(-7)}`;
}

// Issues a fresh server-side challenge (attempts = 0) and sets its id as
// the cookie, exactly as app/api/auth/send-otp/route.ts does. Returns the
// id so tests can replay it.
function setOtpCookie(phone: string, code: string): string {
  const challengeId = createOtpChallenge(phone, code);
  cookieJar.set(OTP_COOKIE, challengeId);
  return challengeId;
}

const createdPhones: string[] = [];
const createdEmails: string[] = [];

afterAll(async () => {
  if (createdPhones.length) {
    await prisma.user.deleteMany({ where: { phoneNumber: { in: createdPhones } } });
  }
  if (createdEmails.length) {
    // Account rows cascade-delete with their User (schema.prisma).
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
  }
  await prisma.$disconnect();
});

beforeEach(() => {
  cookieJar.clear();
});

describe("authorizePhoneOtp - the phone-otp provider's OTP state machine", () => {
  it("valid code, first user for this phone: creates a user and signs in", async () => {
    const phone = nextPhone();
    createdPhones.push(phone);
    setOtpCookie(phone, "111222");

    const user = await authorizePhoneOtp({ code: "111222" }, DUMMY_REQUEST);

    expect(user).toMatchObject({ phoneNumber: phone });
    const row = await prisma.user.findUnique({ where: { phoneNumber: phone } });
    expect(row).not.toBeNull();
    expect(String(row!.id)).toBe(user!.id);
  });

  it("valid code, returning user: signs in without creating a second row", async () => {
    const phone = nextPhone();
    createdPhones.push(phone);
    const existing = await prisma.user.create({ data: { phoneNumber: phone } });

    setOtpCookie(phone, "333444");
    const user = await authorizePhoneOtp({ code: "333444" }, DUMMY_REQUEST);

    expect(user!.id).toBe(String(existing.id));
    const count = await prisma.user.count({ where: { phoneNumber: phone } });
    expect(count).toBe(1);
  });

  it("the OTP cookie is deleted after a successful sign-in (a resubmitted/reused code is rejected as expired)", async () => {
    const phone = nextPhone();
    createdPhones.push(phone);
    setOtpCookie(phone, "555666");

    await authorizePhoneOtp({ code: "555666" }, DUMMY_REQUEST);
    expect(cookieJar.has(OTP_COOKIE)).toBe(false);

    // Reusing the same code (as if resubmitted) now finds no cookie at
    // all - same as a genuinely expired one.
    await expect(authorizePhoneOtp({ code: "555666" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpExpiredError);
  });

  it("a challenge is single-use: replaying its cookie after a successful sign-in is rejected as expired", async () => {
    const phone = nextPhone();
    createdPhones.push(phone);
    const challengeId = setOtpCookie(phone, "565656");

    await authorizePhoneOtp({ code: "565656" }, DUMMY_REQUEST);

    // Attacker re-sends the captured cookie with the known-good code.
    cookieJar.set(OTP_COOKIE, challengeId);
    await expect(authorizePhoneOtp({ code: "565656" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpExpiredError);
  });

  it("rejects a code that isn't 6 digits, before ever reading the cookie", async () => {
    await expect(authorizePhoneOtp({ code: "123" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpInvalidFormatError);
    await expect(authorizePhoneOtp({ code: "abcdef" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpInvalidFormatError);
    await expect(authorizePhoneOtp(undefined, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpInvalidFormatError);
  });

  it("no OTP cookie at all: rejects as expired", async () => {
    await expect(authorizePhoneOtp({ code: "999999" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpExpiredError);
  });

  it("expired token: rejects as expired", async () => {
    vi.useFakeTimers();
    try {
      const phone = nextPhone();
      setOtpCookie(phone, "777888");
      vi.advanceTimersByTime(121 * 1000); // OTP_TTL_SECONDS is 120

      await expect(authorizePhoneOtp({ code: "777888" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpExpiredError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wrong code: rejects, keeps the same challenge cookie with attempts incremented server-side, and reports remaining attempts", async () => {
    const phone = nextPhone();
    const challengeId = setOtpCookie(phone, "246810");

    await expect(authorizePhoneOtp({ code: "000000" }, DUMMY_REQUEST)).rejects.toMatchObject({
      code: `otp_wrong_${MAX_ATTEMPTS - 1}`,
    });

    // The cookie is kept (not deleted) and still points at the same
    // challenge, so the *same* correct code still works on the next try.
    expect(cookieJar.get(OTP_COOKIE)).toBe(challengeId);
    const user = await authorizePhoneOtp({ code: "246810" }, DUMMY_REQUEST);
    expect(user).toMatchObject({ phoneNumber: phone });
    createdPhones.push(phone);
  });

  it("too many wrong attempts: locks out with OtpMaxAttemptsError and deletes the cookie", async () => {
    const phone = nextPhone();
    setOtpCookie(phone, "135791");

    // MAX_ATTEMPTS wrong guesses, each reporting the remaining count...
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await expect(authorizePhoneOtp({ code: "000000" }, DUMMY_REQUEST)).rejects.toMatchObject({
        code: `otp_wrong_${MAX_ATTEMPTS - i}`,
      });
    }

    // ...then the next submission is locked out, and the cookie deleted.
    await expect(authorizePhoneOtp({ code: "000000" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpMaxAttemptsError);
    expect(cookieJar.has(OTP_COOKIE)).toBe(false);

    // Locked out even with the *correct* code, since the challenge is now
    // gone (same as no cookie / expired).
    await expect(authorizePhoneOtp({ code: "135791" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpExpiredError);
  });

  it("replaying an earlier copy of the cookie does not reset the attempt count", async () => {
    const phone = nextPhone();
    const originalChallengeId = setOtpCookie(phone, "864208");

    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      // Restore the cookie as it was before any attempts - with the old
      // client-held counter this reset attempts to 0 every time.
      cookieJar.set(OTP_COOKIE, originalChallengeId);
      await expect(authorizePhoneOtp({ code: "000000" }, DUMMY_REQUEST)).rejects.toMatchObject({
        code: `otp_wrong_${MAX_ATTEMPTS - i}`,
      });
    }

    cookieJar.set(OTP_COOKIE, originalChallengeId);
    await expect(authorizePhoneOtp({ code: "864208" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpMaxAttemptsError);
  });

  it("verify rate limit (OTP_VERIFY_PHONE_RULE): rejects once this phone's per-window verify attempts are exhausted", async () => {
    const phone = nextPhone();
    // OTP_VERIFY_PHONE_RULE allows 8 attempts / 15 min for this phone.
    // Wrong-code attempts each still consume one unit of this limit before
    // the wrong-code check itself rejects, so 8 consecutive wrong guesses
    // exhausts it. A fresh challenge (attempts = 0) is issued on every
    // iteration so MAX_ATTEMPTS' own separate per-code lockout (tested
    // above) never trips here - this test isolates the rate limit
    // specifically.
    for (let i = 0; i < 8; i++) {
      setOtpCookie(phone, "424242");
      await expect(authorizePhoneOtp({ code: "000000" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpWrongCodeError);
    }

    // The 9th attempt against this same phone - even with the correct code
    // and a fresh challenge - is blocked by the rate limit before the code
    // is even compared.
    setOtpCookie(phone, "424242");
    await expect(authorizePhoneOtp({ code: "424242" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpRateLimitedError);
  });
});

describe("signIn callback - Google auto-linking to an existing email account", () => {
  let emailCounter = 0;
  function nextEmail(): string {
    emailCounter += 1;
    const email = `google-link-${Date.now()}-${emailCounter}@example.com`;
    createdEmails.push(email);
    return email;
  }

  function googleSignIn(email: string, providerAccountId: string) {
    const signInCallback = nextAuthConfig.current!.callbacks.signIn as unknown as (params: unknown) => Promise<boolean | string>;
    return signInCallback({
      user: { email },
      account: { provider: "google", type: "oidc", providerAccountId, access_token: "tok", token_type: "bearer" },
      profile: { email, email_verified: true },
    });
  }

  it("existing account with a password but no verified email (attacker-registered shell): refuses, no Account row created", async () => {
    const email = nextEmail();
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword("attacker-chosen-pw") } });

    await expect(googleSignIn(email, `g-${email}`)).resolves.toBe(false);

    expect(await prisma.account.count({ where: { userId: user.id } })).toBe(0);
  });

  it("existing passwordless account: still auto-links Google", async () => {
    const email = nextEmail();
    const user = await prisma.user.create({ data: { email } });

    await expect(googleSignIn(email, `g-${email}`)).resolves.toBe(true);

    const accounts = await prisma.account.findMany({ where: { userId: user.id } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ provider: "google", providerAccountId: `g-${email}` });
  });

  it("existing account with a password AND a verified email: still auto-links Google", async () => {
    const email = nextEmail();
    const user = await prisma.user.create({
      data: { email, passwordHash: await hashPassword("owner-pw-123"), emailVerified: new Date() },
    });

    await expect(googleSignIn(email, `g-${email}`)).resolves.toBe(true);

    expect(await prisma.account.count({ where: { userId: user.id, provider: "google" } })).toBe(1);
  });
});

// Same approach as the signIn callback tests above: the email-password
// authorize() is inline in the NextAuth({...}) config, and Auth.js's
// Credentials() keeps the config it was given (including authorize) on the
// provider's `options`.
function emailPasswordAuthorize() {
  const providers = (nextAuthConfig.current as unknown as { providers: { options?: { id?: string; authorize?: unknown } }[] })
    .providers;
  const provider = providers.find((p) => p.options?.id === "email-password");
  return provider!.options!.authorize as (credentials: Record<string, unknown>, request: Request) => Promise<unknown>;
}

describe("email-password authorize - no timing difference for unknown emails", () => {
  const mockedVerifyPassword = vi.mocked(verifyPassword);
  const request = new Request("http://localhost/api/auth/callback/email-password", {
    headers: { "X-Real-IP": "10.77.0.1" },
  });

  it("DUMMY_PASSWORD_HASH is a valid bcrypt hash at the same cost as real password hashes", async () => {
    const realHash = await hashPassword("any-password");
    expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(bcrypt.getRounds(realHash));
  }, 20_000);

  it("unregistered email: still runs a bcrypt compare (against the dummy hash) before rejecting", async () => {
    mockedVerifyPassword.mockClear();
    await expect(
      emailPasswordAuthorize()({ email: `no-such-user-${Date.now()}@example.com`, password: "whatever123" }, request)
    ).rejects.toBeInstanceOf(InvalidEmailPasswordError);
    expect(mockedVerifyPassword).toHaveBeenCalledTimes(1);
    expect(mockedVerifyPassword).toHaveBeenCalledWith("whatever123", DUMMY_PASSWORD_HASH);
  }, 20_000);

  it("registered email with no password (e.g. Google-only): same dummy compare, same error", async () => {
    const email = `google-only-timing-${Date.now()}@example.com`;
    const user = await prisma.user.create({ data: { email } });
    try {
      mockedVerifyPassword.mockClear();
      await expect(emailPasswordAuthorize()({ email, password: "whatever123" }, request)).rejects.toBeInstanceOf(
        InvalidEmailPasswordError
      );
      expect(mockedVerifyPassword).toHaveBeenCalledTimes(1);
      expect(mockedVerifyPassword).toHaveBeenCalledWith("whatever123", DUMMY_PASSWORD_HASH);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  }, 20_000);
});
