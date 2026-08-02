import { redirect } from "next/navigation";
import { toJalaali } from "jalaali-js";
import { getSession } from "@/lib/auth/session";
import { getMonthlyComparison } from "@/lib/reports/monthly-comparison";
import { generateHighlights } from "@/lib/reports/generate-highlights";
import { MonthlyComparisonReport } from "@/components/reports/MonthlyComparisonReport";
import { EmptyState } from "@/components/empty-state";
import { ChartIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

function jalaaliMonthKey(jy: number, jm: number): string {
  return `${jy}-${String(jm).padStart(2, "0")}`;
}

export default async function ReportsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const { jy, jm } = toJalaali(new Date());
  const currentMonth = jalaaliMonthKey(jy, jm);
  const previousMonth = jm === 1 ? jalaaliMonthKey(jy - 1, 12) : jalaaliMonthKey(jy, jm - 1);

  const comparison = await getMonthlyComparison(String(session.userId), currentMonth, previousMonth);
  const highlights = generateHighlights(comparison);

  return (
    <div className="space-y-4 px-4 pb-8 pt-6">
      <header>
        <h1 className="text-lg font-bold text-foreground">گزارش‌ها</h1>
      </header>

      {comparison.categories.length === 0 ? (
        <EmptyState
          icon={<ChartIcon className="h-6 w-6" />}
          title="هنوز داده‌ای برای گزارش نیست"
          description="با ثبت چند تراکنش در این ماه و ماه قبل، گزارش مقایسه‌ای اینجا نمایش داده می‌شود."
          action={{ href: "/app/add", label: "افزودن تراکنش" }}
        />
      ) : (
        <MonthlyComparisonReport comparison={comparison} highlights={highlights} />
      )}
    </div>
  );
}
