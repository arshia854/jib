// Single source of truth for every UserFact.key this system knows about
// (see prisma/schema.prisma's UserFact model). Keys are a small fixed
// vocabulary, never free text - lib/facts/user-facts.ts validates every
// write against this registry instead of trusting the caller, and
// lib/facts/infer-facts.ts checks `inferable` before writing an automatic
// guess. Add a new fact here first, before referencing its key anywhere
// else - never invent a key string ad-hoc at a call site.

export type FactKey =
  | "has_car"
  | "is_renter"
  | "income_regularity"
  | "has_dependents"
  | "employment_status"
  | "account_structure";

export interface KnownFact {
  key: FactKey;
  // Short Persian description for a future admin/debugging UI - not shown
  // to end users.
  descriptionFa: string;
  // The fixed vocabulary UserFact.value must belong to for this key.
  allowedValues: readonly string[];
  // Whether lib/facts/infer-facts.ts is allowed to write this fact
  // automatically via setInferredFact. false means it can only ever come
  // from setUserStatedFact.
  inferable: boolean;
}

export const KNOWN_FACTS: Record<FactKey, KnownFact> = {
  has_car: {
    key: "has_car",
    descriptionFa: "آیا کاربر ماشین دارد؟",
    allowedValues: ["true", "false"],
    inferable: true,
  },
  is_renter: {
    key: "is_renter",
    descriptionFa: "آیا کاربر مستأجر است؟",
    allowedValues: ["true", "false"],
    inferable: true,
  },
  income_regularity: {
    key: "income_regularity",
    descriptionFa: "آیا درآمد کاربر منظم است یا نامنظم؟",
    allowedValues: ["regular", "irregular"],
    inferable: true,
  },
  // Too sensitive/unreliable to guess from transaction history alone (a
  // large recurring expense could be many things besides supporting a
  // dependent) - only ever set via the user's own words.
  has_dependents: {
    key: "has_dependents",
    descriptionFa: "آیا کاربر افراد تحت تکفل دارد؟",
    allowedValues: ["true", "false"],
    inferable: false,
  },
  // Asked directly during onboarding (see lib/facts/onboarding-questions.ts)
  // rather than guessed - a transaction category alone can't distinguish
  // "کارمند" from "صاحب کسب‌وکار" the way a fixed اجاره/بنزین pattern can
  // for is_renter/has_car above, so this only ever comes from the user's
  // own answer.
  employment_status: {
    key: "employment_status",
    descriptionFa: "وضعیت شغلی کاربر چیست؟",
    allowedValues: ["employed", "self_employed", "business_owner", "student", "unemployed"],
    inferable: false,
  },
  // Whether the user manages money through one simple account or spreads it
  // across several accounts/cards. Could in principle be derived from
  // FinanceAccount.count, but that reflects what's *set up* in the app, not
  // necessarily the user's own mental model of their finances (e.g. someone
  // who added a second account just to try it out) - so this stays a direct,
  // user-stated question like employment_status above, not inferred.
  account_structure: {
    key: "account_structure",
    descriptionFa: "کاربر یک حساب ساده دارد یا چند حساب/کارت؟",
    allowedValues: ["single_account", "multi_account"],
    inferable: false,
  },
};

export function isKnownFactKey(key: string): key is FactKey {
  return Object.prototype.hasOwnProperty.call(KNOWN_FACTS, key);
}

export function getKnownFact(key: string): KnownFact | undefined {
  return isKnownFactKey(key) ? KNOWN_FACTS[key] : undefined;
}
