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
