export type CategoryType = "income" | "expense";

export interface DefaultCategory {
  name: string;
  icon: string;
  color: string;
  type: CategoryType;
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  // expense
  { name: "خوراک و رستوران", icon: "🍔", color: "#F97316", type: "expense" },
  { name: "حمل‌ونقل", icon: "🚗", color: "#3B82F6", type: "expense" },
  { name: "خرید", icon: "🛍️", color: "#EC4899", type: "expense" },
  { name: "قبوض و اشتراک", icon: "🧾", color: "#64748B", type: "expense" },
  { name: "سلامت و درمان", icon: "💊", color: "#EF4444", type: "expense" },
  { name: "سرگرمی", icon: "🎬", color: "#8B5CF6", type: "expense" },
  { name: "مسکن", icon: "🏠", color: "#1E3A8A", type: "expense" },
  { name: "آموزش", icon: "📚", color: "#06B6D4", type: "expense" },
  { name: "سایر", icon: "📦", color: "#94A3B8", type: "expense" },
  // income
  { name: "حقوق", icon: "💰", color: "#10B981", type: "income" },
  { name: "فریلنس", icon: "💼", color: "#3B82F6", type: "income" },
  { name: "سرمایه‌گذاری", icon: "📈", color: "#1E3A8A", type: "income" },
  { name: "هدیه", icon: "🎁", color: "#EC4899", type: "income" },
  { name: "سایر", icon: "📦", color: "#94A3B8", type: "income" },
];

export const DEFAULT_ACCOUNT = {
  name: "کیف پول",
  type: "cash",
  initialBalance: 0,
};
