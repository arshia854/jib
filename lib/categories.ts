import { normalizeText } from "@/lib/normalize";
import { CATEGORY_ALIASES } from "@/lib/category-aliases";
import type { CategoryOption } from "@/lib/ai/parse-transaction";

export type CategoryType = "income" | "expense";

// The default category *set* itself moved from a static array here to the
// admin-managed DefaultCategory table (see lib/data/onboarding.ts, which
// seeds a new user's own Category rows from it, and lib/data/admin-categories.ts,
// which is the CRUD surface at app/app/admin/categories).

export const DEFAULT_ACCOUNT = {
  name: "کیف پول",
  type: "cash",
  initialBalance: 0,
};

// Below this shared-token ratio (intersection size / size of the shorter
// name's token set), an overlap is treated as coincidental - e.g. sharing
// one generic word - rather than a genuine near-match, so stage 3 below
// picks no candidate at all rather than risk merging two truly different
// categories. Mirrors how lib/merchant-lookup.ts's MIN_SUBSTRING_MATCH_LENGTH
// documents its own match threshold as a named constant.
const TOKEN_OVERLAP_THRESHOLD = 0.5;

function tokenSet(name: string): Set<string> {
  return new Set(normalizeText(name).split(" ").filter(Boolean));
}

function tokenOverlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared++;
  }
  return shared / Math.min(a.size, b.size);
}

// Stage 3 fallback: loosest of the three stages, so it only runs once
// exact-match and alias-lookup have both missed (see matchWithinCandidates
// below). Ties are broken by candidates array order - the first candidate
// to reach a given ratio keeps it, since replacement below requires a
// strictly higher ratio - rather than leaving it to whatever order
// Array.prototype.find/reduce would otherwise produce silently.
function findTokenOverlapMatch(
  suggestionTokens: Set<string>,
  candidates: CategoryOption[],
  type: CategoryType
): CategoryOption | null {
  let best: CategoryOption | null = null;
  let bestRatio = 0;
  for (const c of candidates) {
    if (c.type !== type) continue;
    const ratio = tokenOverlapRatio(suggestionTokens, tokenSet(c.name));
    if (ratio > bestRatio) {
      best = c;
      bestRatio = ratio;
    }
  }
  return bestRatio >= TOKEN_OVERLAP_THRESHOLD ? best : null;
}

// Deterministic icon for a brand-new category the AI suggests (see
// SuggestedCategory in lib/ai/parse-transaction.ts) - resolved here,
// server-side, so the same category name always renders the same icon
// regardless of what (if anything) the model said about it; the AI's raw
// response is never trusted for this (sanitizeNewCategorySuggestion
// already drops a hallucinated `icon` key before this is ever called).
// Same style as CATEGORY_ALIASES: a small lookup table over known names,
// with a generic fallback for anything not listed here.
const NEW_CATEGORY_ICONS: Record<string, string> = {
  "دخانیات": "🚬",
  "لوازم حیوان خانگی": "🐾",
  "ورزش": "🏋️",
  "بیمه": "🛡️",
  "خیریه": "❤️",
  "اشتراک": "🔄",
};

const DEFAULT_NEW_CATEGORY_ICON = "📦";

export function resolveNewCategoryIcon(name: string): string {
  return NEW_CATEGORY_ICONS[normalizeText(name)] ?? DEFAULT_NEW_CATEGORY_ICON;
}

// Runs the exact-match / alias-lookup / token-overlap stages (in that
// order, each only reached if the previous ones found nothing) against a
// single candidate list - shared by findSimilarCategory's same-parent and
// cross-parent passes below so the three stages stay in one place.
function matchWithinCandidates(
  normalizedSuggestion: string,
  suggestionTokens: Set<string>,
  candidates: CategoryOption[],
  type: CategoryType,
  aliasRegistry: Record<string, string[]>
): CategoryOption | null {
  // Stage 1: exact (normalized) name match.
  const direct = candidates.find((c) => c.type === type && normalizeText(c.name) === normalizedSuggestion);
  if (direct) return direct;

  // Stage 2: single-level alias-registry lookup.
  const canonicalName = Object.keys(aliasRegistry).find((canonical) =>
    aliasRegistry[canonical].some((alias) => normalizeText(alias) === normalizedSuggestion)
  );
  if (canonicalName) {
    const normalizedCanonical = normalizeText(canonicalName);
    const aliasMatch = candidates.find((c) => c.type === type && normalizeText(c.name) === normalizedCanonical);
    if (aliasMatch) return aliasMatch;
  }

  // Stage 3: token-overlap fallback.
  return findTokenOverlapMatch(suggestionTokens, candidates, type);
}

// Guards the AI's newCategorySuggestion (see SuggestedCategory in
// lib/ai/parse-transaction.ts) against proposing a category that's really
// just a rename of one that already exists - literally (same name,
// different formatting), via a known alias (e.g. AI suggests "دخانیات"
// while the user's own category is already "سیگار"), or via loose
// shared-wording (stage 3).
//
// When suggestion.parentName is set, existing categories under that same
// parent (CategoryOption.parentName) are tried first through all three
// stages; only if none of them match at any stage does the search widen to
// the full existingCategories list. A null parentName skips straight to
// the full-list search.
//
// aliasRegistry is injectable (defaulting to the real CATEGORY_ALIASES) so
// callers/tests can prove new aliases only ever require a registry change:
// this function never contains alias strings of its own, and only ever
// does a single dictionary lookup - it must never chase an alias value
// that happens to also be a key elsewhere in the registry.
export function findSimilarCategory(
  suggestion: { name: string; parentName: string | null },
  existingCategories: CategoryOption[],
  type: CategoryType,
  aliasRegistry: Record<string, string[]> = CATEGORY_ALIASES
): CategoryOption | null {
  const normalizedSuggestion = normalizeText(suggestion.name);
  const suggestionTokens = tokenSet(suggestion.name);

  if (suggestion.parentName !== null) {
    const sameParent = existingCategories.filter((c) => c.parentName === suggestion.parentName);
    const sameParentMatch = matchWithinCandidates(
      normalizedSuggestion,
      suggestionTokens,
      sameParent,
      type,
      aliasRegistry
    );
    if (sameParentMatch) return sameParentMatch;
  }

  return matchWithinCandidates(normalizedSuggestion, suggestionTokens, existingCategories, type, aliasRegistry);
}
