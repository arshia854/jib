import { formatCompactToman, formatDecimal, formatNumber } from "@/lib/format";

interface Segment {
  name: string;
  icon: string;
  color: string;
  total: number;
}

interface CategoryBreakdownProps {
  segments: Segment[];
  totalExpense: number;
}

// Past this many categories the tail folds into one "سایر" row, so the bar
// and the list below it always show the same set of segments.
const MAX_ROWS = 5;

// A tiny-but-real share gets one decimal ("۰٫۴٪") instead of rounding to a
// misleading "۰٪"; anything short of the whole never rounds up to "۱۰۰٪".
function formatShare(total: number, whole: number): string {
  const percent = (total / whole) * 100;
  if (percent > 0 && percent < 1) return `${formatDecimal(percent, 1)}٪`;
  return `${formatNumber(percent < 100 ? Math.min(Math.round(percent), 99) : 100)}٪`;
}

export function CategoryBreakdown({ segments, totalExpense }: CategoryBreakdownProps) {
  if (segments.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border p-5 text-center text-xs text-muted">
        هنوز هزینه‌ای برای این ماه ثبت نشده.
      </div>
    );
  }

  const rows: Segment[] =
    segments.length > MAX_ROWS
      ? [
          ...segments.slice(0, MAX_ROWS - 1),
          {
            name: "سایر",
            icon: "",
            color: "var(--muted)",
            total: segments.slice(MAX_ROWS - 1).reduce((sum, s) => sum + s.total, 0),
          },
        ]
      : segments;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      {/* Part-to-whole as one stacked bar rather than the old donut: shares
          compare along a single length, and the list below carries every
          number, so the bar itself is decorative to screen readers. */}
      <div aria-hidden className="flex h-2.5 gap-0.5 overflow-hidden rounded-full">
        {rows.map((row) => (
          <div
            key={row.name}
            className="min-w-1 basis-0"
            style={{ flexGrow: row.total, backgroundColor: row.color }}
          />
        ))}
      </div>

      <ul className="mt-4 space-y-3">
        {rows.map((row) => (
          <li key={row.name} className="flex items-center gap-2.5 text-sm">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
            <span className="min-w-0 flex-1 truncate text-foreground">
              {row.icon} {row.name}
            </span>
            <span className="shrink-0 font-medium tabular-fa text-foreground">{formatCompactToman(row.total)}</span>
            <span className="w-11 shrink-0 text-end text-xs tabular-fa text-muted">
              {formatShare(row.total, totalExpense)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
