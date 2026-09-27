import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createOtpChallenge,
  generateOtpCode,
  getOtpChallengePhone,
  sendOtpSms,
  verifyOtpChallenge,
  MAX_ATTEMPTS,
  MAX_CHALLENGES,
  OTP_TTL_SECONDS,
} from "@/lib/auth/otp";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("generateOtpCode", () => {
  it("returns a 6-digit numeric string within [100000, 999999]", () => {
    for (let i = 0; i < 500; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
      const value = Number(code);
      expect(value).toBeGreaterThanOrEqual(100000);
      expect(value).toBeLessThanOrEqual(999999);
    }
  });

  it("is not hardcoded to a single value across repeated calls", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateOtpCode()));
    // A CSPRNG over a 900000-value range producing the same code 50/50 times
    // would indicate it's broken, not just unlucky.
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("createOtpChallenge / getOtpChallengePhone / verifyOtpChallenge", () => {
  const TTL_MS = OTP_TTL_SECONDS * 1000;

  it("returns an opaque random id that reveals neither the code nor the phone", () => {
    const id = createOtpChallenge("09123456789", "654321");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toContain("654321");
    expect(id).not.toContain("09123456789");
    expect(createOtpChallenge("09123456789", "654321")).not.toBe(id);
  });

  it("correct code: returns the phone, and the challenge is single-use", () => {
    const id = createOtpChallenge("09123456789", "654321");
    expect(getOtpChallengePhone(id)).toBe("09123456789");
    expect(verifyOtpChallenge(id, "654321")).toEqual({ status: "ok", phone: "09123456789" });
    expect(getOtpChallengePhone(id)).toBeNull();
    expect(verifyOtpChallenge(id, "654321")).toEqual({ status: "expired" });
  });

  it("starts at 0 attempts: MAX_ATTEMPTS wrong codes, then max_attempts, then the challenge is gone", () => {
    const id = createOtpChallenge("09123456789", "654321");
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      expect(verifyOtpChallenge(id, "000000")).toEqual({ status: "wrong_code", remainingAttempts: MAX_ATTEMPTS - i });
    }
    // Locked out even with the correct code.
    expect(verifyOtpChallenge(id, "654321")).toEqual({ status: "max_attempts" });
    expect(verifyOtpChallenge(id, "654321")).toEqual({ status: "expired" });
  });

  it("expires after OTP_TTL_SECONDS", () => {
    const t0 = Date.now();
    const id = createOtpChallenge("09123456789", "654321", t0);
    expect(getOtpChallengePhone(id, t0 + TTL_MS - 1)).toBe("09123456789");
    expect(getOtpChallengePhone(id, t0 + TTL_MS)).toBeNull();
    expect(verifyOtpChallenge(id, "654321", t0 + TTL_MS)).toEqual({ status: "expired" });
  });

  it("expires after OTP_TTL_SECONDS under fake timers (default now)", () => {
    vi.useFakeTimers();
    const id = createOtpChallenge("09123456789", "654321");
    vi.advanceTimersByTime((OTP_TTL_SECONDS + 5) * 1000);
    expect(verifyOtpChallenge(id, "654321")).toEqual({ status: "expired" });
  });

  it("a wrong code restarts the TTL (matches the old re-signed-cookie behavior)", () => {
    const t0 = Date.now();
    const id = createOtpChallenge("09123456789", "654321", t0);
    const tWrong = t0 + TTL_MS - 1000;
    expect(verifyOtpChallenge(id, "000000", tWrong).status).toBe("wrong_code");
    expect(verifyOtpChallenge(id, "654321", tWrong + TTL_MS - 1)).toEqual({ status: "ok", phone: "09123456789" });
  });

  it("unknown/garbage/empty ids are treated as expired", () => {
    expect(getOtpChallengePhone("not-a-real-id")).toBeNull();
    expect(getOtpChallengePhone("")).toBeNull();
    expect(verifyOtpChallenge("not-a-real-id", "654321")).toEqual({ status: "expired" });
  });

  it("a code of a different length is a wrong code, not a thrown error", () => {
    const id = createOtpChallenge("09123456789", "654321");
    expect(verifyOtpChallenge(id, "65432")).toEqual({ status: "wrong_code", remainingAttempts: MAX_ATTEMPTS - 1 });
    expect(verifyOtpChallenge(id, "6543210")).toEqual({ status: "wrong_code", remainingAttempts: MAX_ATTEMPTS - 2 });
  });

  it(`never holds more than MAX_CHALLENGES (${MAX_CHALLENGES}) live challenges: the oldest is evicted`, () => {
    const now = Date.now();
    const first = createOtpChallenge("09120000000", "111111", now);
    let last = first;
    for (let i = 0; i < MAX_CHALLENGES; i++) last = createOtpChallenge("09120000001", "222222", now);
    expect(getOtpChallengePhone(first, now)).toBeNull();
    expect(getOtpChallengePhone(last, now)).toBe("09120000001");
  });
});

describe("sendOtpSms", () => {
  it("in production, without Melipayamak configured: fails closed and never logs the code", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MELIPAYAMAK_USERNAME", "");
    vi.stubEnv("MELIPAYAMAK_PASSWORD", "");
    vi.stubEnv("MELIPAYAMAK_BODY_ID", "");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendOtpSms("09123456789", "654321");

    expect(result).toEqual({ success: false, error: "SMS provider is not configured" });
    expect(logSpy).not.toHaveBeenCalled();
    const allErrorOutput = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(allErrorOutput).not.toContain("654321");
    // Only the last 4 digits of the phone, never the full number.
    expect(allErrorOutput).not.toContain("09123456789");
    expect(allErrorOutput).toContain("6789");
  });

  it("with Melipayamak configured, a failed send logs only the phone's last 4 digits", async () => {
    vi.stubEnv("MELIPAYAMAK_USERNAME", "user");
    vi.stubEnv("MELIPAYAMAK_PASSWORD", "pass");
    vi.stubEnv("MELIPAYAMAK_BODY_ID", "123");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendOtpSms("09123456789", "654321");

    expect(result).toEqual({ success: false, error: "Melipayamak HTTP 500" });
    const allErrorOutput = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(allErrorOutput).toContain("Melipayamak HTTP 500");
    expect(allErrorOutput).not.toContain("09123456789");
    expect(allErrorOutput).toContain("6789");
  });

  it("outside production, without Melipayamak configured: falls back to console logging (dev UX)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MELIPAYAMAK_USERNAME", "");
    vi.stubEnv("MELIPAYAMAK_PASSWORD", "");
    vi.stubEnv("MELIPAYAMAK_BODY_ID", "");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await sendOtpSms("09123456789", "654321");

    expect(result).toEqual({ success: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0].join(" ")).toContain("654321");
  });
});
