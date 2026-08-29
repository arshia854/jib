import { describe, it, expect, vi, afterEach } from "vitest";
import { createOtpToken, generateOtpCode, sendOtpSms, verifyOtpToken, OTP_TTL_SECONDS } from "@/lib/auth/otp";

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

describe("createOtpToken / verifyOtpToken", () => {
  it("round-trips phone, code, and attempts through a signed token", async () => {
    const token = await createOtpToken("09123456789", "654321", 2);
    const payload = await verifyOtpToken(token);
    expect(payload).toEqual({ phone: "09123456789", code: "654321", attempts: 2 });
  });

  it("defaults attempts to 0 when not provided", async () => {
    const token = await createOtpToken("09123456789", "654321");
    const payload = await verifyOtpToken(token);
    expect(payload?.attempts).toBe(0);
  });

  it("returns null for an expired token", async () => {
    vi.useFakeTimers();
    const token = await createOtpToken("09123456789", "654321");
    vi.advanceTimersByTime((OTP_TTL_SECONDS + 5) * 1000);
    const payload = await verifyOtpToken(token);
    expect(payload).toBeNull();
  });

  it("returns null for a garbage/malformed token", async () => {
    const payload = await verifyOtpToken("not.a.valid-jwt");
    expect(payload).toBeNull();
  });

  it("returns null for a tampered token", async () => {
    const token = await createOtpToken("09123456789", "654321");
    const tampered = token.slice(0, -2) + (token.slice(-2) === "aa" ? "bb" : "aa");
    const payload = await verifyOtpToken(tampered);
    expect(payload).toBeNull();
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
