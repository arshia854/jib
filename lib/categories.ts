export type CategoryType = "income" | "expense";

// The default category *set* itself moved from a static array here to the
// admin-managed DefaultCategory table (see lib/data/onboarding.ts, which
// seeds a new user's own Category rows from it, and lib/data/admin-categories.ts,
// which is the CRUD surface at app/app/admin/categories).

export const DEFAULT_ACCOUNT = {
  name: "کیف پول",
  type: "cash",
  initialBalance: 0,
};
