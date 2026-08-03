import { normalizeText, toLatinDigits } from "@/lib/normalize";

const SCALE_WORDS: Record<string, number> = {
  هزار: 1_000,
  میلیون: 1_000_000,
};

const TOMAN_WORDS = new Set(["تومان", "تومن"]);
const RIAL = "ریال";
const NUMBER_TOKEN = /^\d+$/;
const BARE_MAX = 999;

// Mirrors the AI prompt's own amount rules exactly (see buildSystemPrompt's
// قوانین section) - the two must stay in lockstep:
//   - no unit at all, value 1-999      -> value x 1,000 (e.g. "80" -> 80000)
//   - no unit at all, value >= 1,000   -> same number, unchanged
//   - explicit تومان/تومن               -> same number, unchanged
//   - "X و Y" / "X.Y" (both parts 1-999, nothing else in the text)
//                                      -> X x 1,000,000 + Y x 1,000
//   - هزار/میلیون                       -> x1,000 / x1,000,000
//   - ریال                              -> ÷10
//
// This reverses the file's original "no unit -> same number" default: that
// was a deliberate choice to never guess an implicit scale, but beta
// feedback showed users overwhelmingly type bare numbers expecting them to
// mean thousands (e.g. "80" meaning 80,000 toman), so face-value
// resolution was silently undercounting real transactions by 1000x. This
// is a considered reversal of that tradeoff, not a bug fix.
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
  const tokens = normalizeText(toLatinDigits(rawText))
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
  if (scaleWord && TOMAN_WORDS.has(scaleWord)) return Math.round(value);

  // No recognized unit at all - the new bare-number default.
  return Math.round(value <= BARE_MAX ? value * 1_000 : value);
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
  if (x > BARE_MAX || y > BARE_MAX) return null;

  return Math.round(x * 1_000_000 + y * 1_000);
}
