import { normalizeText, toLatinDigits } from "@/lib/normalize";
import { normalizePersianNumberWords } from "@/lib/persian-number-words";

const SCALE_WORDS: Record<string, number> = {
  هزار: 1_000,
  میلیون: 1_000_000,
};

const RIAL = "ریال";
const NUMBER_TOKEN = /^\d+$/;
// Two distinct bounds, deliberately not shared - conflating them was a
// real trap (see git history): raising the single-number bound to widen
// the everyday-shorthand range must NOT also raise the "X و Y" combined-pair
// bound, or a stray adjacent pair like "۱۳۰۰ و ۵" would resolve as
// 1300x1,000,000 + 5x1,000 instead of bailing to null.
const BARE_SINGLE_MAX = 9_999;
const COMBINED_PART_MAX = 999;

// Mirrors the AI prompt's own amount rules exactly (see buildSystemPrompt's
// قوانین section) - the two must stay in lockstep:
//   - no recognized scale word at all (no هزار/میلیون/ریال) - whether the
//     number is completely bare, or only followed by plain تومان/تومن -
//     value 1-9,999      -> value x 1,000 (e.g. "80" or "80 تومن" -> 80000)
//   - same case, value >= 10,000       -> same number, unchanged
//   - "X و Y" / "X.Y" (both parts 1-999, nothing else in the text)
//                                      -> X x 1,000,000 + Y x 1,000
//   - هزار/میلیون                       -> x1,000 / x1,000,000
//   - ریال                              -> ÷10
//
// This is the second reversal of this file's default. The first (see git
// history) already established that a bare number should mean thousands,
// not single tomans. This one goes further, for two reasons users actually
// hit under today's inflation: (1) saying "تومن" out loud no longer signals
// a literal single-toman count either - "۵۰ تومن ناهار" means 50,000, not
// 50 - so a trailing تومان/تومن no longer opts a small number out of the
// x1,000 rule; (2) the old 1-999 ceiling was too low for how people
// actually write amounts today - "۱۳۰۰ شام" means 1,300,000, not 1,300 -
// so the ceiling is raised to 9,999. The ceiling still has to stop
// somewhere: someone who types a full 5-digit number ("۵۰۰۰۰ تومن") means
// that literally, and must not be inflated again into 50 million.
//
// Only resolves when the text contains exactly one numeric token, or
// exactly two in one of the combining shapes above - anything else bails
// to null rather than guess:
//   - spelled-out numbers ("پنجاه") never match the digit token, so bail.
//   - unrelated numbers elsewhere in the text ("۲ تا ۵۰ تومنی") don't fit
//     either combining shape, so bail.
//   - a decimal/pair with anything else attached ("۱۲.۵ تومن") isn't a
//     bare "X.Y" (something follows the pair) - still bails, same as
//     before.
//
// Known gap, now a bigger miss than before: a bare number followed by an
// unrelated word is still indistinguishable from "no unit at all" (e.g.
// "۵۰ درصد" - 50 percent - now resolves as amount 50,000, not 50). Not
// handled here - out of scope for this narrow extractor; the AI fallback
// is the backstop once a case like this is identified as needing
// rejection.
export function extractAmount(rawText: string): number | null {
  const tokens = splitDigitLetterBoundaries(
    normalizeText(toLatinDigits(normalizePersianNumberWords(rawText)))
  )
    .split(" ")
    .filter(Boolean);

  const numberIndices: number[] = [];
  tokens.forEach((token, i) => {
    if (NUMBER_TOKEN.test(token)) numberIndices.push(i);
  });

  if (numberIndices.length === 2) {
    return resolveCombinedPair(tokens, numberIndices[0], numberIndices[1]);
  }
  if (numberIndices.length !== 1) return null;

  const idx = numberIndices[0];
  const value = Number(tokens[idx]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const scaleWord = tokens[idx + 1];
  const scale = scaleWord && SCALE_WORDS[scaleWord] ? SCALE_WORDS[scaleWord] : 1;

  if (scale !== 1) {
    const isRial = tokens[idx + 2] === RIAL;
    const toman = value * scale;
    return Math.round(isRial ? toman / 10 : toman);
  }

  if (scaleWord === RIAL) return Math.round(value / 10);

  // No هزار/میلیون/ریال scale word - either no unit at all, or only a
  // plain تومان/تومن, which no longer opts out of the bare-number
  // magnitude heuristic (see the doc comment above).
  return Math.round(value <= BARE_SINGLE_MAX ? value * 1_000 : value);
}

// normalizeText already turns punctuation into spaces, so the only glued
// case left by the time we get here is a digit run directly touching a
// non-digit, non-space character (in either direction), e.g. "۱۰۰هزارتومن"
// or "ناهار۸۰". Insert a space at every such boundary so the later
// .split(" ") tokenizes them the same as if the user had typed the space
// themselves. Scoped to this file's tokenization only - not a general
// normalizeText rule, since other call sites (merchant matching, etc.)
// don't want digit/letter runs split apart.
function splitDigitLetterBoundaries(text: string): string {
  return text
    .replace(/(\d)(?=[^\d\s])/g, "$1 ")
    .replace(/([^\d\s])(?=\d)/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

// Handles "X و Y" (two numeric tokens joined by a literal "و") and "X.Y"
// (two numeric tokens left adjacent once normalizeText strips the "."
// separator) - both must consume the *entire* text with nothing else
// attached (no leading words, no trailing unit). Two numbers floating in a
// longer sentence are far more likely to be unrelated (see the bail cases
// above) than a deliberate X-and-Y amount, so anything short of a
// full-text match still bails to null.
function resolveCombinedPair(tokens: string[], firstIdx: number, secondIdx: number): number | null {
  const isAdjacent = secondIdx === firstIdx + 1;
  const isJoinedByAnd = secondIdx === firstIdx + 2 && tokens[firstIdx + 1] === "و";
  if (!isAdjacent && !isJoinedByAnd) return null;
  if (firstIdx !== 0 || secondIdx !== tokens.length - 1) return null;

  const x = Number(tokens[firstIdx]);
  const y = Number(tokens[secondIdx]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return null;
  if (x > COMBINED_PART_MAX || y > COMBINED_PART_MAX) return null;

  return Math.round(x * 1_000_000 + y * 1_000);
}
