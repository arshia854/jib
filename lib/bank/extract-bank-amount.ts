import { normalizeText } from "@/lib/bank/normalize";

// Rial SMS amounts are 10x the toman value; bank SMS always states the
// unit explicitly ("ریال") when it applies, so absence of that word means
// the amount is already in toman.
const RIAL_TO_TOMAN_DIVISOR = 10;
const RIAL_KEYWORD = "ریال";
const DEBIT_SIGN = "-";

const LINE_BREAKS = /\r\n|\r|\n/;

// Only comma-grouped numbers ("1,500,000") are treated as amounts. Real
// bank SMS always formats money with thousands separators, so requiring
// at least one comma group excludes account numbers, card suffixes, and
// OTP codes (bare digit runs) from being mistaken for a transaction amount.
const AMOUNT_TOKEN = /\d{1,3}(?:,\d{3})+/g;

// A trailing debit sign ("519,500-") may itself be followed by a currency
// word ("519,500- ریال"), so both are optional and order-dependent here.
const RIAL_AFTER_AMOUNT = new RegExp(`^${DEBIT_SIGN}?\\s*${RIAL_KEYWORD}`);

// Trailing run of spaces/colons between a label and its number, e.g. the
// "برداشت:" in "برداشت:1,500,000" — stripped so `endsWith` can match the
// bare keyword.
const LABEL_SEPARATOR_SUFFIX = /[\s:]+$/;

// Keywords whose number is the transaction amount, vs. keywords whose
// number is a running/available balance that must never be picked.
//
// Phase 7.1 fix: this list must stay a superset-compatible match with
// extract-bank-type.ts's own TYPE_KEYWORDS (خرید/برداشت/پرداخت for
// expense, واریز/انتقال for income) — "پرداخت" and "انتقال" were missing
// here even though extractBankType already recognizes both as valid
// transaction-type signals. A real "پرداخت:430,000"-shaped SMS (e.g.
// Parsian, whose own bank-patterns.ts rule is literally named
// "parsian-payment" with keyword "پرداخت") would detect its bank and type
// correctly but still fail amount extraction entirely — parseBankSms is
// all-or-nothing, so that silently forced every such message down to the
// AI fallback instead of resolving deterministically like every other
// bank's "keyword:amount" format. "از حساب شما پرید" is deliberately not
// added here even though it's also in TYPE_KEYWORDS.expense — it's a
// trailing narrative phrase handled separately by
// TRANSACTION_TRAILING_PHRASES below, not a "keyword:number" label this
// same-line/direct-attachment logic is meant to match.
const TRANSACTION_KEYWORDS = ["برداشت", "خرید", "واریز", "پرداخت", "انتقال"];
const BALANCE_KEYWORDS = ["مانده", "موجودی"];

// Narrative phrases that signal "this message is a transaction" without a
// leading keyword directly on the number's line — e.g. Blu's "علی عزیز،
// 7,000,000 ریال از حساب شما پرید." puts the debit signal (پرید) after the
// amount instead of a "keyword: number" label. When one of these appears
// anywhere in the text, the nearest preceding comma-grouped number is
// treated as the transaction amount.
const TRANSACTION_TRAILING_PHRASES = ["از حساب شما پرید"];

interface AmountCandidate {
  value: number;
  isRial: boolean;
  startIndex: number;
}

// A normalized line's span within the flattened (space-joined) text, used
// to answer "does a transaction keyword appear earlier on this same line"
// without re-splitting the already-flattened string.
interface LineSpan {
  start: number;
  end: number;
}

// normalizeText collapses line breaks into spaces before any of the
// candidate/keyword scanning below runs, which destroys line boundaries.
// To support same-line matching, normalize each raw line independently
// (equivalent output to normalizing the whole text, since every step of
// normalizeText is line-local) and join them back with single spaces while
// recording each line's [start, end) span in the resulting flat text.
function buildFlatTextWithLines(rawText: string): { flatText: string; lines: LineSpan[] } {
  const lines: LineSpan[] = [];
  let flatText = "";

  for (const rawLine of rawText.split(LINE_BREAKS)) {
    const normalizedLine = normalizeText(rawLine);
    if (normalizedLine.length === 0) continue;

    if (flatText.length > 0) flatText += " ";
    const start = flatText.length;
    flatText += normalizedLine;
    lines.push({ start, end: flatText.length });
  }

  return { flatText, lines };
}

function scanAmountCandidates(text: string): AmountCandidate[] {
  const candidates: AmountCandidate[] = [];
  AMOUNT_TOKEN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = AMOUNT_TOKEN.exec(text)) !== null) {
    const numberText = match[0];
    const value = Number(numberText.replace(/,/g, ""));
    const afterNumber = text.slice(match.index + numberText.length);

    candidates.push({
      value,
      isRial: RIAL_AFTER_AMOUNT.test(afterNumber),
      startIndex: match.index,
    });
  }

  return candidates;
}

