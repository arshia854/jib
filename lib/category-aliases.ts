// Lets findSimilarCategory() (lib/categories.ts) recognize that an AI-
// suggested new category is actually just a different name for a category
// that already exists, so we don't prompt the user to create a duplicate.
//
// - New aliases are added here only - the matching algorithm in
//   findSimilarCategory must never be touched to add one.
// - Canonical keys (the object keys below) must always correspond to an
//   actual existing seeded or user-created category name.
// - Alias chains are NOT allowed: every alias value must resolve directly
//   to exactly one canonical category. findSimilarCategory does a single-
//   level dictionary lookup only, never a walk - so a value here must never
//   also appear as a key that itself needs resolving (e.g. "سیگار" ->
//   "دخانیات" is fine; "سیگار" -> "دخانیات" -> "مصرف دخانی" as a further
//   chained lookup must never happen).
export const CATEGORY_ALIASES: Record<string, string[]> = {
  "دخانیات": ["سیگار", "توتون", "تنباکو", "ویپ"],
  "سوپرمارکت": ["خواروبار"],
  "دارو": ["داروخانه"],
};
