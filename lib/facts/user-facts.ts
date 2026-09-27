import { prisma } from "@/lib/prisma";
import { getKnownFact, isKnownFactKey } from "./known-facts";

export type FactSource = "user_stated" | "inferred";

export interface UserFact {
  id: number;
  userId: number;
  key: string;
  value: string;
  source: FactSource;
  confidence: number | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class UnknownFactKeyError extends Error {}
export class FactNotInferableError extends Error {}

// Prisma stores `source` as a plain string (same convention as
// FinanceAccount.type, Category.type, ...) - narrow it once here, same
// pattern as `role: u.role as UserRole` in lib/data/admin-users.ts.
function toUserFact(row: {
  id: number;
  userId: number;
  key: string;
  value: string;
  source: string;
  confidence: number | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}): UserFact {
  return { ...row, source: row.source as FactSource };
}

export async function getUserFacts(userId: number): Promise<UserFact[]> {
  const rows = await prisma.userFact.findMany({ where: { userId }, orderBy: { key: "asc" } });
  return rows.map(toUserFact);
}

/**
 * Records something the user said explicitly about themselves. Always
 * authoritative: overwrites an existing "inferred" row for the same key
 * outright, and updates an existing "user_stated" row if the user is
 * changing their mind - either way there's exactly one current row per
 * (userId, key), per UserFact's unique constraint.
 */
export async function setUserStatedFact(
  userId: number,
  key: string,
  value: string,
  note?: string
): Promise<UserFact> {
  if (!isKnownFactKey(key)) {
    throw new UnknownFactKeyError(`کلید نامعتبر است: "${key}"`);
  }

  const row = await prisma.userFact.upsert({
    where: { userId_key: { userId, key } },
    create: { userId, key, value, source: "user_stated", confidence: null, note: note ?? null },
    update: { value, source: "user_stated", confidence: null, note: note ?? null },
  });

  return toUserFact(row);
}

/**
 * Records a rule-based guess (see lib/facts/infer-facts.ts) about the user.
 * Never overwrites an existing "user_stated" row for the same key - the
 * user's explicit word always wins, so this is a no-op (returns null)
 * rather than an error in that case, since losing a race against the
 * user's own statement is expected, normal behavior, not a failure.
 */
export async function setInferredFact(
  userId: number,
  key: string,
  value: string,
  confidence: number,
  note?: string
): Promise<UserFact | null> {
  const known = getKnownFact(key);
  if (!known) {
    throw new UnknownFactKeyError(`کلید نامعتبر است: "${key}"`);
  }
  if (!known.inferable) {
    throw new FactNotInferableError(`کلید "${key}" قابل استنتاج خودکار نیست.`);
  }

  const existing = await prisma.userFact.findUnique({ where: { userId_key: { userId, key } } });
  if (existing && (existing.source as FactSource) === "user_stated") {
    return null;
  }

  const row = await prisma.userFact.upsert({
    where: { userId_key: { userId, key } },
    create: { userId, key, value, source: "inferred", confidence, note: note ?? null },
    update: { value, source: "inferred", confidence, note: note ?? null },
  });

  return toUserFact(row);
}

// Below this, an inferred fact is kept in the DB for future re-evaluation
// but not yet asserted to the LLM as if certain. 0.6 is picked as a "more
// likely true than not, with real margin" cutoff: high enough that a
// near-coinflip guess (~0.5) never reaches the prompt, low enough that the
// rule-based inferers in lib/facts/infer-facts.ts - which are designed to
// either land confidently (~0.7-0.9) or skip writing anything at all -
// aren't stuck under it.
const MIN_CONFIDENCE_FOR_PROMPT = 0.6;

// Persian rendering of each (key, value) pair, in the same short-line style
// as lib/data/chat-context.ts's other formatters. Returns null for a value
// outside the registered vocabulary (e.g. stale data from a since-changed
// registry) so it's skipped rather than printed raw.
const EMPLOYMENT_STATUS_LABELS_FA: Record<string, string> = {
  employed: "کارمند است",
  self_employed: "شغل آزاد/فریلنسری دارد",
  business_owner: "صاحب کسب‌وکار است",
  student: "دانشجو است",
  unemployed: "شاغل نیست",
};

const FACT_LABELS_FA: Record<string, (value: string) => string | null> = {
  has_car: (v) => (v === "true" ? "ماشین دارد" : v === "false" ? "ماشین ندارد" : null),
  is_renter: (v) => (v === "true" ? "مستأجر است" : v === "false" ? "مالک مسکن است" : null),
  income_regularity: (v) => (v === "regular" ? "درآمد منظم دارد" : v === "irregular" ? "درآمد نامنظم دارد" : null),
  has_dependents: (v) => (v === "true" ? "افراد تحت تکفل دارد" : v === "false" ? "افراد تحت تکفل ندارد" : null),
  employment_status: (v) => EMPLOYMENT_STATUS_LABELS_FA[v] ?? null,
  account_structure: (v) =>
    v === "single_account" ? "یک حساب مالی ساده دارد" : v === "multi_account" ? "چند حساب/کارت مالی دارد" : null,
};

/** Compact Persian text block of known facts, for injection into the chat system prompt. */
export function formatFactsForPrompt(facts: UserFact[]): string {
  const lines: string[] = [];

  for (const fact of facts) {
    if (fact.source === "inferred" && (fact.confidence ?? 0) < MIN_CONFIDENCE_FOR_PROMPT) continue;

    const label = FACT_LABELS_FA[fact.key]?.(fact.value);
    if (!label) continue;

    lines.push(`- ${label}`);
  }

  return lines.length > 0 ? lines.join("\n") : "اطلاعاتی ثبت نشده";
}
