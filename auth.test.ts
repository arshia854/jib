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

import { prisma } from "@/lib/prisma";
import { authorizePhoneOtp } from "@/auth";
import { createOtpToken, OTP_COOKIE, MAX_ATTEMPTS } from "@/lib/auth/otp";
import {
  OtpExpiredError,
  OtpMaxAttemptsError,
  OtpRateLimitedError,
  OtpInvalidFormatError,
  OtpWrongCodeError,
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

async function setOtpCookie(phone: string, code: string, attempts = 0) {
  const token = await createOtpToken(phone, code, attempts);
  cookieJar.set(OTP_COOKIE, token);
}

const createdPhones: string[] = [];

afterAll(async () => {
  if (createdPhones.length) {
    await prisma.user.deleteMany({ where: { phoneNumber: { in: createdPhones } } });
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
    await setOtpCookie(phone, "111222");

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

    await setOtpCookie(phone, "333444");
    const user = await authorizePhoneOtp({ code: "333444" }, DUMMY_REQUEST);

    expect(user!.id).toBe(String(existing.id));
    const count = await prisma.user.count({ where: { phoneNumber: phone } });
    expect(count).toBe(1);
  });

  it("the OTP cookie is deleted after a successful sign-in (a resubmitted/reused code is rejected as expired)", async () => {
    const phone = nextPhone();
    createdPhones.push(phone);
    await setOtpCookie(phone, "555666");

    await authorizePhoneOtp({ code: "555666" }, DUMMY_REQUEST);
    expect(cookieJar.has(OTP_COOKIE)).toBe(false);

    // Reusing the same code (as if resubmitted) now finds no cookie at
    // all - same as a genuinely expired one.
    await expect(authorizePhoneOtp({ code: "555666" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpExpiredError);
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
      const token = await createOtpToken(phone, "777888");
      cookieJar.set(OTP_COOKIE, token);
      vi.advanceTimersByTime(121 * 1000); // OTP_TTL_SECONDS is 120

      await expect(authorizePhoneOtp({ code: "777888" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpExpiredError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wrong code: rejects, re-signs the cookie with attempts incremented, and reports remaining attempts", async () => {
    const phone = nextPhone();
    await setOtpCookie(phone, "246810", 0);

    await expect(authorizePhoneOtp({ code: "000000" }, DUMMY_REQUEST)).rejects.toMatchObject({
      code: `otp_wrong_${MAX_ATTEMPTS - 1}`,
    });

    // The cookie was re-signed (not deleted) with attempts + 1, so the
    // *same* correct code still works on the very next try.
    expect(cookieJar.has(OTP_COOKIE)).toBe(true);
    const user = await authorizePhoneOtp({ code: "246810" }, DUMMY_REQUEST);
    expect(user).toMatchObject({ phoneNumber: phone });
    createdPhones.push(phone);
  });

  it("too many wrong attempts: locks out with OtpMaxAttemptsError and deletes the cookie", async () => {
    const phone = nextPhone();
    // Cookie already carries MAX_ATTEMPTS prior wrong attempts (as if the
    // last MAX_ATTEMPTS - 1 wrong-code rejections already happened).
    await setOtpCookie(phone, "135791", MAX_ATTEMPTS);

    await expect(authorizePhoneOtp({ code: "000000" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpMaxAttemptsError);
    expect(cookieJar.has(OTP_COOKIE)).toBe(false);

    // Locked out even with the *correct* code, since the cookie carrying
    // the attempt count is now gone (same as no cookie / expired).
    await expect(authorizePhoneOtp({ code: "135791" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpExpiredError);
  });

  it("verify rate limit (OTP_VERIFY_PHONE_RULE): rejects once this phone's per-window verify attempts are exhausted", async () => {
    const phone = nextPhone();
    // OTP_VERIFY_PHONE_RULE allows 8 attempts / 15 min for this phone.
    // Wrong-code attempts each still consume one unit of this limit before
    // the wrong-code check itself rejects, so 8 consecutive wrong guesses
    // exhausts it. attempts is deliberately reset to 0 on every iteration
    // (a fresh cookie each time) so MAX_ATTEMPTS' own separate per-code
    // lockout (tested above) never trips here - this test isolates the
    // rate limit specifically.
    for (let i = 0; i < 8; i++) {
      await setOtpCookie(phone, "424242", 0);
      await expect(authorizePhoneOtp({ code: "000000" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpWrongCodeError);
    }

    // The 9th attempt against this same phone - even with the correct code
    // and a fresh cookie - is blocked by the rate limit before the code is
    // even compared.
    await setOtpCookie(phone, "424242", 0);
    await expect(authorizePhoneOtp({ code: "424242" }, DUMMY_REQUEST)).rejects.toBeInstanceOf(OtpRateLimitedError);
  });
});
