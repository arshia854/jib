import { normalizeText } from "@/lib/normalize";

// Mirrors the date rules given to the AI prompt exactly (see
// buildSystemPrompt in lib/ai/parse-transaction.ts): no date mentioned, or
// "امروز", resolves to today; "دیروز" -> yesterday; "پریروز" -> day before
// yesterday; "هفته پیش" -> 7 days ago. The AI itself has no rules beyond
// this closed set, so defaulting to today when none of the four keywords
// appear is not a guess - it's the same default the AI is instructed to
// use.
//
// "هفته پیش" is matched as a two-token phrase (not just "هفته") since
// "هفته" alone is ambiguous ("هفته دیگه میام" is about the future, not -7
// days) - only the trailing "پیش" makes it an unambiguous backward
// reference, mirroring how "پریروز"/"دیروز" are themselves unambiguous.
//
// Returns null only when the input contains more than one of these
// signals at once (e.g. both "دیروز" and "پریروز"), which is genuinely
// contradictory - that case falls back to the AI.
export function extractDate(rawText: string, now: Date = new Date()): string | null {
  const tokens = normalizeText(rawText).split(" ");

  const hasToday = tokens.includes("امروز");
  const hasYesterday = tokens.includes("دیروز");
  const hasDayBeforeYesterday = tokens.includes("پریروز");
  const hasWeekAgo = containsTokenSequence(tokens, ["هفته", "پیش"]);

  const signalCount = [hasToday, hasYesterday, hasDayBeforeYesterday, hasWeekAgo].filter(Boolean).length;
  if (signalCount > 1) return null;

  const offsetDays = hasWeekAgo ? -7 : hasDayBeforeYesterday ? -2 : hasYesterday ? -1 : 0;
  return offsetDate(now, offsetDays);
}

function containsTokenSequence(tokens: string[], needle: string[]): boolean {
  outer: for (let i = 0; i <= tokens.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (tokens[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function offsetDate(base: Date, days: number): string {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days));
  return d.toISOString().slice(0, 10);
}
