import { describe, it, expect } from "vitest";
import {
  combineConfidence,
  extractionConfidenceForBankSms,
  categorizationConfidenceForMerchantMatch,
  EXTRACTION_CONFIDENCE_DETERMINISTIC,
  EXTRACTION_CONFIDENCE_AI,
  CATEGORIZATION_CONFIDENCE_NONE,
  type ConfidenceLevel,
} from "@/lib/ai/confidence";

describe("combineConfidence (overall = the weaker of the two halves)", () => {
  const LEVELS: ConfidenceLevel[] = ["low", "medium", "high"];

  it.each([
    ["high", "high", "high"],
    ["high", "medium", "medium"],
    ["high", "low", "low"],
    ["medium", "high", "medium"],
    ["medium", "medium", "medium"],
    ["medium", "low", "low"],
    ["low", "high", "low"],
    ["low", "medium", "low"],
    ["low", "low", "low"],
  ] as const)("combineConfidence(%s, %s) -> %s", (extraction, categorization, expected) => {
    expect(combineConfidence(extraction, categorization)).toBe(expected);
  });

  it("is symmetric - argument order never changes the result", () => {
    for (const a of LEVELS) {
      for (const b of LEVELS) {
        expect(combineConfidence(a, b)).toBe(combineConfidence(b, a));
      }
    }
  });
});

describe("extractionConfidenceForBankSms", () => {
  it("returns high when every one of the winning bank's detection rules matched (bankConfidence 1)", () => {
    expect(extractionConfidenceForBankSms(1)).toBe("high");
  });

  it("returns medium when only some of the winning bank's rules matched (a partial, still-accepted match)", () => {
    expect(extractionConfidenceForBankSms(0.6)).toBe("medium");
  });

  it("returns medium just below the full-confidence boundary", () => {
    expect(extractionConfidenceForBankSms(0.999)).toBe("medium");
  });
});

describe("categorizationConfidenceForMerchantMatch", () => {
  it("returns high for a user-historical mapping match, regardless of tier", () => {
    expect(categorizationConfidenceForMerchantMatch("userMapping", 1)).toBe("high");
    expect(categorizationConfidenceForMerchantMatch("userMapping", 3)).toBe("high");
    expect(categorizationConfidenceForMerchantMatch("userMapping", undefined)).toBe("high");
  });

  it("returns high for a keyword override, which is never tier-based", () => {
    expect(categorizationConfidenceForMerchantMatch("keyword", undefined)).toBe("high");
  });

  it("returns high for an exact (tier 1) global merchant match", () => {
    expect(categorizationConfidenceForMerchantMatch("globalMerchant", 1)).toBe("high");
  });

  it("returns medium for an alias (tier 2) global merchant match", () => {
    expect(categorizationConfidenceForMerchantMatch("globalMerchant", 2)).toBe("medium");
  });

  it("returns medium for a loose-substring (tier 3) global merchant match", () => {
    expect(categorizationConfidenceForMerchantMatch("globalMerchant", 3)).toBe("medium");
  });
});

describe("named constants", () => {
  it("the deterministic extraction constant is high", () => {
    expect(EXTRACTION_CONFIDENCE_DETERMINISTIC).toBe("high");
  });

  it("the AI-extraction constant is medium, never high", () => {
    expect(EXTRACTION_CONFIDENCE_AI).toBe("medium");
  });

  it("the no-categorization-signal constant is low", () => {
    expect(CATEGORIZATION_CONFIDENCE_NONE).toBe("low");
  });
});
