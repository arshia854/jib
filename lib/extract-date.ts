import { normalizeText } from "@/lib/normalize";

// Mirrors the date rules given to the AI prompt exactly (see
// buildSystemPrompt in lib/ai/parse-transaction.ts): no date mentioned, or
// "امروز", resolves to today; "دیروز" -> yesterday; "پریروز" -> day before
// yesterday. The AI itself has no rules beyond this closed set, so
// defaulting to today when none of the three keywords appear is not a
// guess - it's the same default the AI is instructed to use.
//
// Returns null only when the input contains more than one of these
// signals at once (e.g. both "دیروز" and "پریروز"), which is genuinely
// contradictory - that case falls back to the AI.
export function extractDate(rawText: string, now: Date = new Date()): string | null {
  const tokens = normalizeText(rawText).split(" ");

  const hasToday = tokens.includes("امروز");
  const hasYesterday = tokens.includes("دیروز");
  const hasDayBeforeYesterday = tokens.includes("پریروز");

  const signalCount = [hasToday, hasYesterday, hasDayBeforeYesterday].filter(Boolean).length;
  if (signalCount > 1) return null;

  const offsetDays = hasDayBeforeYesterday ? -2 : hasYesterday ? -1 : 0;
  return offsetDate(now, offsetDays);
}

function offsetDate(base: Date, days: number): string {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days));
  return d.toISOString().slice(0, 10);
}
