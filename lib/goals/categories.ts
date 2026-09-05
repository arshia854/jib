import type { GoalCategory } from "@/lib/data/goals";

export interface GoalCategoryMeta {
  emoji: string;
  label: string;
}

// Persian label + emoji per lib/data/goals.ts's GOAL_CATEGORIES value - that
// file is "server-only" (Phase 1, frozen this phase), so only its *type*
// (GoalCategory, erased at compile time - no runtime import) is pulled in
// here, keeping this file itself safely importable from a "use client"
// component (components/goals/goals-manager.tsx's category picker). The
// `Record<GoalCategory, ...>` below is exhaustive by construction - if
// GOAL_CATEGORIES' union ever grows, this fails to compile until a matching
// entry is added, the same safety net STATUS_TONE (NarrativeReportCard.tsx)
// gets from being keyed by its own status union.
//
// Confirmed with the project owner (per this feature's own product framing):
// device -> "مک‌بوک" (this phase's own worked example of a device goal, not
// a generic "دستگاه" label), travel/car/emergency_fund/home_down_payment as
// below. "other" wasn't given up front and was confirmed separately.
export const GOAL_CATEGORY_META: Record<GoalCategory, GoalCategoryMeta> = {
  device: { emoji: "🎯", label: "مک‌بوک" },
  travel: { emoji: "🏖", label: "سفر" },
  car: { emoji: "🚗", label: "ماشین" },
  emergency_fund: { emoji: "💰", label: "صندوق اضطراری" },
  home_down_payment: { emoji: "🏠", label: "رهن خانه" },
  other: { emoji: "🎯", label: "سایر" },
};

const GOAL_CATEGORY_KEYS = Object.keys(GOAL_CATEGORY_META) as GoalCategory[];

/**
 * Ordered {value, emoji, label} list for the create/edit form's category
 * picker - derived from GOAL_CATEGORY_META itself (not a second hand-written
 * list) so the two can never drift apart.
 */
export const GOAL_CATEGORY_OPTIONS: { value: GoalCategory; emoji: string; label: string }[] = GOAL_CATEGORY_KEYS.map(
  (value) => ({ value, ...GOAL_CATEGORY_META[value] })
);

/**
 * Defensive lookup for a goal's `category` field - a plain DB string at
 * runtime (GoalWithFeasibility.category isn't statically narrowed to
 * GoalCategory - see lib/data/goals.ts), not provably one of the 6 known
 * values from a type-checker's point of view. Falls back to "other"'s meta
 * rather than rendering `undefined`/crashing - the API's own validation
 * (app/api/goals/route.ts) means this should never actually happen for a
 * goal created through this app, but a stale/foreign row is better shown
 * with a generic label than broken.
 */
export function getGoalCategoryMeta(category: string): GoalCategoryMeta {
  return GOAL_CATEGORY_META[category as GoalCategory] ?? GOAL_CATEGORY_META.other;
}
