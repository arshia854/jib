import type { ReactNode } from "react";
import { ArrowUpIcon, ArrowDownIcon, AlertIcon } from "@/components/icons";
import { formatCompactToman, formatNumber } from "@/lib/format";

function Figure({ label, amount, icon, iconClassName }: { label: string; amount: number; icon: ReactNode; iconClassName: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className={`flex h-7 w-7 items-center justify-center rounded-full ${iconClassName}`}>{icon}</span>
        <span className="text-xs text-muted">{label}</span>
      </div>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-1">
        <span className="text-lg font-bold tabular-fa text-foreground">{formatNumber(amount)}</span>
        <span className="text-[11px] text-muted">تومان</span>
      </p>
    </div>
  );
}

/**
 * This month's income vs. expense side by side, plus a meter of how much of
 * the income has been spent - the one relationship between the two numbers
 * the user actually wants to know, which two separate cards left them to
 * work out themselves. The caption carries the meter's meaning in text (the
 * bar is aria-hidden), and overspending gets an icon, not just red.
 */
export function MonthSummaryCard({ income, expense }: { income: number; expense: number }) {
  const spentRatio = income > 0 ? expense / income : null;
  const overspent = spentRatio !== null && spentRatio > 1;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="grid grid-cols-2">
        <Figure
          label="درآمد"
          amount={income}
          icon={<ArrowUpIcon className="h-4 w-4" />}
          iconClassName="bg-success/10 text-success"
        />
        <div className="border-s border-border ps-4">
          <Figure
            label="هزینه"
            amount={expense}
            icon={<ArrowDownIcon className="h-4 w-4" />}
            iconClassName="bg-warning/10 text-warning"
          />
        </div>
      </div>

      {spentRatio !== null && (
        <div className="mt-4">
          <div aria-hidden className="h-2 overflow-hidden rounded-full bg-border">
            <div
              className={`h-full rounded-full ${overspent ? "bg-warning" : "bg-primary"}`}
              style={{ width: `${Math.min(spentRatio, 1) * 100}%` }}
            />
          </div>
          {overspent ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-warning">
              <AlertIcon className="h-3.5 w-3.5 shrink-0" />
              <span>
                <span className="tabular-fa">{formatCompactToman(expense - income)}</span> تومان بیشتر از درآمدت خرج
                کردی
              </span>
            </p>
          ) : (
            <p className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
              <span>
                <span className="tabular-fa">{formatNumber(Math.floor(spentRatio * 100))}٪</span> از درآمدت خرج شده
              </span>
              <span>
                <span className="tabular-fa font-medium text-foreground">{formatCompactToman(income - expense)}</span>{" "}
                تومان مونده
              </span>
            </p>
          )}
        </div>
      )}
      {spentRatio === null && expense > 0 && (
        <p className="mt-3 text-xs text-muted">هنوز درآمدی برای این ماه ثبت نکردی.</p>
      )}
    </div>
  );
}
