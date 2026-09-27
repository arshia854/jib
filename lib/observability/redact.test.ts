import { describe, it, expect } from "vitest";
import { redact } from "@/lib/observability/redact";

describe("redact", () => {
  it("passes through non-object values unchanged", () => {
    expect(redact("hello")).toBe("hello");
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it("masks a top-level sensitive key, case-insensitively", () => {
    expect(redact({ password: "hunter2" })).toEqual({ password: "[REDACTED]" });
    expect(redact({ PASSWORD: "hunter2" })).toEqual({ PASSWORD: "[REDACTED]" });
    expect(redact({ Token: "abc" })).toEqual({ Token: "[REDACTED]" });
  });

  it("masks every keyword from the Phase 12 spec list", () => {
    const input = {
      password: "a",
      token: "b",
      creditCard: "c",
      ssn: "d",
      cvv: "e",
      secret: "f",
      apiKey: "g",
    };
    expect(redact(input)).toEqual({
      password: "[REDACTED]",
      token: "[REDACTED]",
      creditCard: "[REDACTED]",
      ssn: "[REDACTED]",
      cvv: "[REDACTED]",
      secret: "[REDACTED]",
      apiKey: "[REDACTED]",
    });
  });

  it("masks a sensitive keyword embedded in a larger key name", () => {
    expect(redact({ userPassword: "x", refreshToken: "y", OTP_SECRET: "z", apiKeyValue: "w" })).toEqual({
      userPassword: "[REDACTED]",
      refreshToken: "[REDACTED]",
      OTP_SECRET: "[REDACTED]",
      apiKeyValue: "[REDACTED]",
    });
  });

  it("leaves non-sensitive keys untouched", () => {
    expect(redact({ userId: 1, amount: 5000, description: "قهوه" })).toEqual({
      userId: 1,
      amount: 5000,
      description: "قهوه",
    });
  });

  it("masks sensitive keys at any nesting depth", () => {
    const input = { a: { b: { c: { password: "deep" }, keep: "ok" } } };
    expect(redact(input)).toEqual({ a: { b: { c: { password: "[REDACTED]" }, keep: "ok" } } });
  });

  it("masks sensitive keys inside arrays of objects", () => {
    const input = [{ token: "x", name: "a" }, { name: "b" }];
    expect(redact(input)).toEqual([{ token: "[REDACTED]", name: "a" }, { name: "b" }]);
  });

  it("masks sensitive keys inside objects nested in arrays nested in objects", () => {
    const input = { users: [{ secret: "x" }, { apiKey: "y", nested: { creditCard: "z" } }] };
    expect(redact(input)).toEqual({
      users: [{ secret: "[REDACTED]" }, { apiKey: "[REDACTED]", nested: { creditCard: "[REDACTED]" } }],
    });
  });

  it("replaces the whole value under a sensitive key, even if it's an object", () => {
    const input = { token: { raw: "x", expiresAt: 123 } };
    expect(redact(input)).toEqual({ token: "[REDACTED]" });
  });

  it("does not redact a numeric field under a sensitive-looking key (token usage counts)", () => {
    expect(redact({ promptTokens: 120, completionTokens: 45, totalTokens: 165 })).toEqual({
      promptTokens: 120,
      completionTokens: 45,
      totalTokens: 165,
    });
    expect(redact({ usage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 } })).toEqual({
      usage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 },
    });
  });

  it("still fully redacts a string value under a sensitive key alongside numeric token counts", () => {
    expect(redact({ apiToken: "sk-abc123", promptTokens: 10 })).toEqual({
      apiToken: "[REDACTED]",
      promptTokens: 10,
    });
    expect(redact({ password: "hunter2" })).toEqual({ password: "[REDACTED]" });
  });

  it("does not mutate the original input", () => {
    const input = { password: "x", nested: { token: "y" } };
    const copy = JSON.parse(JSON.stringify(input));
    redact(input);
    expect(input).toEqual(copy);
  });

  it("handles a self-referencing circular object without throwing", () => {
    const input: Record<string, unknown> = { name: "a" };
    input.self = input;
    expect(() => redact(input)).not.toThrow();
    expect(redact(input)).toEqual({ name: "a", self: "[Circular]" });
  });

  it("handles a circular reference inside an array without throwing", () => {
    const input: Record<string, unknown>[] = [{ name: "a" }];
    input.push({ list: input });
    expect(() => redact(input)).not.toThrow();
    const result = redact(input) as unknown[];
    expect(result[0]).toEqual({ name: "a" });
    expect((result[1] as Record<string, unknown>).list).toBe("[Circular]");
  });

  it("does not falsely flag a shared (non-circular) reference as circular", () => {
    const shared = { name: "shared" };
    const input = { a: shared, b: shared };
    expect(redact(input)).toEqual({ a: { name: "shared" }, b: { name: "shared" } });
  });

  it("handles a two-level circular reference (A -> B -> A)", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", parent: a };
    a.child = b;
    expect(() => redact(a)).not.toThrow();
    expect(redact(a)).toEqual({ name: "a", child: { name: "b", parent: "[Circular]" } });
  });

  // Phase 6 privacy-audit addition: pattern-based (not key-based) redaction
  // of financial-identifier-shaped digit runs inside string values, at any
  // depth - closes the gap the audit found where a raw bank SMS/card
  // number sitting under an innocuous key (or inside a native error's own
  // `.message`, see lib/ai/parse-transaction.ts's extractJson()) sailed
  // straight through the old key-only implementation.
  describe("digit-shaped financial identifiers (Phase 6)", () => {
    it("redacts a bare 16-digit card number in a top-level string", () => {
      expect(redact("6104337812345678")).toBe("[REDACTED_NUMBER]");
    });

    it("redacts a card number grouped with spaces or dashes", () => {
      expect(redact("card 6104 3378 1234 5678 declined")).toBe("card [REDACTED_NUMBER] declined");
      expect(redact("card 6104-3378-1234-5678 declined")).toBe("card [REDACTED_NUMBER] declined");
    });

    it("redacts a digit run written in Persian or Arabic-Indic numerals", () => {
      expect(redact("شماره کارت ۶۱۰۴۳۳۷۸۱۲۳۴۵۶۷۸ است")).toBe("شماره کارت [REDACTED_NUMBER] است");
      expect(redact("card ٦١٠٤٣٣٧٨١٢٣٤٥٦٧٨ used")).toBe("card [REDACTED_NUMBER] used");
    });

    it("redacts inside a JSON.parse-style SyntaxError message, matching the real leak this closes", () => {
      // V8's own JSON.parse SyntaxError quotes a preview of the string it
      // failed to parse - the exact mechanism behind the real leak this
      // sub-task found (lib/ai/parse-transaction.ts's extractJson()) and
      // the sample log line the Phase 6 report cites. A short malformed
      // "AI response" reproduces it without truncation kicking in.
      let message = "";
      try {
        JSON.parse("prefix 610433781234");
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).toContain("610433781234");
      expect(redact(message)).not.toContain("610433781234");
      expect(redact(message)).toContain("[REDACTED_NUMBER]");
    });

    it("redacts digit runs nested inside an object's string values, not just its keys", () => {
      expect(redact({ rawInput: "پرداخت با کارت 6104337812345678 انجام شد" })).toEqual({
        rawInput: "پرداخت با کارت [REDACTED_NUMBER] انجام شد",
      });
    });

    it("does not redact short numbers that aren't identifier-shaped", () => {
      expect(redact("قهوه 50000 تومان")).toBe("قهوه 50000 تومان");
      expect(redact("session 12345678")).toBe("session 12345678"); // 8 digits, below the 9-digit floor
    });

    it("leaves numeric (non-string) fields untouched regardless of digit count", () => {
      expect(redact({ duration: 123456789, userId: 42 })).toEqual({ duration: 123456789, userId: 42 });
    });
  });
});
