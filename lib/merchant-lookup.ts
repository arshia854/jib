import { prisma } from "@/lib/prisma";
import { normalizeText, toLatinDigits } from "@/lib/normalize";
import { DEFAULT_MERCHANTS, type DefaultMerchant } from "@/lib/merchants";
import type { CategoryType } from "@/lib/categories";

export type MerchantMatchSource = "userMapping" | "globalMerchant" | "keyword" | "none";

export interface MerchantLookupResult {
  source: MerchantMatchSource;
  category?: string;
  subcategory?: string;
  merchantName?: string;
  matchedText?: string;
  // Sourced from the matched merchant/category, never parsed from text -
  // lets callers skip AI-based type inference entirely on a match.
  type?: CategoryType;
  // Which findBestMatch tier actually resolved this (1 = exact, 2 = alias/
  // token-sequence, 3 = loose substring) - Phase 8's confidence model needs
  // to tell an exact global-merchant hit apart from a fuzzier alias/
  // substring one, which findBestMatch already computes internally but
  // never surfaced past this module before. Undefined for a "keyword"-
  // source result (matchKeywordOverride doesn't go through findBestMatch at
  // all - a curated keyword trigger isn't tier-based) and for "none".
  matchTier?: 1 | 2 | 3;
}

const NO_MATCH: MerchantLookupResult = { source: "none" };

// Below this normalized length, a candidate may only match at a token
// boundary (tier 2) - never as a loose substring (tier 3). Protects short
// aliases like آپ/تاپ from matching inside unrelated words (e.g. "آپدیت").
// See the TODO(matcher) comments on those entries in lib/merchants.ts.
const MIN_SUBSTRING_MATCH_LENGTH = 4;

function tokenize(normalized: string): string[] {
  return normalized ? normalized.split(" ") : [];
}

function containsTokenSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

interface MatchCandidate<T> {
  text: string; // already normalized
  payload: T;
}

interface BestMatch<T> {
  text: string;
  payload: T;
  tier: 1 | 2 | 3;
}

// Tier 1 (exact): normalized input equals a candidate exactly.
// Tier 2 (alias): candidate's tokens appear as a contiguous run in the
//   input at word boundaries; the longest token run wins, so "اسنپ فود"
//   outranks "اسنپ" when both are present in the same text.
// Tier 3 (substring): raw substring containment, skipped for candidates
//   shorter than MIN_SUBSTRING_MATCH_LENGTH.
// A merchant's `name` and its `aliases` are fed in as equivalent
// candidates - a bare name inside a sentence is just as valid a hit as an
// alias.
function findBestMatch<T>(normalizedInput: string, candidates: MatchCandidate<T>[]): BestMatch<T> | null {
  const inputTokens = tokenize(normalizedInput);
  let best: BestMatch<T> | null = null;
  let bestTokenLength = 0;

  const consider = (c: MatchCandidate<T>, tier: 1 | 2 | 3) => {
    const tokenLength = tokenize(c.text).length;
    if (!best || tier < best.tier || (tier === best.tier && tokenLength > bestTokenLength)) {
      best = { text: c.text, payload: c.payload, tier };
      bestTokenLength = tokenLength;
    }
  };

  for (const c of candidates) {
    if (c.text && c.text === normalizedInput) consider(c, 1);
  }
  if (best) return best;

  for (const c of candidates) {
    if (containsTokenSequence(inputTokens, tokenize(c.text))) consider(c, 2);
  }
  if (best) return best;

  for (const c of candidates) {
    if (c.text.length >= MIN_SUBSTRING_MATCH_LENGTH && normalizedInput.includes(c.text)) consider(c, 3);
  }
  return best;
}

const DIGIT_TOKEN = /^[0-9]+$/;

// The same closed set of relative-date phrases lib/extract-date.ts treats
// as unambiguous day-offset signals (امروز/دیروز/پریروز/"هفته پیش") -
// reused here rather than reinvented, so the two stay in lockstep. "هفته"/
// "پیش" are stripped as individual tokens rather than requiring the exact
// two-token phrase: a merchantKey only needs to generalize across date
// variance, not parse an actual date, so dropping either word alone is
// safe for that narrower purpose and keeps this a plain token-membership
// check instead of duplicating containsTokenSequence's phrase matching.
const RELATIVE_DATE_TOKENS = new Set(["امروز", "دیروز", "پریروز", "هفته", "پیش"]);

