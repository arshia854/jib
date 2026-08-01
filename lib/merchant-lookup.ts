import { prisma } from "@/lib/prisma";
import { normalizeText } from "@/lib/normalize";
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
