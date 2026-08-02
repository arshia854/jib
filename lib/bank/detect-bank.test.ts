import { describe, it, expect } from "vitest";
import { detectBank } from "@/lib/bank/detect-bank";
import type { Bank } from "@/lib/bank/types";

// ---------------------------------------------------------------------------
// Plausible/representative bank SMS fixtures (from the original task spec).
// These model realistic message structure and wording but are not verified
// copies of actual received SMS — no spec document backing that claim
// exists in this repo, so treat them as representative, not confirmed-real.
// ---------------------------------------------------------------------------

const SEPAH_SMS = `بانک سپه
خريد پايانه فروش: 9,278,200
حساب :543133176713291
مانده:63,096,472`;

const TEJARAT_SMS = `بانک تجارت
حساب:0145059220990
برداشت:1,500,000 ریال
از طريق: شتاب
مانده:134,866 ریال`;

const REFAH_SMS = `بانک رفاه
حساب10029977
خرید519,500-
مانده101,853,546`;

const BLU_SMS = `بلو
برداشت پول
علی عزیز، 7,000,000 ریال از حساب شما پرید.
موجودی:17,192,269`;

// Original spec sample for Saderat: no bank name, only generic keywords.
// Scores 30 (پایانه فروش=20 + حساب:=5 + مانده=5), below MIN_CONFIDENCE_SCORE
// (50), so it correctly falls back to "unknown". This is expected — not a
// bug — until a verified Saderat SMS sample with a distinguishing signal
// shows up.
const SADERAT_ORIGINAL_SPEC_SMS = `پایانه فروش: 2,000,000-
حساب:86004
مانده:43,234,864`;

// Documented Mellat edge case: a representative SMS that omits "بانک ملت"
// entirely. mellat/melli/post/keshavarzi/maskan/shahr/karafarin all tie at
// score 15 (برداشت=10 + مانده=5), which is below MIN_CONFIDENCE_SCORE (50)
// regardless of the tie, so this correctly resolves to "unknown". This is a
// known, documented limitation of keyword-only detection without a verified
// Mellat sample to derive a structural rule from — not a bug.
const MELLAT_DOCUMENTED_EDGE_CASE_SMS = `حساب9621822033
برداشت5,960,000
مانده28,924,449
05/05/03-11:03`;

// ---------------------------------------------------------------------------
// Synthetic fixtures — bank name + generic keywords only. These exist to
// exercise detection logic before real SMS samples are available; each one
// mirrors the bank's dominant + generic rules in bank-patterns.ts exactly,
// so they win with full (1.0) confidence.
// ---------------------------------------------------------------------------

// placeholder/synthetic — replace once real SMS sample is available
const SADERAT_SYNTHETIC_SMS = `بانک صادرات
پایانه فروش: 2,000,000
حساب:86004
مانده:43,234,864`;

// placeholder/synthetic — replace once real SMS sample is available
const MELLI_SYNTHETIC_SMS = "بانک ملی برداشت مانده";

// placeholder/synthetic — replace once real SMS sample is available
const SAMAN_SYNTHETIC_SMS = "بانک سامان مانده";

// placeholder/synthetic — replace once real SMS sample is available
const PARSIAN_SYNTHETIC_SMS = "بانک پارسیان پرداخت مانده";

// placeholder/synthetic — replace once real SMS sample is available
const PASARGAD_SYNTHETIC_SMS = "بانک پاسارگاد خرید موجودی";

// placeholder/synthetic — replace once real SMS sample is available
const POST_SYNTHETIC_SMS = "پست بانک برداشت مانده";

// placeholder/synthetic — replace once real SMS sample is available
const KESHAVARZI_SYNTHETIC_SMS = "بانک کشاورزی برداشت مانده";

// placeholder/synthetic — replace once real SMS sample is available
const MASKAN_SYNTHETIC_SMS = "بانک مسکن برداشت مانده";

// placeholder/synthetic — replace once real SMS sample is available
const AYANDEH_SYNTHETIC_SMS = "بانک آینده خرید موجودی";

// placeholder/synthetic — replace once real SMS sample is available
const SHAHR_SYNTHETIC_SMS = "بانک شهر برداشت مانده";

// placeholder/synthetic — replace once real SMS sample is available
const KARAFARIN_SYNTHETIC_SMS = "بانک کارآفرین برداشت مانده";

