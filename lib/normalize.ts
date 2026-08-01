const ARABIC_YEH = /ي/g; // ي -> ی
const ARABIC_KAF = /ك/g; // ك -> ک
const ZERO_WIDTH_NON_JOINER = /‌/g; // half-space
const PUNCTUATION = /[.,!?؟،؛:"'«»()\[\]{}\-_/\\]/g;
const PERSIAN_DIGITS = /[۰-۹]/g;
const ARABIC_INDIC_DIGITS = /[٠-٩]/g;

export function normalizeText(input: string): string {
  return input
    .replace(ARABIC_YEH, "ی")
    .replace(ARABIC_KAF, "ک")
    .replace(ZERO_WIDTH_NON_JOINER, " ")
    .toLowerCase()
    .replace(PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Kept separate from normalizeText: only the numeric extractors need
// digit conversion, and folding it into normalizeText would change
// behavior for every existing merchant-matching call site.
export function toLatinDigits(input: string): string {
  return input
    .replace(PERSIAN_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660));
}
