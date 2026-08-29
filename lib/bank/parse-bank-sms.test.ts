import { describe, it, expect } from "vitest";
import { parseBankSms } from "@/lib/bank/parse-bank-sms";

const NOW = new Date("2026-07-30T12:00:00Z");
const TODAY_ISO = "2026-07-30";

// Plausible/representative bank SMS fixtures reused from detect-bank.test.ts
// and extract-bank-type.test.ts — see the provenance note there. Not
// verified copies of actual received SMS.

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

// Reused from detect-bank.test.ts's SADERAT_SYNTHETIC_SMS (placeholder,
// pending a real Saderat sample per that file's own TODO).
const SADERAT_SMS = `بانک صادرات
پایانه فروش: 2,000,000
حساب:86004
مانده:43,234,864`;

// Reused from detect-bank.test.ts's MELLAT_DOCUMENTED_EDGE_CASE_SMS — a
// documented case where detectBank resolves to "unknown" (see that file).
const MELLAT_EDGE_CASE_SMS = `حساب9621822033
برداشت5,960,000
مانده28,924,449
05/05/03-11:03`;

// Reused from extract-bank-type.test.ts's BLU_SELF_TRANSFER_SMS.
const BLU_SELF_TRANSFER_SMS = `بلو
انتقال بین حساب‌ها
علی عزیز، 500,000 ریال از حساب شما پرید و به حساب پس‌انداز شما واریز شد.
موجودی:12,000,000`;

const FREE_TEXT = "۵۰ تومن ناهار خوردم";

// Same fixture as TEJARAT_SMS with "واریز" (income) swapped in for
// "برداشت" (expense) - reused from parse-transaction.test.ts's
// TEJARAT_SMS_INCOME_WITH_MERCHANT template (minus the merchant line) to
// cover an income/credit full result at the parseBankSms level directly,
// not just indirectly through parseTransactionWithAI's own tests.
const TEJARAT_INCOME_SMS = `بانک تجارت
حساب:0145059220990
واریز:2,000,000 ریال
از طریق: شتاب
مانده:134,866 ریال`;

// A message containing only a balance figure - no برداشت/خرید/پرداخت/واریز/
// انتقال keyword anywhere - must not be misparsed as a transaction. Bank
// resolves confidently (bank name + مانده both match Sepah's rules); the
// type check is what must correctly bail to null here.
const SEPAH_BALANCE_ONLY_SMS = `بانک سپه
مانده:63,096,472`;

// Phase 7.1 hardening fixtures - synthetic, structurally consistent with
// the other synthetic fixtures above (bank name + a scored transaction
// keyword from that bank's own BANK_PATTERNS rules + a مانده/موجودی balance
// line), extended with a comma-grouped amount so each bank now has at
// least one fixture that resolves a *complete* parseBankSms result, not
// just a detectBank hit - previously only 4 of 17 supported banks
// (Tejarat, Refah, Sepah, Blu) had any fixture proving the full
// bank+amount+type pipeline succeeds together. placeholder/synthetic -
// replace with a real SMS sample once one is available, same caveat as
// every other synthetic fixture in this codebase.
const MELLI_FULL_SMS = `بانک ملی
برداشت:2,340,000
مانده:15,000,000`;

const SAMAN_FULL_SMS = `بانک سامان
خرید:750,000
مانده:9,000,000`;

const PARSIAN_FULL_SMS = `بانک پارسیان
پرداخت:430,000
مانده:6,250,000`;

const PASARGAD_FULL_SMS = `بانک پاسارگاد
خرید:1,200,000
موجودی:8,400,000`;

const POST_FULL_SMS = `پست بانک
برداشت:600,000
مانده:3,150,000`;

const KESHAVARZI_FULL_SMS = `بانک کشاورزی
برداشت:980,000
مانده:12,300,000`;

const MASKAN_FULL_SMS = `بانک مسکن
برداشت:2,100,000
مانده:40,000,000`;

const AYANDEH_FULL_SMS = `بانک آینده
خرید:355,000
موجودی:7,700,000`;

const SHAHR_FULL_SMS = `بانک شهر
برداشت:1,850,000
مانده:22,000,000`;

const KARAFARIN_FULL_SMS = `بانک کارآفرین
برداشت:670,000
مانده:5,500,000`;

const EGHTESAD_NOVIN_FULL_SMS = `اقتصاد نوین
خرید:410,000
مانده:9,900,000`;

// Truncated mid-word: the bank name never completes ("بانک تج" is not
// "بانک تجارت"), simulating an SMS cut off in transit/storage. Must not
// be mistaken for Tejarat just because it shares a prefix.
const TRUNCATED_BANK_NAME_SMS = "بانک تج";

// Truncated after the transaction keyword, before any amount ever arrives -
// simulates a message cut off mid-transmission. Bank resolves; amount
// extraction must fail cleanly (no digits at all follow the keyword).
const TRUNCATED_BEFORE_AMOUNT_SMS = `بانک تجارت
حساب:0145059220990
برداشت`;

