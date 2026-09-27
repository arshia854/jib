import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

// Phase 16: this module had zero test coverage before this session -
// small and pure enough (a thin bcryptjs wrapper) to be worth quick,
// direct coverage per the roadmap prompt's own instruction.
describe("hashPassword / verifyPassword", () => {
  it("verifyPassword returns true for the correct password against its own hash", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(verifyPassword("correct-horse-battery-staple", hash)).resolves.toBe(true);
  });

  it("verifyPassword returns false for a wrong password against a real hash", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });

  it("hashPassword salts each call - hashing the same password twice yields two different hashes", async () => {
    const hashA = await hashPassword("same-password");
    const hashB = await hashPassword("same-password");
    expect(hashA).not.toBe(hashB);
    // Both must still verify correctly, proving they're not just garbage
    // strings that happen to differ.
    await expect(verifyPassword("same-password", hashA)).resolves.toBe(true);
    await expect(verifyPassword("same-password", hashB)).resolves.toBe(true);
  });

  it("hashPassword produces a bcrypt hash (identifiable $2 prefix, not plaintext)", async () => {
    const hash = await hashPassword("whatever");
    expect(hash).not.toBe("whatever");
    expect(hash).toMatch(/^\$2[aby]?\$/);
  });

  it("is case-sensitive", async () => {
    const hash = await hashPassword("CaseSensitive123");
    await expect(verifyPassword("casesensitive123", hash)).resolves.toBe(false);
  });
});