// Returns the keyword (transaction or balance) immediately preceding the
// number at `index`, ignoring only whitespace/colon between them — a
// keyword elsewhere in the text that isn't directly attached doesn't count.
function precedingKeyword(text: string, index: number): string | null {
  const trimmedPrefix = text.slice(0, index).replace(LABEL_SEPARATOR_SUFFIX, "");
  const allKeywords = [...TRANSACTION_KEYWORDS, ...BALANCE_KEYWORDS];
  return allKeywords.find((keyword) => trimmedPrefix.endsWith(keyword)) ?? null;
}

// True when a number is directly attached to a balance keyword (مانده/
// موجودی). This exclusion always wins over the looser same-line/trailing-
// phrase rules below, so relaxing amount-keyword proximity can never cause
// a balance figure to be picked up as the transaction amount.
function isBalanceAdjacent(text: string, index: number): boolean {
  return BALANCE_KEYWORDS.includes(precedingKeyword(text, index) ?? "");
}

// True when a transaction keyword appears anywhere earlier on the same
// line as the number at `index` — not just immediately before it. Covers
// labels like Sepah's "خرید پایانه فروش: 9,278,200", where extra label
// text sits between the keyword and the number.
function hasTransactionKeywordOnSameLine(
  text: string,
  index: number,
  lines: LineSpan[]
): boolean {
  const line = lines.find(({ start, end }) => index >= start && index < end);
  if (!line) return false;

  const textBeforeOnLine = text.slice(line.start, index);
  return TRANSACTION_KEYWORDS.some((keyword) => textBeforeOnLine.includes(keyword));
}

// For each occurrence of a trailing transaction phrase (e.g. Blu's "از
// حساب شما پرید", which appears after the amount instead of a leading
// keyword), finds the nearest preceding candidate and marks it as a
// transaction candidate — unless that candidate is itself a balance
// figure, which the phrase can never override.
function candidatesNearTrailingPhrase(
  text: string,
  candidates: AmountCandidate[]
): Set<AmountCandidate> {
  const marked = new Set<AmountCandidate>();

  for (const phrase of TRANSACTION_TRAILING_PHRASES) {
    let searchFrom = 0;
    let phraseIndex: number;

    while ((phraseIndex = text.indexOf(phrase, searchFrom)) !== -1) {
      const nearestPreceding = candidates
        .filter((candidate) => candidate.startIndex < phraseIndex)
        .sort((a, b) => b.startIndex - a.startIndex)[0];

      if (nearestPreceding && !isBalanceAdjacent(text, nearestPreceding.startIndex)) {
        marked.add(nearestPreceding);
      }

      searchFrom = phraseIndex + phrase.length;
    }
  }

  return marked;
}

// Disambiguates multiple amount-like numbers (e.g. transaction amount vs.
// balance). A number qualifies as the transaction candidate if it's
// directly attached to a transaction keyword, shares a line with one
// earlier in the line, or is the nearest number preceding a trailing
// transaction phrase — but never if it's directly attached to a balance
// keyword, which always excludes it regardless of the other signals.
// Anything else — no qualifying signal, or more than one competing
// transaction candidate — is unresolvable, so we bail to null rather than
// guess.
function chooseByTransactionKeyword(
  text: string,
  candidates: AmountCandidate[],
  lines: LineSpan[]
): AmountCandidate | null {
  const trailingPhraseMatches = candidatesNearTrailingPhrase(text, candidates);

  const transactionCandidates = candidates.filter((candidate) => {
    if (isBalanceAdjacent(text, candidate.startIndex)) return false;

    const hasDirectKeyword = TRANSACTION_KEYWORDS.includes(
      precedingKeyword(text, candidate.startIndex) ?? ""
    );

    return (
      hasDirectKeyword ||
      hasTransactionKeywordOnSameLine(text, candidate.startIndex, lines) ||
      trailingPhraseMatches.has(candidate)
    );
  });

  return transactionCandidates.length === 1 ? transactionCandidates[0] : null;
}

export function extractBankAmount(rawText: string): number | null {
  const { flatText: normalized, lines } = buildFlatTextWithLines(rawText);
  const candidates = scanAmountCandidates(normalized);

  if (candidates.length === 0) return null;

  const chosen =
    candidates.length === 1
      ? candidates[0]
      : chooseByTransactionKeyword(normalized, candidates, lines);

  if (!chosen) return null;

  return chosen.isRial ? Math.round(chosen.value / RIAL_TO_TOMAN_DIVISOR) : chosen.value;
}
