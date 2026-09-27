"use client";

import type { ReactNode } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { FilterIcon, TagIcon, ChevronDownIcon } from "@/components/icons";

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
    <div className="grid grid-cols-2 gap-2">
      <FilterSelect
        icon={<FilterIcon className="h-4 w-4" />}
        active={type !== "all"}
        value={type}
        onChange={(value) => updateParams({ type: value, categoryId: "all" })}
      >
        <option value="all">همه تراکنش‌ها</option>
        <option value="income">فقط درآمد</option>
        <option value="expense">فقط هزینه</option>
      </FilterSelect>

      <FilterSelect
        icon={<TagIcon className="h-4 w-4" />}
        active={categoryId !== "all"}
        value={categoryId}
        onChange={(value) => updateParams({ categoryId: value })}
      >
        <option value="all">همه دسته‌ها</option>
        {filteredCategories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.icon} {c.name}
          </option>
        ))}
      </FilterSelect>
    </div>
  );
}

// A native <select> (kept native on purpose - the OS picker is the right
// control on a phone) with the browser's own arrow removed and replaced by
// a leading icon + trailing chevron, so it reads as a filter chip rather
// than a bare form field. `active` (a non-"all" value) tints it gold so an
// applied filter is visible without opening it.
function FilterSelect({
  icon,
  active,
  value,
  onChange,
  children,
}: {
  icon: ReactNode;
  active: boolean;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="relative min-w-0">
      <span
        className={`pointer-events-none absolute inset-y-0 start-3 flex items-center ${active ? "text-primary-soft" : "text-muted"}`}
      >
        {icon}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full cursor-pointer appearance-none truncate rounded-xl border py-2.5 ps-9 pe-8 text-xs font-medium text-foreground outline-none transition-colors focus-visible:border-primary ${
          active ? "border-primary/40 bg-primary-bg" : "border-border bg-surface"
        }`}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute inset-y-0 end-3 my-auto h-4 w-4 text-muted" />
    </div>
  );
}