// Garbled/corrupted bank name (a stray replacement character, U+FFFD,
// spliced into the middle of "بانک تجارت" - a realistic artifact of a
// mangled character encoding) - the exact-substring bank-name rule no
// longer matches, and the two remaining generic Tejarat signals ("از
// طریق"=15, "شتاب"=10) only total 25, below MIN_CONFIDENCE_SCORE (50), so
// detection correctly falls back to unknown rather than still guessing
// Tejarat from a corrupted name.
const GARBLED_BANK_NAME_SMS = `بانک تج�ارت
حساب:0145059220990
برداشت:1,500,000 ریال
از طریق: شتاب
مانده:134,866 ریال`;

// Garbled amount: the digits themselves are corrupted (letters spliced
// into where the amount should be), not just missing - bank and type both
// resolve, but no valid comma-grouped number exists anywhere in the text,
// so amount extraction must fail cleanly rather than guess.
const GARBLED_AMOUNT_SMS = `بانک تجارت
حساب:0145059220990
برداشت: مبلغ نامعلوم ریال
از طریق: شتاب`;

// Ordinary financial free text that happens to contain a comma-formatted
// number and a recognized transaction keyword (خرید) - everything
// extractBankAmount/extractBankType would need individually, but no bank
// name or bank-specific phrase anywhere. Guards against a false positive
// where amount+type resolving on their own could be mistaken for a parsed
// bank SMS; detectBank must still gate the whole result to null.
const NON_BANK_TEXT_WITH_AMOUNT_SMS = "دیروز 1,500,000 خرید کردم برای خونه";

// Constructed (not reused): built from TEJARAT_SMS's established phrasing
// specifically to isolate the type-ambiguous branch in parseBankSms —
// amount must still resolve, so a null result here can only come from the
// type check, not the earlier amount check.
const TEJARAT_TYPE_AMBIGUOUS_SMS = `بانک تجارت
حساب:0145059220990
برداشت:1,500,000 ریال
انتقال به حساب دیگر
از طریق: شتاب
مانده:134,866 ریال`;

// Constructed (not reused): built from TEJARAT_SMS's established phrasing
// specifically to isolate the extractDate-null branch — دیروز و پریروز
// together is the only combination that makes extractDate return null.
const TEJARAT_DATE_NULL_SMS = `بانک تجارت
حساب:0145059220990
برداشت:1,500,000 ریال
از طریق: شتاب
دیروز پریروز
مانده:134,866 ریال`;

