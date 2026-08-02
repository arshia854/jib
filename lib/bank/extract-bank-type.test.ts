import { describe, it, expect } from "vitest";
import { extractBankType } from "@/lib/bank/extract-bank-type";

// Real SMS samples (same fixtures used in detect-bank.test.ts)

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

// Documented Mellat edge case: a real SMS that omits "بانک ملت" entirely
// (see detect-bank.test.ts) — still has برداشت, so type extraction should
// work independently of bank detection.
const MELLAT_EDGE_CASE_SMS = `حساب9621822033
برداشت5,960,000
مانده28,924,449
05/05/03-11:03`;

// Original spec sample for Saderat: only generic structural keywords
// (پایانه فروش، حساب:، مانده), none of which signal expense or income.
const SADERAT_ORIGINAL_SPEC_SMS = `پایانه فروش: 2,000,000-
حساب:86004
مانده:43,234,864`;

const UNRELATED_TEXT = "امروز هوا آفتابی است و قصد داریم به پارک برویم";

// Constructed (not a copy-pasted real message) in Blu's established style
// from BLU_SMS above, to model a realistic self-to-self transfer: a single
// notification that reports both the debit from checking (از حساب شما
// پرید) and the credit into a savings pocket (واریز) in one message.
const BLU_SELF_TRANSFER_SMS = `بلو
انتقال بین حساب‌ها
علی عزیز، 500,000 ریال از حساب شما پرید و به حساب پس‌انداز شما واریز شد.
موجودی:12,000,000`;

describe("extractBankType", () => {
  describe("expense — real bank SMS samples", () => {
    it("detects expense from Sepah's SMS (خريد پايانه فروش, Arabic Yeh)", () => {
      expect(extractBankType(SEPAH_SMS)).toBe("expense");
    });

    it("detects expense from Tejarat's SMS (برداشت)", () => {
      expect(extractBankType(TEJARAT_SMS)).toBe("expense");
    });

    it("detects expense from Refah's SMS (خرید)", () => {
      expect(extractBankType(REFAH_SMS)).toBe("expense");
    });

    it("detects expense from Blu's SMS (برداشت پول + از حساب شما پرید)", () => {
      expect(extractBankType(BLU_SMS)).toBe("expense");
    });

    it("detects expense from the documented Mellat edge case (برداشت, no bank name)", () => {
      expect(extractBankType(MELLAT_EDGE_CASE_SMS)).toBe("expense");
    });
  });

  describe("expense — Blu's پرید slang specifically", () => {
    it("classifies 'از حساب شما پرید' as expense on its own, despite پرید sounding like incoming money", () => {
      const text = "علی عزیز، 7,000,000 ریال از حساب شما پرید.";
      expect(extractBankType(text)).toBe("expense");
    });
  });

  describe("expense — پرداخت keyword", () => {
    it("detects expense from a پرداخت (payment) keyword", () => {
      const text = "پرداخت قبض به مبلغ 300,000 ریال از حساب شما کسر شد";
      expect(extractBankType(text)).toBe("expense");
    });
  });

  describe("income", () => {
    it("detects income from a واریز (deposit) keyword", () => {
      const text = "واریز:2,000,000 ریال به حساب شما موجودی:5,000,000";
      expect(extractBankType(text)).toBe("income");
    });

    it("detects income from an انتقال (transfer received) keyword", () => {
      const text = "انتقال وجه به مبلغ 500,000 ریال به حساب شما";
      expect(extractBankType(text)).toBe("income");
    });
  });

  describe("ambiguous mixed keywords", () => {
    it("returns null when both an expense (خرید) and income (واریز) keyword appear", () => {
      const text = "واریز:1,000,000 خرید:200,000";
      expect(extractBankType(text)).toBeNull();
    });

    it("returns null when both an expense (برداشت) and income (انتقال) keyword appear", () => {
      const text = "برداشت 500,000 و انتقال 200,000 در یک روز";
      expect(extractBankType(text)).toBeNull();
    });

    it("returns null for a realistic self-to-self transfer notification that reports both a debit (پرید) and a credit (واریز) in one message, rather than silently picking one", () => {
      expect(extractBankType(BLU_SELF_TRANSFER_SMS)).toBeNull();
    });
  });

  describe("no recognizable keyword", () => {
    it("returns null for the Saderat original-spec sample (only generic, non-type keywords)", () => {
      expect(extractBankType(SADERAT_ORIGINAL_SPEC_SMS)).toBeNull();
    });

    it("returns null for completely unrelated text", () => {
      expect(extractBankType(UNRELATED_TEXT)).toBeNull();
    });

    it("returns null for an empty string", () => {
      expect(extractBankType("")).toBeNull();
    });
  });
});