// placeholder/synthetic — replace once real SMS sample is available
const EGHTESAD_NOVIN_SYNTHETIC_SMS = "اقتصاد نوین خرید مانده";

const UNRELATED_TEXT =
  "امروز هوا آفتابی است و قصد داریم به پارک برویم";

describe("detectBank", () => {
  describe("real SMS samples", () => {
    it("detects Sepah from a real SMS (uses Arabic Yeh: خريد پايانه فروش)", () => {
      const result = detectBank(SEPAH_SMS);
      expect(result.bank).toBe("sepah");
      expect(result.confidence).toBe(1);
      expect(result.matchedRules).toEqual([
        "sepah-bank-name",
        "sepah-pos-purchase",
      ]);
    });

    it("detects Tejarat from a real SMS (از طریق + شتاب)", () => {
      const result = detectBank(TEJARAT_SMS);
      expect(result.bank).toBe("tejarat");
      expect(result.confidence).toBe(1);
      expect(result.matchedRules).toEqual([
        "tejarat-bank-name",
        "tejarat-via-clause",
        "tejarat-shatab-channel",
      ]);
    });

    it("detects Refah from a real SMS", () => {
      const result = detectBank(REFAH_SMS);
      expect(result.bank).toBe("refah");
      expect(result.confidence).toBe(1);
      expect(result.matchedRules).toEqual([
        "refah-bank-name",
        "refah-purchase",
        "refah-account",
      ]);
    });

    it("detects Blu from a real SMS (برداشت پول + علی عزیز + از حساب شما پرید)", () => {
      const result = detectBank(BLU_SMS);
      expect(result.bank).toBe("blu");
      expect(result.confidence).toBe(1);
      expect(result.matchedRules).toEqual([
        "blu-brand-name",
        "blu-cash-withdrawal",
        "blu-personal-greeting",
        "blu-account-debit-slang",
      ]);
    });
  });

  describe("saderat (dominant بانک صادرات rule added post-spec, unconfirmed)", () => {
    // placeholder/synthetic — combines the new "بانک صادرات" rule with the
    // original spec's generic keywords, per the TODO in bank-patterns.ts
    it("detects Saderat from a synthetic SMS combining بانک صادرات with the original generic keywords", () => {
      const result = detectBank(SADERAT_SYNTHETIC_SMS);
      expect(result.bank).toBe("saderat");
      expect(result.confidence).toBe(1);
      expect(result.matchedRules).toEqual([
        "saderat-bank-name",
        "saderat-pos-terminal",
        "saderat-account-label",
        "saderat-balance",
      ]);
    });

    it("falls back to unknown for the original spec sample without a bank name (scores 30, below MIN_CONFIDENCE_SCORE)", () => {
      const result = detectBank(SADERAT_ORIGINAL_SPEC_SMS);
      expect(result.bank).toBe("unknown");
      expect(result.confidence).toBe(0);
      expect(result.matchedRules).toEqual([]);
    });
  });

  describe("placeholder banks (synthetic, pending real SMS samples)", () => {
    // placeholder/synthetic — replace once real SMS sample is available
    it("detects Melli from a synthetic SMS", () => {
      const result = detectBank(MELLI_SYNTHETIC_SMS);
      expect(result.bank).toBe("melli");
      expect(result.confidence).toBe(1);
    });

    // placeholder/synthetic — replace once real SMS sample is available
    it("detects Saman from a synthetic SMS", () => {
      const result = detectBank(SAMAN_SYNTHETIC_SMS);
      expect(result.bank).toBe("saman");
      expect(result.confidence).toBe(1);
    });

    // placeholder/synthetic — replace once real SMS sample is available
    it("detects Parsian from a synthetic SMS", () => {
      const result = detectBank(PARSIAN_SYNTHETIC_SMS);
      expect(result.bank).toBe("parsian");
      expect(result.confidence).toBe(1);
    });

    // placeholder/synthetic — replace once real SMS sample is available
    it("detects Pasargad from a synthetic SMS", () => {
      const result = detectBank(PASARGAD_SYNTHETIC_SMS);
      expect(result.bank).toBe("pasargad");
      expect(result.confidence).toBe(1);
    });

    // placeholder/synthetic — replace once real SMS sample is available
    it("detects Post from a synthetic SMS", () => {
      const result = detectBank(POST_SYNTHETIC_SMS);
      expect(result.bank).toBe("post");
      expect(result.confidence).toBe(1);
    });

    // placeholder/synthetic — replace once real SMS sample is available
    it("detects Keshavarzi from a synthetic SMS", () => {
      const result = detectBank(KESHAVARZI_SYNTHETIC_SMS);
      expect(result.bank).toBe("keshavarzi");
      expect(result.confidence).toBe(1);
    });

    // placeholder/synthetic — replace once real SMS sample is available
    it("detects Maskan from a synthetic SMS", () => {
      const result = detectBank(MASKAN_SYNTHETIC_SMS);
      expect(result.bank).toBe("maskan");
      expect(result.confidence).toBe(1);
    });

    // placeholder/synthetic — replace once real SMS sample is available
    it("detects Ayandeh from a synthetic SMS", () => {
      const result = detectBank(AYANDEH_SYNTHETIC_SMS);
      expect(result.bank).toBe("ayandeh");
      expect(result.confidence).toBe(1);
    });

    // placeholder/synthetic — replace once real SMS sample is available
    it("detects Shahr from a synthetic SMS", () => {
      const result = detectBank(SHAHR_SYNTHETIC_SMS);
      expect(result.bank).toBe("shahr");
      expect(result.confidence).toBe(1);
    });

    // placeholder/synthetic — replace once real SMS sample is available
    it("detects Karafarin from a synthetic SMS", () => {
      const result = detectBank(KARAFARIN_SYNTHETIC_SMS);
      expect(result.bank).toBe("karafarin");
      expect(result.confidence).toBe(1);
    });

    // placeholder/synthetic — replace once real SMS sample is available
    it("detects Eghtesad Novin from a synthetic SMS", () => {
      const result = detectBank(EGHTESAD_NOVIN_SYNTHETIC_SMS);
      expect(result.bank).toBe("eghtesad-novin");
      expect(result.confidence).toBe(1);
    });
  });

  describe("documented Mellat limitation", () => {
    it("falls back to unknown for a real SMS that omits بانک ملت (documented limitation, not a bug)", () => {
      const result = detectBank(MELLAT_DOCUMENTED_EDGE_CASE_SMS);
      expect(result.bank).toBe("unknown");
      expect(result.confidence).toBe(0);
      expect(result.matchedRules).toEqual([]);
    });

    it("never misclassifies an unrelated SMS as mellat", () => {
      expect(detectBank(TEJARAT_SMS).bank).not.toBe("mellat");
    });
  });

  describe("ambiguous / tie scenarios", () => {
    it("falls back to unknown when two banks tie at the top score", () => {
      // Both "بانک ملت" and "بانک ملی" appear, each pulling in the shared
      // برداشت/مانده generic rules identically: mellat=115, melli=115 —
      // an exact tie, so TIE_THRESHOLD forces "unknown" even though both
      // individually clear MIN_CONFIDENCE_SCORE.
      const tieText = "بانک ملت بانک ملی برداشت مانده";
      const result = detectBank(tieText);
      expect(result.bank).toBe("unknown");
      expect(result.confidence).toBe(0);
      expect(result.matchedRules).toEqual([]);
    });
  });

  describe("missing keywords / unrelated text", () => {
    it("falls back to unknown when only a weak generic keyword is present", () => {
      const result = detectBank("مانده:100,000");
      expect(result.bank).toBe("unknown");
      expect(result.confidence).toBe(0);
    });

    it("falls back to unknown for completely unrelated text", () => {
      const result = detectBank(UNRELATED_TEXT);
      expect(result.bank).toBe("unknown");
      expect(result.confidence).toBe(0);
      expect(result.matchedRules).toEqual([]);
    });
  });

  describe("confidence calculation", () => {
    it("returns full confidence (1) when every rule for the winning bank matches", () => {
      const result = detectBank(BLU_SMS);
      expect(result.confidence).toBe(1);
    });

    it("returns a fractional confidence when only some of the winning bank's rules match", () => {
      // "بانک ملت" (100) + "مانده" (5) match, but "برداشت" (10) does not,
      // so confidence is 105/115 rather than a full 1.
      const result = detectBank("بانک ملت مانده");
      expect(result.bank).toBe("mellat");
      expect(result.confidence).toBeCloseTo(105 / 115, 10);
      expect(result.matchedRules).toEqual(["mellat-bank-name", "mellat-balance"]);
    });
  });

  describe("noisy whitespace", () => {
    it("is unaffected by extra spaces and blank lines around/within a sample", () => {
      const noisy = `   بلو


   برداشت    پول

 علی   عزیز،   7,000,000  ریال   از   حساب   شما   پرید.

موجودی:17,192,269
`;
      expect(detectBank(noisy)).toEqual(detectBank(BLU_SMS));
    });

    it("is unaffected by Windows-style CRLF line breaks splitting a keyword phrase", () => {
      const noisy =
        "بانک\r\n\r\nتجارت\r\nحساب:0145059220990\r\nبرداشت:1,500,000 ریال\r\nاز طريق: شتاب\r\nمانده:134,866 ریال\r\n";
      expect(detectBank(noisy)).toEqual(detectBank(TEJARAT_SMS));
    });
  });

  describe("digit scripts", () => {
    it("detects the same bank whether amounts use Persian digits or English digits", () => {
      const persianDigits =
        "بانک تجارت حساب:۰۱۴۵۰۵۹۲۲۰۹۹۰ برداشت:۱,۵۰۰,۰۰۰ ریال از طریق: شتاب مانده:۱۳۴,۸۶۶ ریال";
      expect(detectBank(persianDigits)).toEqual(detectBank(TEJARAT_SMS));
    });
  });

  describe("mixed Arabic/Persian characters", () => {
    it("detects the bank name written with Arabic Kaf (بانك) instead of Persian Kaf (بانک)", () => {
      const arabicKaf = `بانك رفاه
حساب10029977
خرید519,500-
مانده101,853,546`;
      expect(detectBank(arabicKaf)).toEqual(detectBank(REFAH_SMS));
    });

    it("resolves correctly from a sample combining Arabic ي/ك with Persian and Arabic-Indic digits together", () => {
      // Arabic Kaf in "بانك", Arabic Yeh in "خريد"/"پايانه", Persian digits
      // for the amount, and Arabic-Indic digits for the account number —
      // all normalized before matching, same outcome as the plain SEPAH_SMS.
      const combined =
        "بانك سپه خريد پايانه فروش ۹۲۷۸۲۰۰ ريال حساب ٥٤٣١٣٣١٧٦٧١٣٢٩١ مانده ٦٣٠٩٦٤٧٢";
      expect(detectBank(combined)).toEqual(detectBank(SEPAH_SMS));
    });
  });

  describe("cross-bank negative matches", () => {
    // Each row asserts that one bank's SMS is never misclassified as the
    // next bank in the cycle — covers all 17 banks (mellat is covered
    // separately above, via its documented-limitation sample).
    const NEGATIVE_MATCH_CASES: Array<[Bank, Bank, string]> = [
      ["sepah", "saderat", SEPAH_SMS],
      ["saderat", "tejarat", SADERAT_SYNTHETIC_SMS],
      ["tejarat", "refah", TEJARAT_SMS],
      ["refah", "blu", REFAH_SMS],
      ["blu", "melli", BLU_SMS],
      ["melli", "saman", MELLI_SYNTHETIC_SMS],
      ["saman", "parsian", SAMAN_SYNTHETIC_SMS],
      ["parsian", "pasargad", PARSIAN_SYNTHETIC_SMS],
      ["pasargad", "post", PASARGAD_SYNTHETIC_SMS],
      ["post", "keshavarzi", POST_SYNTHETIC_SMS],
      ["keshavarzi", "maskan", KESHAVARZI_SYNTHETIC_SMS],
      ["maskan", "ayandeh", MASKAN_SYNTHETIC_SMS],
      ["ayandeh", "shahr", AYANDEH_SYNTHETIC_SMS],
      ["shahr", "karafarin", SHAHR_SYNTHETIC_SMS],
      ["karafarin", "eghtesad-novin", KARAFARIN_SYNTHETIC_SMS],
      ["eghtesad-novin", "sepah", EGHTESAD_NOVIN_SYNTHETIC_SMS],
    ];

    it.each(NEGATIVE_MATCH_CASES)(
      "%s SMS is not classified as %s",
      (sourceBank, targetBank, text) => {
        const result = detectBank(text);
        expect(result.bank).toBe(sourceBank);
        expect(result.bank).not.toBe(targetBank);
      }
    );
  });
});
