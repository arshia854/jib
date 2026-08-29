import { describe, it, expect } from "vitest";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

describe("isPrismaErrorCode", () => {
  it("returns true for a standard Prisma error code (P2002)", () => {
    expect(isPrismaErrorCode({ code: "P2002" })).toBe(true);
  });

  it("returns true for the driver-adapter wrapper code this codebase actually sees (P2039)", () => {
    expect(isPrismaErrorCode({ code: "P2039", message: "UNIQUE constraint failed" })).toBe(true);
  });

  it("returns false for a non-Prisma-shaped error code", () => {
    expect(isPrismaErrorCode({ code: "ENOTFOUND" })).toBe(false);
  });

  it("returns false for a plain Error with no code property", () => {
    expect(isPrismaErrorCode(new Error("boom"))).toBe(false);
  });

  it("returns false for null, undefined, and primitives", () => {
    expect(isPrismaErrorCode(null)).toBe(false);
    expect(isPrismaErrorCode(undefined)).toBe(false);
    expect(isPrismaErrorCode("P2002")).toBe(false);
    expect(isPrismaErrorCode(42)).toBe(false);
  });

  it("returns false when code is not a string", () => {
    expect(isPrismaErrorCode({ code: 2002 })).toBe(false);
  });
});
