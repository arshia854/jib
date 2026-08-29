import { describe, it, expect } from "vitest";
import { isValidIranianPhone, normalizePhone } from "@/lib/auth/phone";

// Phase 16: this module had zero test coverage before this session -
// small and pure enough to be worth quick, direct coverage per the
// roadmap prompt's own instruction.
describe("isValidIranianPhone", () => {
  it("accepts a well-formed Iranian mobile number", () => {
    expect(isValidIranianPhone("09123456789")).toBe(true);
  });

  it("rejects a number missing the leading 0", () => {
    expect(isValidIranianPhone("9123456789")).toBe(false);
  });

  it("rejects a number that's too short", () => {
    expect(isValidIranianPhone("0912345678")).toBe(false);
  });

  it("rejects a number that's too long", () => {
    expect(isValidIranianPhone("091234567890")).toBe(false);
  });

  it("rejects a number not starting with 09", () => {
    expect(isValidIranianPhone("08123456789")).toBe(false);
  });

  it("rejects a number containing non-digit characters", () => {
    expect(isValidIranianPhone("0912345678a")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidIranianPhone("")).toBe(false);
  });

  it("rejects a number with internal whitespace/dashes (not pre-normalized)", () => {
    expect(isValidIranianPhone("0912-345-6789")).toBe(false);
    expect(isValidIranianPhone("0912 345 6789")).toBe(false);
  });
});

describe("normalizePhone", () => {
  it("trims leading/trailing whitespace", () => {
    expect(normalizePhone("  09123456789  ")).toBe("09123456789");
  });

  it("strips internal spaces", () => {
    expect(normalizePhone("0912 345 6789")).toBe("09123456789");
  });

  it("strips internal dashes", () => {
    expect(normalizePhone("0912-345-6789")).toBe("09123456789");
  });

  it("strips both spaces and dashes together", () => {
    expect(normalizePhone(" 0912-345 6789 ")).toBe("09123456789");
  });

  it("leaves an already-clean number unchanged", () => {
    expect(normalizePhone("09123456789")).toBe("09123456789");
  });

  it("composes with isValidIranianPhone - a messy-but-valid number normalizes to something valid", () => {
    const normalized = normalizePhone(" 0912-345-6789 ");
    expect(isValidIranianPhone(normalized)).toBe(true);
  });
});
