import Link from "next/link";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getComparison } from "@/lib/reports/monthly-comparison";
import { generateHighlights } from "@/lib/reports/generate-highlights";
import { dateToPeriodKey, getPreviousPeriod, type ReportGranularity } from "@/lib/reports/period-range";
import { getTodaySpending } from "@/lib/reports/today-spending";
import { getActivityHeatmap } from "@/lib/data/activity-heatmap";
import { MonthlyComparisonReport } from "@/components/reports/MonthlyComparisonReport";
import { TodaySpendingReport } from "@/components/reports/TodaySpendingReport";
import { ActivityHeatmap } from "@/components/reports/ActivityHeatmap";
import { EmptyState } from "@/components/empty-state";
import { ChartIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

// The UI has two more tabs ("day", "activity") than the week/month/year comparison
// granularity in period-range.ts — neither is a comparison, so both are handled by
// their own branch below instead of going through getComparison/periodToGregorianRange.
type ReportTab = "day" | "activity" | ReportGranularity;

const TABS: { value: ReportTab; label: string }[] = [
  { value: "day", label: "روزانه" },
  { value: "week", label: "هفتگی" },
  { value: "month", label: "ماهانه" },
  { value: "year", label: "سالانه" },
  { value: "activity", label: "فعالیت" },
];

// Text for generateHighlights' periodLabel — "نسبت به ماه قبل" is its own default, repeated
// here so all three comparison granularities are defined together at the one call site that needs them.
// Day has no periodLabel: it's a plain summary with no highlights.
const PERIOD_LABELS: Record<ReportGranularity, string> = {
  week: "نسبت به هفته قبل",
  month: "نسبت به ماه قبل",
  year: "نسبت به سال قبل",
};

function parseTab(range: string | undefined): ReportTab {
  return range === "day" || range === "week" || range === "year" || range === "activity" ? range : "month";
}

interface PageProps {
  searchParams: Promise<{ range?: string }>;
}

export default async function ReportsPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { range } = await searchParams;
  const tab = parseTab(range);

  function emptyState(description: string) {
    return (
      <EmptyState
        icon={<ChartIcon className="h-6 w-6" />}
        title="هنوز داده‌ای برای گزارش نیست"
        description={description}
        action={{ href: "/app/add", label: "افزودن تراکنش" }}
      />
    );
  }

  let content: ReactNode;
  if (tab === "day") {
    const spending = await getTodaySpending(String(session.userId));
    content =
      spending.categories.length === 0
        ? emptyState("با ثبت یک تراکنش امروز، خلاصه هزینه‌های امروز اینجا نمایش داده می‌شود.")
        : <TodaySpendingReport spending={spending} />;
  } else if (tab === "activity") {
    const heatmap = await getActivityHeatmap(session.userId);
    content =
      heatmap.activeDays === 0
        ? emptyState("با ثبت اولین تراکنش، نقشه فعالیت روزانه شما اینجا نمایش داده می‌شود.")
        : <ActivityHeatmap heatmap={heatmap} />;
  } else {
    const currentPeriod = dateToPeriodKey(new Date(), tab);
    const previousPeriod = getPreviousPeriod(currentPeriod, tab);
    const comparison = await getComparison(String(session.userId), currentPeriod, previousPeriod, tab);
    const highlights = generateHighlights(comparison, PERIOD_LABELS[tab]);
    content =
      comparison.categories.length === 0
        ? emptyState("با ثبت چند تراکنش در این بازه و بازه قبل، گزارش مقایسه‌ای اینجا نمایش داده می‌شود.")
        : <MonthlyComparisonReport comparison={comparison} highlights={highlights} />;
  }

  return (
    <div className="space-y-4 px-4 pb-8 pt-6">
      <header>
        <h1 className="text-lg font-bold text-foreground">گزارش‌ها</h1>
      </header>

      <nav className="flex gap-1.5 overflow-x-auto pb-1">
        {TABS.map(({ value, label }) => {
          const active = value === tab;
          const href = value === "month" ? "/app/reports" : `/app/reports?range=${value}`;
          return (
            <Link
              key={value}
              href={href}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${
                active ? "bg-primary text-on-primary" : "bg-background text-muted"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {content}
    </div>
  );
}
