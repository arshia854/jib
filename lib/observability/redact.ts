// Recursively masks values for keys that look sensitive, so nothing logged
// through logger.ts or reported to Sentry can leak a real secret/credential
// just because some nested object happened to carry one under an
// unexpected key. Deliberately dumb and key-name-based, not value-pattern
// sniffing (e.g. "looks like a card number") - every sensitive field this
// codebase actually has is plainly named wherever it appears (see
// .env.example: AUTH_SECRET, OTP_SECRET, LEGACY_SESSION_SECRET,
// NVIDIA_API_KEY, MELIPAYAMAK_PASSWORD, TURSO_AUTH_TOKEN,
// GOOGLE_CLIENT_SECRET - every one contains "secret", "token", "password",
// or "key"), so key-name matching already covers this codebase's real
// sensitive fields without guessing at new categories beyond the Phase 12
// spec's own list.
//
// Keyword list is exactly what the Phase 12 spec names - password, token,
// creditCard, ssn, cvv, secret, apiKey - matched case-insensitively as a
// substring of the key (not just an exact-name match), so "userPassword",
// "apiKeySecret", "OTP_SECRET", "refreshToken" etc. are all caught too.
const SENSITIVE_KEYWORDS = ["password", "token", "creditcard", "ssn", "cvv", "secret", "apikey"];

const REDACTED = "[REDACTED]";
const REDACTED_NUMBER = "[REDACTED_NUMBER]";
const CIRCULAR = "[Circular]";

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYWORDS.some((word) => lower.includes(word));
}

// Phase 6 privacy-audit addition: key-based redaction above only helps when
// a field is *named* like a secret. It does nothing for a raw bank SMS (or
// an AI response echoing fragments of one) sitting under an innocuously
// named field like `text`/`rawInput`/`message`, or - confirmed live during
// this audit, see the sample log line in the Phase 6 report - inside a
// native `JSON.parse` SyntaxError's own `.message`, which quotes a snippet
// of whatever string it failed to parse (lib/ai/parse-transaction.ts's
// extractJson() throws exactly this when the AI returns malformed JSON,
// and that JSON is built from a prompt containing the user's raw
// rawInput/chat text - see lib/ai/parse-transaction.ts and
// lib/ai/detect-transaction-intent.ts). This matches the *shape* of a
// financial identifier instead: a run of at least 9 digits (ASCII, Persian
// ۰-۹, or Arabic-Indic ٠-٩ - real bank SMS use all three, see
// lib/bank/normalize.ts), each optionally separated by one space or dash
// (how card numbers are usually rendered, e.g. "6104 3378 1234 5678").
// Nine digits comfortably covers 16-digit card numbers, Sheba/IBAN
// numbers, typical 10-20 digit Iranian account/reference numbers, 10-digit
// national IDs, and 11-digit mobile numbers, while staying well clear of
// every numeric field this codebase actually logs today - duration,
// userId, contentLength, rawInputLength, messageLength, etc. are all
// logged as JS `number`s, which never reach this pattern at all (see
// redactValue below: it only runs string values through this, and numbers
// pass through the `typeof value !== "object"` branch unchanged, exactly
// as before this change).
//
// This deliberately trades a small amount of over-redaction (a coincidental
// 9+ digit run that isn't actually a financial identifier gets masked too)
// for avoiding under-redaction, which is the wrong tradeoff to get wrong in
// a fintech app's logs/Sentry reports.
const DIGIT = "[0-9۰-۹٠-٩]";
const SENSITIVE_DIGIT_RUN = new RegExp(`${DIGIT}(?:[ -]?${DIGIT}){8,}`, "g");

function redactSensitiveNumbers(text: string): string {
  return text.replace(SENSITIVE_DIGIT_RUN, REDACTED_NUMBER);
}

// `ancestors` tracks only the current root-to-here path, not every object
// visited overall - added right before recursing into a value's children
// and removed again right after. That way a cycle back to an object still
// on the current path is caught and masked as "[Circular]", while the same
// object reachable twice via two different, non-circular branches (e.g. a
// shared reference) is still walked/redacted both times instead of being
// incorrectly flagged as circular the second time.
function redactValue(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "string") {
    return redactSensitiveNumbers(value);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (ancestors.has(value)) {
    return CIRCULAR;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, ancestors));
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // A key matching SENSITIVE_KEYWORDS is flattened to REDACTED unless
      // its value is a number - every real secret/token/password this
      // codebase has (see the .env.example list above) is always a string,
      // so there's no legitimate case where a *sensitive* value is numeric.
      // A number under such a key (promptTokens/completionTokens/
      // totalTokens from AI usage objects, e.g. lib/nvidia-ai.ts) is just a
      // count that happens to share the word "token" with its key name, so
      // it falls through to normal recursion (a no-op for numbers) instead
      // of being masked.
      result[key] = isSensitiveKey(key) && typeof val !== "number" ? REDACTED : redactValue(val, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Returns a deep copy of `value` with:
 * - every object key matching a sensitive keyword (see SENSITIVE_KEYWORDS
 *   above) replaced with "[REDACTED]"
 * - every 9-or-more-digit run inside any string (at any depth, including a
 *   bare string passed directly) replaced with "[REDACTED_NUMBER]" (Phase
 *   6 addition - see SENSITIVE_DIGIT_RUN above)
 *
 * Pure - never mutates its input. Handles arrays and circular references
 * without throwing; non-object, non-string inputs (numbers, booleans, null,
 * undefined) pass through unchanged.
 */
export function redact<T>(value: T): T {
  return redactValue(value, new Set<object>()) as T;
}
