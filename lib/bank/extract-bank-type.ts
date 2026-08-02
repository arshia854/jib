import { normalizeText } from "@/lib/bank/normalize";

export type BankTransactionType = "expense" | "income";

// Keyword group per transaction type — data-driven so a new bank's
// phrasing is a one-line addition here, never a new branch. Blu's "از
// حساب شما پرید" is slang for a debit: despite "پرید" (flew) reading like
// something arriving, the money is leaving the account, so it belongs
// under expense, not income.
const TYPE_KEYWORDS: Record<BankTransactionType, string[]> = {
  expense: ["خرید", "برداشت", "پرداخت", "از حساب شما پرید"],
  income: ["واریز", "انتقال"],
};

const TRANSACTION_TYPES = Object.keys(TYPE_KEYWORDS) as BankTransactionType[];

function matchesType(normalizedText: string, type: BankTransactionType): boolean {
  return TYPE_KEYWORDS[type].some((keyword) => normalizedText.includes(keyword));
}

// Returns null when no keyword is found, or when keywords from both
// categories appear — a genuinely ambiguous message is left for the AI
// fallback rather than guessed at here.
export function extractBankType(rawText: string): BankTransactionType | null {
  const normalizedText = normalizeText(rawText);
  const matchedTypes = TRANSACTION_TYPES.filter((type) =>
    matchesType(normalizedText, type)
  );

  return matchedTypes.length === 1 ? matchedTypes[0] : null;
}
