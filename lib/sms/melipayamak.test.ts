import { describe, it, expect, vi, afterEach } from "vitest";
import { isMelipayamakConfigured, sendOtpViaMelipayamak } from "@/lib/sms/melipayamak";

function stubCredentials() {
  vi.stubEnv("MELIPAYAMAK_USERNAME", "test-user");
  vi.stubEnv("MELIPAYAMAK_PASSWORD", "test-pass");
  vi.stubEnv("MELIPAYAMAK_BODY_ID", "12345");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("isMelipayamakConfigured", () => {
  it("returns false when no credentials are set", () => {
    expect(isMelipayamakConfigured()).toBe(false);
  });

  it("returns false when only some credentials are set", () => {
    vi.stubEnv("MELIPAYAMAK_USERNAME", "test-user");
    vi.stubEnv("MELIPAYAMAK_PASSWORD", "test-pass");
    expect(isMelipayamakConfigured()).toBe(false);
  });

  it("returns true once username, password, and bodyId are all set", () => {
    stubCredentials();
    expect(isMelipayamakConfigured()).toBe(true);
  });
});

describe("sendOtpViaMelipayamak", () => {
  it("fails without calling fetch when credentials are not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendOtpViaMelipayamak("09123456789", "123456");

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the code as the pattern text and reports success on RetStatus 1", async () => {
    stubCredentials();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ RetStatus: 1, Value: "998877", StrRetStatus: "Success" }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendOtpViaMelipayamak("09123456789", "123456");

    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://rest.payamak-panel.com/api/SendSMS/BaseServiceNumber");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      username: "test-user",
      password: "test-pass",
      to: "09123456789",
      bodyId: "12345",
      text: "123456",
    });
  });

  it("fails when the HTTP response is not ok", async () => {
    stubCredentials();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

    const result = await sendOtpViaMelipayamak("09123456789", "123456");

    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });

  it("fails when Melipayamak reports a non-success RetStatus", async () => {
    stubCredentials();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ RetStatus: 35, StrRetStatus: "نام کاربری یا رمز عبور اشتباه است" }), {
          status: 200,
        })
      )
    );

    const result = await sendOtpViaMelipayamak("09123456789", "123456");

    expect(result.success).toBe(false);
    expect(result.error).toContain("نام کاربری یا رمز عبور اشتباه است");
  });

  it("fails gracefully instead of throwing when fetch rejects", async () => {
    stubCredentials();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(sendOtpViaMelipayamak("09123456789", "123456")).resolves.toEqual({
      success: false,
      error: "network down",
    });
  });
});
