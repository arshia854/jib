"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";

interface CategoryOption {
  id: number;
  name: string;
  type: string;
  icon: string;
}

export function TransactionFilterBar({ categories }: { categories: CategoryOption[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const type = searchParams.get("type") ?? "all";
  const categoryId = searchParams.get("categoryId") ?? "all";

  function updateParams(next: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === "all") params.delete(key);
      else params.set(key, value);
    }
    // A filter change invalidates whatever page the user was on - land back
    // on page 1 instead of e.g. showing an empty "page 4" of a now much
    // smaller filtered result set.
    params.delete("page");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  const filteredCategories = categories.filter((c) => type === "all" || c.type === type);

  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      <select
        value={type}
        onChange={(e) => updateParams({ type: e.target.value, categoryId: "all" })}
        className="shrink-0 rounded-xl border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none"
      >
        <option value="all">همه تراکنش‌ها</option>
        <option value="income">فقط درآمد</option>
        <option value="expense">فقط هزینه</option>
      </select>

      <select
        value={categoryId}
        onChange={(e) => updateParams({ categoryId: e.target.value })}
        className="shrink-0 rounded-xl border border-border bg-surface px-3 py-2 text-xs text-foreground outline-none"
      >
        <option value="all">همه دسته‌ها</option>
        {filteredCategories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.icon} {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
