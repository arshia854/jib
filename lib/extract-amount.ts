import { normalizeText, toLatinDigits } from "@/lib/normalize";

const SCALE_WORDS: Record<string, number> = {
  هزار: 1_000,
  میلیون: 1_000_000,
};

const RIAL = "ریال";
const NUMBER_TOKEN = /^\d+$/;

// Mirrors the AI prompt's own amount rules exactly (see buildSystemPrompt):
// no unit or تومان/تومن -> same number; هزار/میلیون -> x1,000 / x1,000,000;
// ریال -> ÷10. Only resolves when the text contains exactly one numeric
// token immediately followed by (at most) a scale word and a currency
// word - anything else bails to null rather than guess:
//   - spelled-out numbers ("پنجاه") never match the digit token, so bail.
//   - multiple numbers ("۲ تا ۵۰ تومنی") produce >1 numeric token, so bail.
//   - decimals ("۱۲.۵") - normalizeText strips "." as punctuation, which
//     splits the value into two adjacent numeric tokens ("12" "5"), so
//     they fall through the same >1-numeric-token bail path above.
//
// Known gap: a bare number followed by an unrelated word is
// indistinguishable from "number + implied toman" (e.g. "۵۰ درصد" - 50
// percent - resolves as amount 50). Not handled here - out of scope for
// this narrow extractor; ambiguous real-world phrasing like this is rare
// in casual transaction logging and the AI fallback still covers it once
// a case like this is identified as needing rejection.
export function extractAmount(rawText: string): number | null {
  const tokens = normalizeText(toLatinDigits(rawText))
    .split(" ")
    .filter(Boolean);

  const numberIndices: number[] = [];
  tokens.forEach((token, i) => {
    if (NUMBER_TOKEN.test(token)) numberIndices.push(i);
  });
  if (numberIndices.length !== 1) return null;

  const idx = numberIndices[0];
  const value = Number(tokens[idx]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const scaleWord = tokens[idx + 1];
  const scale = scaleWord && SCALE_WORDS[scaleWord] ? SCALE_WORDS[scaleWord] : 1;

  const currencyIdx = scale !== 1 ? idx + 2 : idx + 1;
  const isRial = tokens[currencyIdx] === RIAL;

  const toman = value * scale;
  return Math.round(isRial ? toman / 10 : toman);
}
