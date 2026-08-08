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

export interface FactOption {
  value: string;
  label: string;
}

export interface FactQuestion {
  key: FactKey;
  question: string;
  options: FactOption[];
}

export const ONBOARDING_FACT_QUESTIONS: FactQuestion[] = [
  {
    key: "employment_status",
    question: "وضعیت شغلی‌ت چیه؟",
    options: [
      { value: "employed", label: "👔 کارمند" },
      { value: "self_employed", label: "💼 آزاد / فریلنسر" },
      { value: "business_owner", label: "🏪 صاحب کسب‌وکار" },
      { value: "student", label: "🎓 دانشجو" },
      { value: "unemployed", label: "🏠 غیرشاغل" },
    ],
  },
  {
    key: "income_regularity",
    question: "درآمدت هرماه تقریباً ثابته یا متغیره؟",
    options: [
      { value: "regular", label: "📈 ثابت" },
      { value: "irregular", label: "🎲 متغیر" },
    ],
  },
  {
    key: "account_structure",
    question: "چطور حساب‌هاتو مدیریت می‌کنی؟",
    options: [
      { value: "single_account", label: "👛 یک حساب ساده" },
      { value: "multi_account", label: "🏦 چند حساب یا کارت" },
    ],
  },
];
