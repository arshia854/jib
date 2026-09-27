import type { FactKey } from "./known-facts";

// UI copy for the small set of user-stated facts collected as quick-select
// questions - first as optional/skippable steps at the end of onboarding
// (app/onboarding/page.tsx), and again later in Settings for anyone who
// skipped or wants to change their answer (components/settings/profile-facts-form.tsx).
// Both surfaces import this one list so the question wording and option
// labels can't drift apart between the two places a user sees them.
//
// Deliberately separate from lib/facts/known-facts.ts's KNOWN_FACTS: that
// registry is the validation source of truth (key + allowedValues, checked
// server-side in app/api/facts/route.ts) and intentionally has no
// user-facing copy. Every `value` below must still match one of that key's
// allowedValues - there's no runtime check tying the two together, so a
// value here that drifts from KNOWN_FACTS would just always get rejected by
// the API instead of failing loudly at compile time.
//
// `emoji` is kept split out from `label` (rather than inlined at the front
// of the label string, as it used to be) so each surface can lay them out
// differently - the onboarding wizard's big option cards vs. Settings'
// compact chips (which just recombine them as `${emoji} ${label}`) -
// without either side parsing emoji back out of a string at render time.

export interface FactOption {
  value: string;
  emoji: string;
  label: string;
}

export interface FactQuestion {
  key: FactKey;
  // Shown as a small badge above the question in the onboarding wizard -
  // purely decorative, not used by Settings' compact chip layout.
  emoji: string;
  question: string;
  options: FactOption[];
}

export const ONBOARDING_FACT_QUESTIONS: FactQuestion[] = [
  {
    key: "employment_status",
    emoji: "🧑‍💼",
    question: "وضعیت شغلی‌ت چیه؟",
    options: [
      { value: "employed", emoji: "👔", label: "کارمند" },
      { value: "self_employed", emoji: "💼", label: "آزاد / فریلنسر" },
      { value: "business_owner", emoji: "🏪", label: "صاحب کسب‌وکار" },
      { value: "student", emoji: "🎓", label: "دانشجو" },
      { value: "unemployed", emoji: "🏠", label: "غیرشاغل" },
    ],
  },
  {
    key: "income_regularity",
    emoji: "💸",
    question: "درآمدت هرماه تقریباً ثابته یا متغیره؟",
    options: [
      { value: "regular", emoji: "📈", label: "ثابت" },
      { value: "irregular", emoji: "🎲", label: "متغیر" },
    ],
  },
  {
    key: "account_structure",
    emoji: "🧾",
    question: "چطور حساب‌هاتو مدیریت می‌کنی؟",
    options: [
      { value: "single_account", emoji: "👛", label: "یک حساب ساده" },
      { value: "multi_account", emoji: "🏦", label: "چند حساب یا کارت" },
    ],
  },
];
