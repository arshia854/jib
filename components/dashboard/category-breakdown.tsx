import { CategoryDonut } from "./category-donut";
import { formatToman } from "@/lib/format";

interface CategoryBreakdownProps {
  segments: { name: string; icon: string; color: string; total: number }[];
  totalExpense: number;
}

export function CategoryBreakdown({ segments, totalExpense }: CategoryBreakdownProps) {
  if (segments.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-6 text-center text-sm text-muted">
        هنوز هزینه‌ای برای این ماه ثبت نشده است.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h2 className="mb-4 text-sm font-semibold text-foreground">هزینه‌ها بر اساس دسته‌بندی</h2>
      <div className="flex items-center gap-5">
        <div className="relative shrink-0">
          <CategoryDonut segments={segments} total={totalExpense} />
          <div className="absolute inset-0 flex flex-col items-center justify-center px-4 text-center">
            <span className="text-[11px] text-muted">مجموع</span>
            <span className="text-xs font-bold tabular-fa text-foreground">{formatToman(totalExpense)}</span>
          </div>
        </div>
        <ul className="min-w-0 flex-1 space-y-2">
          {segments.slice(0, 5).map((segment) => (
            <li key={segment.name} className="flex items-center gap-2 text-xs">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: segment.color }} />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {segment.icon} {segment.name}
              </span>
              <span className="shrink-0 tabular-fa text-muted">
                {Math.round((segment.total / totalExpense) * 100)}٪
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
