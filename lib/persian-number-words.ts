// Converts a maximal contiguous run of spelled-out Persian number words
// (e.g. "سی و پنج", "دویست هزار") into a single Latin-digit token, so
// extractAmount's existing digit-based pipeline can handle the rest.
// Runs on raw text, before toLatinDigits/normalizeText - matching is done
// on a per-word basis (split on whitespace), so a word that merely
// *contains* a number word as a substring (e.g. "سیگار" contains "سی")
// never matches, since it's compared as a whole token, not a substring.

// If the text already has a digit-based number anywhere, leave it alone
// entirely and let extractAmount's existing digit pipeline handle it
// unchanged. This isn't just about avoiding double work: a spelled-out
// number word can appear coincidentally near an unrelated digit amount
// (e.g. a merchant name like "فروشگاه ناشناخته هفتاد" sitting next to a
// real "۵۰ هزار تومن") - converting it there would manufacture a second,
// colliding numeric token and break an amount that used to resolve fine.
// Mixing digit- and word-based numerals in one message is exactly the
// ambiguous case the rest of this pipeline already prefers to bail on.
const DIGIT_ANYWHERE = /[0-9۰-۹٠-٩]/;

// ي/ك show up from Arabic-script input or some IMEs; canonicalize just
// for matching purposes (mirrors lib/normalize.ts's own yeh/kaf handling,
// duplicated here since this runs before that file's normalizeText does).
const ARABIC_YEH = /ي/g;
const ARABIC_KAF = /ك/g;

function canonical(word: string): string {
  return word.replace(ARABIC_YEH, "ی").replace(ARABIC_KAF, "ک");
}

const CONNECTOR = "و";

// Tier = magnitude class, used only to validate word order below - real
// Persian composes a number strictly largest-to-smallest ("صد و بیست", never
// "بیست و صد"), so tiers must strictly decrease across a run.
const ONES: Record<string, number> = {
  یک: 1,
  دو: 2,
  سه: 3,
  چهار: 4,
  پنج: 5,
  شش: 6,
  هفت: 7,
  هشت: 8,
  نه: 9,
};
const ONES_TIER = 1;

const TEENS: Record<string, number> = {
  ده: 10,
  یازده: 11,
  دوازده: 12,
  سیزده: 13,
  چهارده: 14,
  پانزده: 15,
  شانزده: 16,
  هفده: 17,
  هجده: 18,
  نوزده: 19,
};
const TEENS_TIER = 1;

const TENS: Record<string, number> = {
  بیست: 20,
  سی: 30,
  چهل: 40,
  پنجاه: 50,
  شصت: 60,
  هفتاد: 70,
  هشتاد: 80,
  نود: 90,
};
const TENS_TIER = 2;

// صد and the 200-900 compounds (Persian writes those as single words,
// never "دو صد") are all plain additive "hundred" values, same tier.
const HUNDREDS: Record<string, number> = {
  صد: 100,
  دویست: 200,
  سیصد: 300,
  چهارصد: 400,
  پانصد: 500,
  ششصد: 600,
  هفتصد: 700,
  هشتصد: 800,
  نهصد: 900,
};
const HUNDREDS_TIER = 3;

const VALUE_WORDS: Record<string, number> = { ...ONES, ...TEENS, ...TENS, ...HUNDREDS };

const VALUE_TIERS: Record<string, number> = {
  ...mapTier(ONES, ONES_TIER),
  ...mapTier(TEENS, TEENS_TIER),
  ...mapTier(TENS, TENS_TIER),
  ...mapTier(HUNDREDS, HUNDREDS_TIER),
};

function mapTier(words: Record<string, number>, tier: number): Record<string, number> {
  return Object.fromEntries(Object.keys(words).map((word) => [word, tier]));
}

// True multipliers - always >= 1,000, so encountering one always flushes
// the accumulated value into `total` (see computeNumberWordsValue).
const SCALE_WORDS: Record<string, number> = {
  هزار: 1_000,
  میلیون: 1_000_000,
};

function hasKey(map: Record<string, number>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

function isNumberWord(word: string): boolean {
  return hasKey(VALUE_WORDS, word) || hasKey(SCALE_WORDS, word);
}

// A run is only valid if its value words strictly decrease in tier
// (hundreds, then tens, then ones/teens) - matching how Persian actually
// composes numbers. A scale word resets the tier tracking, since it starts
// a fresh group ("... هزار و سیصد" - سیصد isn't compared against whatever
// came before هزار). Anything else, e.g. "پنجاه و صد" (tens before
// hundreds - not real Persian), is rejected outright rather than guessed.
function hasValidWordOrder(words: string[]): boolean {
  let lastTier: number | null = null;
  for (const word of words) {
    if (word === CONNECTOR) continue;
    if (hasKey(SCALE_WORDS, word)) {
      lastTier = null;
      continue;
    }
    const tier = VALUE_TIERS[word];
    if (lastTier !== null && tier >= lastTier) return false;
    lastTier = tier;
  }
  return true;
}

// Standard word-to-number accumulation: a plain value adds into `current`;
// a scale word multiplies it (defaulting the implicit multiplicand to 1 for
// a bare "هزار"/"میلیون") and flushes the result into `total`.
function computeNumberWordsValue(words: string[]): number {
  let total = 0;
  let current = 0;

  for (const word of words) {
    if (word === CONNECTOR) continue;

    if (hasKey(SCALE_WORDS, word)) {
      total += (current === 0 ? 1 : current) * SCALE_WORDS[word];
      current = 0;
      continue;
    }

    current += VALUE_WORDS[word];
  }

  return total + current;
}

export function normalizePersianNumberWords(text: string): string {
  if (DIGIT_ANYWHERE.test(text)) return text;

  const words = text.split(/\s+/).filter(Boolean);
  const output: string[] = [];
  let i = 0;

  while (i < words.length) {
    const run: string[] = [];
    let j = i;

    while (j < words.length) {
      const canon = canonical(words[j]);
      if (isNumberWord(canon)) {
        run.push(canon);
        j++;
        continue;
      }

      // Only swallow "و" when it's genuinely joining two number words
      // ("سی و پنج") - "و" is one of the most common words in Persian,
      // so outside that exact shape it must be left alone.
      if (canon === CONNECTOR && run.length > 0 && j + 1 < words.length) {
        const next = canonical(words[j + 1]);
        if (isNumberWord(next)) {
          run.push(canon);
          j++;
          continue;
        }
      }

      break;
    }

    if (run.length > 0 && hasValidWordOrder(run)) {
      output.push(String(computeNumberWordsValue(run)));
      i = j;
    } else if (run.length > 0) {
      // Malformed run (e.g. "پنجاه و صد") - leave every word in it
      // untouched rather than guessing, so it can't be misread by
      // reprocessing a sub-span of it as a fresh, smaller run.
      for (let k = i; k < j; k++) output.push(words[k]);
      i = j;
    } else {
      output.push(words[i]);
      i++;
    }
  }

  return output.join(" ");
}
