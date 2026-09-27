import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/auth/register/route";
import { MAX_EMAIL_LENGTH, MAX_PASSWORD_BYTES } from "@/lib/limits";

// Each test uses its own X-Real-IP so EMAIL_REGISTER_IP_RULE's per-IP
// counter (lib/rate-limit.ts) can't make one test's call count against
// another's.
let ipCounter = 0;
function makeRequest(body: unknown): NextRequest {
  ipCounter += 1;
  return new NextRequest("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Real-IP": `10.0.0.${ipCounter}` },
    body: JSON.stringify(body),
  });
}

const createdEmails: string[] = [];

afterAll(async () => {
  if (createdEmails.length) {
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
  }
});

describe("POST /api/auth/register - length limits", () => {
  it("rejects an email over MAX_EMAIL_LENGTH (400)", async () => {
    const localPart = "a".repeat(MAX_EMAIL_LENGTH);
    const email = `${localPart}@example.com`;
    expect(email.length).toBeGreaterThan(MAX_EMAIL_LENGTH);
    const res = await POST(makeRequest({ email, password: "validpass123" }));
    expect(res.status).toBe(400);
  });

  it("rejects a password whose UTF-8 byte length exceeds MAX_PASSWORD_BYTES (400)", async () => {
    // Persian text is multi-byte in UTF-8, so this hits the 72-byte cap
    // well before 72 *characters* - this is exactly the gap a character-
    // length check would miss.
    const password = "پ".repeat(40); // 2 bytes/char in UTF-8 -> 80 bytes, > 72
    expect(Buffer.byteLength(password, "utf8")).toBeGreaterThan(MAX_PASSWORD_BYTES);
    const res = await POST(makeRequest({ email: "toolongpassword@example.com", password }));
    expect(res.status).toBe(400);
  });

  it("accepts a password exactly at MAX_PASSWORD_BYTES (200) and does not reject legitimate registration", async () => {
    const email = "within-limits@example.com";
    createdEmails.push(email);
    const password = "a".repeat(MAX_PASSWORD_BYTES); // 1 byte/char in ASCII -> exactly 72 bytes
    const res = await POST(makeRequest({ email, password }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/auth/register - existing email", () => {
  it("returns the identical 409 message whether the existing account has a password or not (no sign-up-method probing)", async () => {
    const withPassword = `existing-password-${Date.now()}@example.com`;
    const withoutPassword = `existing-google-only-${Date.now()}@example.com`;
    createdEmails.push(withPassword, withoutPassword);
    // The stored hash is never compared on this path, so any non-null
    // string stands in for a real one.
    await prisma.user.create({ data: { email: withPassword, passwordHash: "not-a-real-hash" } });
    await prisma.user.create({ data: { email: withoutPassword } });

    const resA = await POST(makeRequest({ email: withPassword, password: "validpass123" }));
    const resB = await POST(makeRequest({ email: withoutPassword, password: "validpass123" }));

    expect(resA.status).toBe(409);
    expect(resB.status).toBe(409);
    const [dataA, dataB] = [await resA.json(), await resB.json()];
    expect(dataA).toEqual(dataB);
    expect(dataA.error).toBe("این ایمیل قبلاً ثبت‌نام شده است.");
  });
});