describe("parseBankSms", () => {
  describe("full result — bank, amount, and type all resolve", () => {
    it("parses Tejarat's SMS into a full result", () => {
      expect(parseBankSms(TEJARAT_SMS, NOW)).toEqual({
        bank: "tejarat",
        bankConfidence: 1,
        amount: 150000,
        type: "expense",
        date: TODAY_ISO,
      });
    });

    it("parses Refah's SMS into a full result", () => {
      expect(parseBankSms(REFAH_SMS, NOW)).toEqual({
        bank: "refah",
        bankConfidence: 1,
        amount: 519500,
        type: "expense",
        date: TODAY_ISO,
      });
    });

    // extractBankAmount's disambiguation now recognizes a transaction
    // keyword anywhere earlier on the same line as the amount, not just
    // immediately adjacent to it — so the label text in "خرید پایانه
    // فروش:" no longer defeats the match. See extract-bank-amount.test.ts's
    // "same-line keyword matching" block for coverage of that rule itself.
    it("parses Sepah's SMS into a full result (same-line label between keyword and amount)", () => {
      expect(parseBankSms(SEPAH_SMS, NOW)).toEqual({
        bank: "sepah",
        bankConfidence: 1,
        amount: 9278200,
        type: "expense",
        date: TODAY_ISO,
      });
    });

    // extractBankAmount now also recognizes Blu's narrative "از حساب شما
    // پرید" phrasing as a transaction signal even though it trails the
    // amount instead of leading it as a "keyword: number" label. See
    // extract-bank-amount.test.ts's "trailing transaction phrase" block.
    // The amount is stated in ریال ("7,000,000 ریال"), so it converts to
    // 700,000 toman via the same rial-to-toman rule exercised elsewhere
    // (e.g. TEJARAT_SMS's "1,500,000 ریال" -> 150000 above).
    it("parses Blu's SMS into a full result (narrative debit phrasing, rial converted to toman)", () => {
      expect(parseBankSms(BLU_SMS, NOW)).toEqual({
        bank: "blu",
        bankConfidence: 1,
        amount: 700000,
        type: "expense",
        date: TODAY_ISO,
      });
    });
  });

  // Phase 7.1: one full-result fixture per currently-supported bank that
  // didn't already have one above (Tejarat/Refah/Sepah/Blu). Synthetic,
  // per each fixture's own provenance comment - these prove the complete
  // deterministic pipeline (detectBank + extractBankAmount +
  // extractBankType together) actually succeeds for every bank in the
  // Bank union, not just the 4 banks with a real-SMS-derived sample.
  describe("full result — one synthetic fixture per remaining supported bank", () => {
    it.each([
      ["melli", MELLI_FULL_SMS, 2340000],
      ["saman", SAMAN_FULL_SMS, 750000],
      ["parsian", PARSIAN_FULL_SMS, 430000],
      ["pasargad", PASARGAD_FULL_SMS, 1200000],
      ["post", POST_FULL_SMS, 600000],
      ["keshavarzi", KESHAVARZI_FULL_SMS, 980000],
      ["maskan", MASKAN_FULL_SMS, 2100000],
      ["ayandeh", AYANDEH_FULL_SMS, 355000],
      ["shahr", SHAHR_FULL_SMS, 1850000],
      ["karafarin", KARAFARIN_FULL_SMS, 670000],
      ["eghtesad-novin", EGHTESAD_NOVIN_FULL_SMS, 410000],
    ] as const)("parses %s's synthetic SMS into a full expense result", (bank, sms, amount) => {
      expect(parseBankSms(sms, NOW)).toEqual({
        bank,
        bankConfidence: 1,
        amount,
        type: "expense",
        date: TODAY_ISO,
      });
    });
  });

  describe("income (credit) full result", () => {
    it("parses a واریز (deposit) SMS into a full income result", () => {
      expect(parseBankSms(TEJARAT_INCOME_SMS, NOW)).toEqual({
        bank: "tejarat",
        bankConfidence: 1,
        amount: 200000,
        type: "income",
        date: TODAY_ISO,
      });
    });
  });

  describe("balance-only messages are not misparsed as a transaction", () => {
    it("returns null for a message containing only a balance figure, no transaction keyword", () => {
      expect(parseBankSms(SEPAH_BALANCE_ONLY_SMS, NOW)).toBeNull();
    });
  });

  describe("malformed SMS (truncated / garbled)", () => {
    it("returns null for a bank name truncated mid-word", () => {
      expect(parseBankSms(TRUNCATED_BANK_NAME_SMS, NOW)).toBeNull();
    });

    it("returns null when the message is cut off before any amount arrives", () => {
      expect(parseBankSms(TRUNCATED_BEFORE_AMOUNT_SMS, NOW)).toBeNull();
    });

    it("returns null when the bank name itself is corrupted (mojibake character spliced in)", () => {
      expect(parseBankSms(GARBLED_BANK_NAME_SMS, NOW)).toBeNull();
    });

    it("returns null when the amount digits are replaced with garbled text", () => {
      expect(parseBankSms(GARBLED_AMOUNT_SMS, NOW)).toBeNull();
    });
  });

  describe("non-bank text with an incidental comma-amount and keyword", () => {
    it("returns null despite a resolvable amount and type, since no bank matches", () => {
      expect(parseBankSms(NON_BANK_TEXT_WITH_AMOUNT_SMS, NOW)).toBeNull();
    });
  });

  describe("type unresolvable — null despite a known bank and a resolved amount", () => {
    it("returns null when both an expense and income keyword appear (Blu self-transfer)", () => {
      // extractBankAmount resolves this fixture's amount (the trailing
      // "از حساب شما پرید" phrase attributes 500,000 ریال to the
      // transaction), so this exercises the type check alone: both
      // "از حساب شما پرید" (expense) and "واریز" (income) appear, so
      // extractBankType bails to null on the ambiguity.
      expect(parseBankSms(BLU_SELF_TRANSFER_SMS, NOW)).toBeNull();
    });

    it("returns null from the type check alone, with amount and bank both resolved", () => {
      expect(parseBankSms(TEJARAT_TYPE_AMBIGUOUS_SMS, NOW)).toBeNull();
    });
  });

  describe("unresolvable bank", () => {
    it("returns null for the documented Mellat edge case (detectBank resolves to unknown)", () => {
      expect(parseBankSms(MELLAT_EDGE_CASE_SMS, NOW)).toBeNull();
    });

    it("returns null for the Saderat synthetic sample (bank resolves, but no expense/income keyword)", () => {
      // Saderat's synthetic fixture doesn't reach the bank check as its
      // failure point — it fails at the type check (no خرید/برداشت/
      // پرداخت/واریز/انتقال present) — included here as the Saderat
      // coverage since no fixture in this codebase yet produces a full
      // Saderat result (see PROVENANCE note in the task summary).
      expect(parseBankSms(SADERAT_SMS, NOW)).toBeNull();
    });
  });

  describe("free-text non-bank input", () => {
    it("returns null and does not misfire on ordinary spending text", () => {
      expect(parseBankSms(FREE_TEXT, NOW)).toBeNull();
    });
  });

  describe("date fallback", () => {
    it("defaults date to today when extractDate returns null, without failing the whole parse", () => {
      const result = parseBankSms(TEJARAT_DATE_NULL_SMS, NOW);
      expect(result).not.toBeNull();
      expect(result?.date).toBe(TODAY_ISO);
      expect(result?.bank).toBe("tejarat");
      expect(result?.amount).toBe(150000);
      expect(result?.type).toBe("expense");
    });
  });

  describe("defaults now to the current date when omitted", () => {
    it("uses new Date() when now is not provided", () => {
      const result = parseBankSms(TEJARAT_SMS);
      const todayIso = new Date().toISOString().slice(0, 10);
      expect(result?.date).toBe(todayIso);
    });
  });
});