// Derives the value stored in / matched against MerchantMapping.merchantKey
// from a transaction's raw input text. Write-side only - updateTransaction
// (lib/data/transactions.ts) is the one caller. lookupUserMapping below
// still matches a *stored* candidate's token sequence against the *new*,
// unstripped input (see findBestMatch/containsTokenSequence, tiers 2/3),
// which already tolerates extra tokens - like a trailing amount - in the
// haystack, so the read side needs no change for this to work.
//
// Bug this fixes (docs/roadmap-status.md, Phase 7/8 correction): the key
// used to be the entire raw SMS/typed text, amount included -
// normalizeText() never strips digits (see its own comment) - so two
// transactions at the same real merchant for two different amounts
// produced two different keys, and a learned mapping only ever re-matched
// an identical amount. Strips the two things that legitimately vary
// per-transaction at the same merchant and would otherwise get baked into
// the stored key: amount digits, and the closed set of relative-date words
// above. Word order of whatever tokens remain is preserved, so distinct
// merchants with differently-worded text still key differently (see
// lib/merchant-lookup.test.ts's false-positive guard).
//
// Known limit: a merchant name that itself contains one of the 5 stripped
// words (e.g. a shop literally named "امروز") would have that word dropped
// from its key too - accepted here for the same reason extractDate.ts
// already treats these five words as unambiguous, non-merchant signals
// wherever they appear, not something newly introduced by this function.
// Also known: only the amount's own digits are stripped, not a spelled-out
// scale word next to them (هزار/میلیون) - "۸۰ هزار تومن" and "۸۰۰۰۰ تومن"
// for the same purchase can still key differently. Out of scope here: the
// bug this fixes is specifically that digits were never stripped at all
// (normalizeText's own comment), not scale-word phrasing.
//
// Splits on digit/date tokens and keeps the *longest* remaining run,
// rather than filtering them out of the whole token list and rejoining
// what's left. Filter-and-rejoin would glue together tokens that were
// never adjacent in the original text - e.g. "فروشگاه ... هشتاد ۳۰۰۰۰
// تومن" would naively become "... هشتاد تومن", a false adjacency that a
// *different* amount's later mention (still carrying its own amount token
// between those two words) would never reproduce, since findBestMatch's
// tier 2 requires the stored candidate to appear as an exact contiguous
// run (see that function's own top-of-file comment, unchanged by this
// fix). Splitting into runs and keeping only the longest never invents an
// adjacency that wasn't already there, and as a side effect usually drops
// a trailing currency word (تومن/ریال) entirely, which is harmless since
// it carries no merchant-identifying signal anyway.
export function buildMerchantKey(rawInput: string): string {
  const tokens = normalizeText(toLatinDigits(rawInput))
    .split(" ")
    .filter(Boolean);

  const runs: string[][] = [[]];
  for (const token of tokens) {
    if (DIGIT_TOKEN.test(token) || RELATIVE_DATE_TOKENS.has(token)) {
      runs.push([]);
    } else {
      runs[runs.length - 1].push(token);
    }
  }

  const longestRun = runs.reduce((best, run) => (run.length > best.length ? run : best), []);
  return longestRun.join(" ");
}

const GLOBAL_CANDIDATES: MatchCandidate<DefaultMerchant>[] = DEFAULT_MERCHANTS.flatMap((merchant) => [
  { text: normalizeText(merchant.name), payload: merchant },
  ...merchant.aliases.map((alias) => ({ text: normalizeText(alias), payload: merchant })),
]);

function matchKeywordOverride(merchant: DefaultMerchant, normalizedInput: string) {
  if (!merchant.keywordOverrides?.length) return null;
  const inputTokens = tokenize(normalizedInput);
  for (const override of merchant.keywordOverrides) {
    if (containsTokenSequence(inputTokens, tokenize(normalizeText(override.keyword)))) {
      return override;
    }
  }
  return null;
}

// Global (lib/merchants.ts) tier only - no DB access, so this is safe to
// call directly in tests. Also used as the fallback tier inside
// findMerchant() below.
export function lookupGlobalMerchant(rawText: string): MerchantLookupResult {
  const normalizedInput = normalizeText(rawText);
  if (!normalizedInput) return NO_MATCH;

  const match = findBestMatch(normalizedInput, GLOBAL_CANDIDATES);
  if (!match) return NO_MATCH;

  const merchant = match.payload;
  const override = matchKeywordOverride(merchant, normalizedInput);
  if (override) {
    return {
      source: "keyword",
      category: override.category,
      subcategory: override.subcategory,
      merchantName: merchant.name,
      matchedText: override.keyword,
      type: merchant.type,
    };
  }

  return {
    source: "globalMerchant",
    category: merchant.defaultCategory,
    subcategory: merchant.defaultSubcategory,
    merchantName: merchant.name,
    matchedText: match.text,
    type: merchant.type,
    matchTier: match.tier,
  };
}

async function lookupUserMapping(userId: number, normalizedInput: string): Promise<MerchantLookupResult> {
  const mappings = await prisma.merchantMapping.findMany({
    where: { userId },
    include: { category: { include: { parent: true } } },
  });
  if (mappings.length === 0) return NO_MATCH;

  const candidates: MatchCandidate<(typeof mappings)[number]>[] = mappings.map((m) => ({
    text: normalizeText(m.merchantKey),
    payload: m,
  }));

  const match = findBestMatch(normalizedInput, candidates);
  if (!match) return NO_MATCH;

  const { category } = match.payload;
  return {
    source: "userMapping",
    category: category.parent ? category.parent.name : category.name,
    subcategory: category.parent ? category.name : undefined,
    merchantName: match.payload.merchantKey,
    matchedText: match.text,
    type: category.type as CategoryType,
    matchTier: match.tier,
  };
}

// Check order: user-specific learned mappings first, then the global
// merchant list (with keywordOverrides applied on top), then no match.
export async function findMerchant(userId: number, rawText: string): Promise<MerchantLookupResult> {
  const normalizedInput = normalizeText(rawText);
  if (!normalizedInput) return NO_MATCH;

  const userMatch = await lookupUserMapping(userId, normalizedInput);
  if (userMatch.source !== "none") return userMatch;

  return lookupGlobalMerchant(rawText);
}
