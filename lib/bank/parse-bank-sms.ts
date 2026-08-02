import { detectBank } from "./detect-bank";
import { extractBankAmount } from "./extract-bank-amount";
import { extractBankType } from "./extract-bank-type";
import type { BankTransactionType } from "./extract-bank-type";
import { extractDate } from "@/lib/extract-date";
import type { DetectionResult } from "./types";

export interface BankSmsParseResult {
  bank: DetectionResult["bank"];
  bankConfidence: number;
  amount: number;
  type: BankTransactionType;
  date: string; // YYYY-MM-DD
}

// All-or-nothing: bank, amount, and type must all resolve, or the whole
// parse fails so the caller can fall back to the AI. Date is secondary —
// extractDate("", now) can never return null (no date keyword can appear
// in an empty string), so it's reused here as the "today" fallback rather
// than reimplementing date formatting.
export function parseBankSms(rawText: string, now: Date = new Date()): BankSmsParseResult | null {
  const bankResult = detectBank(rawText);
  if (bankResult.bank === "unknown") return null;

  const amount = extractBankAmount(rawText);
  if (amount === null) return null;

  const type = extractBankType(rawText);
  if (type === null) return null;

  const date = extractDate(rawText, now) ?? extractDate("", now)!;

  return {
    bank: bankResult.bank,
    bankConfidence: bankResult.confidence,
    amount,
    type,
    date,
  };
}
