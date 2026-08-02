const LINE_BREAKS = /\r\n|\r|\n/g;
const WHITESPACE_RUN = /\s+/g;

const PERSIAN_DIGITS = /[۰-۹]/g;
const PERSIAN_DIGIT_OFFSET = 0x06f0;
const ARABIC_INDIC_DIGITS = /[٠-٩]/g;
const ARABIC_INDIC_DIGIT_OFFSET = 0x0660;

const ARABIC_YEH = /ي/g; // ي -> ی
const ARABIC_KAF = /ك/g; // ك -> ک

// Invisible/formatting code points to strip: zero-width space, ZWJ, LRM,
// RLM, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI, BOM, Arabic letter mark.
// U+200C (ZWNJ / نیم‌فاصله) is deliberately excluded: it's a meaningful
// Persian half-space used in real words (e.g. می‌خواستم), and stripping
// it would corrupt keyword matching downstream.
const INVISIBLE_CODE_POINTS = [
  0x200b, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069, 0xfeff, 0x061c,
];
const INVISIBLE_AND_RTL_MARKS = new RegExp(
  `[${INVISIBLE_CODE_POINTS.map((code) => String.fromCharCode(code)).join("")}]`,
  "g"
);

export function normalizeText(input: string): string {
  return input
    .replace(INVISIBLE_AND_RTL_MARKS, "")
    .replace(PERSIAN_DIGITS, (digit) =>
      String(digit.charCodeAt(0) - PERSIAN_DIGIT_OFFSET)
    )
    .replace(ARABIC_INDIC_DIGITS, (digit) =>
      String(digit.charCodeAt(0) - ARABIC_INDIC_DIGIT_OFFSET)
    )
    .replace(ARABIC_YEH, "ی")
    .replace(ARABIC_KAF, "ک")
    .replace(LINE_BREAKS, " ")
    .replace(WHITESPACE_RUN, " ")
    .trim();
}
