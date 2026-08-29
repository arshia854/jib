import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// next/headers' cookies() throws "called outside a request scope" when a
// route handler is invoked directly outside real Next.js request handling
// (confirmed empirically - see auth.test.ts's own comment on this). Mocked
// with a small in-memory jar so the OTP cookie this route sets is directly
// assertable.
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

// Only sendOtpSms is overridden (and only for the specific test that needs
// a forced failure) - everything else (generateOtpCode, createOtpToken,
// OTP_COOKIE, OTP_TTL_SECONDS, and sendOtpSms's own already-tested dev-mock
// fallback in lib/auth/otp.test.ts) stays real, so this suite tests the
// route's own logic (validation, rate limiting, cookie writing, failure
// handling) against real OTP token creation, not a hand-rolled substitute.
vi.mock("@/lib/auth/otp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/otp")>();
  return { ...actual, sendOtpSms: vi.fn(actual.sendOtpSms) };
});

import { sendOtpSms, verifyOtpToken, OTP_COOKIE } from "@/lib/auth/otp";
import { POST } from "@/app/api/auth/send-otp/route";

const mockedSendOtpSms = vi.mocked(sendOtpSms);

let ipCounter = 0;
function makeRequest(phoneNumber: string): NextRequest {
  ipCounter += 1;
  return new NextRequest("http://localhost/api/auth/send-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Real-IP": `10.1.0.${ipCounter}` },
    body: JSON.stringify({ phoneNumber }),
  });
}

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `0913${String(2000000 + phoneCounter).slice(-7)}`;
}

beforeEach(() => {
  cookieJar.clear();
  mockedSendOtpSms.mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/auth/send-otp", () => {
  it("rejects an invalid phone number (400), never calling sendOtpSms", async () => {
    const res = await POST(makeRequest("not-a-phone"));
    expect(res.status).toBe(400);
    expect(mockedSendOtpSms).not.toHaveBeenCalled();
    expect(cookieJar.has(OTP_COOKIE)).toBe(false);
  });

  it("valid phone: sends an OTP, sets a verifiable cookie, and returns ok", async () => {
    const phone = nextPhone();
    const res = await POST(makeRequest(phone));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, phoneNumber: phone });
    expect(typeof data.expiresIn).toBe("number");

    expect(cookieJar.has(OTP_COOKIE)).toBe(true);
    const payload = await verifyOtpToken(cookieJar.get(OTP_COOKIE)!);
    expect(payload?.phone).toBe(phone);
    expect(payload?.attempts).toBe(0);
  });

  it("SMS provider failure: returns 502, sets no cookie, and records an ErrorLog row (no phone number in the message)", async () => {
    mockedSendOtpSms.mockResolvedValueOnce({ success: false, error: "Melipayamak: RetStatus 35" });
    const phone = nextPhone();

    const res = await POST(makeRequest(phone));

    expect(res.status).toBe(502);
    const data = await res.json();
    expect(typeof data.error).toBe("string");
    expect(cookieJar.has(OTP_COOKIE)).toBe(false);

    const row = await prisma.errorLog.findFirst({
      where: { route: "auth/send-otp", message: "Melipayamak: RetStatus 35" },
      orderBy: { id: "desc" },
    });
    expect(row).not.toBeNull();
  });

  describe("resend cooldown (OTP_REQUEST_PHONE_RULE / OTP_REQUEST_IP_RULE)", () => {
    it("allows up to 4 requests for the same phone within the window, then 429s the 5th", async () => {
      const phone = nextPhone();
      for (let i = 0; i < 4; i++) {
        ipCounter += 1;
        const req = new NextRequest("http://localhost/api/auth/send-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Real-IP": `10.2.0.${ipCounter}` },
          body: JSON.stringify({ phoneNumber: phone }),
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
      }

      ipCounter += 1;
      const fifth = new NextRequest("http://localhost/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Real-IP": `10.2.0.${ipCounter}` },
        body: JSON.stringify({ phoneNumber: phone }),
      });
      const res = await POST(fifth);
      expect(res.status).toBe(429);
      const data = await res.json();
      expect(typeof data.retryAfterSeconds).toBe("number");
      expect(mockedSendOtpSms).toHaveBeenCalledTimes(4);
    });

    it("rejects the 16th request from the same IP within the window, regardless of phone number (OTP_REQUEST_IP_RULE)", async () => {
      ipCounter += 1;
      const ip = `10.3.0.${ipCounter}`;
      for (let i = 0; i < 15; i++) {
        const req = new NextRequest("http://localhost/api/auth/send-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Real-IP": ip },
          body: JSON.stringify({ phoneNumber: nextPhone() }),
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
      }

      const req16 = new NextRequest("http://localhost/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Real-IP": ip },
        body: JSON.stringify({ phoneNumber: nextPhone() }),
      });
      const res = await POST(req16);
      expect(res.status).toBe(429);
    });
  });
});
