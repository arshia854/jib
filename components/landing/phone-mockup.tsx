import { CheckIcon } from "@/components/icons";
import { formatNumber, formatToman } from "@/lib/format";

export function PhoneMockup() {
  return (
    <div className="relative mx-auto w-[250px] sm:w-[270px]">
      {/* "Transaction confirm" card - settles in first, then drifts. */}
      <div
        className="hero-floating-card absolute -end-4 -top-6 z-10 rotate-[8deg] rounded-2xl border border-border bg-surface px-3 py-2 shadow-lg sm:-end-9"
        style={{ animationDelay: "500ms, 1100ms" }}
      >
        <div className="flex items-center gap-1.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
            <CheckIcon className="h-3 w-3" />
          </span>
          <div>
            <p className="text-[11px] font-medium text-foreground">قهوه ☕ ثبت شد</p>
            <p className="text-[10px] text-muted">{formatToman(45000)}</p>
          </div>
        </div>
      </div>

      {/* "Budget summary" card - staggered a bit later, drifts on its own loop. */}
      <div
        className="hero-floating-card absolute -bottom-5 -start-6 z-10 -rotate-6 rounded-2xl border border-border bg-surface px-3 py-2.5 shadow-lg sm:-start-11"
        style={{ animationDelay: "750ms, 1350ms" }}
      >
        <p className="text-[10px] text-muted">بودجه این ماه</p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <div className="h-1.5 w-14 overflow-hidden rounded-full bg-white/10">
            <div className="h-full w-[65%] rounded-full bg-primary" />
          </div>
          <span className="text-[10px] font-semibold text-foreground">{formatNumber(65)}٪</span>
        </div>
      </div>

      <div className="rounded-[2.5rem] border-[10px] border-black bg-black shadow-2xl">
        <div className="relative overflow-hidden rounded-[1.9rem] bg-background">
          <div className="absolute left-1/2 top-0 z-10 h-5 w-24 -translate-x-1/2 rounded-b-2xl bg-black" />
          <div className="space-y-3 px-4 pb-6 pt-8">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[9px] text-muted">خوش آمدید</p>
                <p className="text-sm font-bold text-foreground">جیب</p>
              </div>
              <div className="h-6 w-6 rounded-full bg-primary/10" />
            </div>

            <div className="rounded-2xl bg-gradient-to-br from-neutral-900 to-black p-3.5 text-white">
              <p className="text-[9px] text-white/70">موجودی کل</p>
              <p className="mt-1 text-base font-bold">{formatToman(14805000)}</p>
            </div>

            <div className="flex gap-2">
              <div className="flex-1 rounded-xl border border-border bg-surface p-2.5">
                <div className="h-4 w-4 rounded-full bg-success/15" />
                <p className="mt-1.5 text-[8px] text-muted">درآمد</p>
                <p className="text-[10px] font-semibold text-foreground">{formatNumber(15000000)}</p>
              </div>
              <div className="flex-1 rounded-xl border border-border bg-surface p-2.5">
                <div className="h-4 w-4 rounded-full bg-warning/15" />
                <p className="mt-1.5 text-[8px] text-muted">هزینه</p>
                <p className="text-[10px] font-semibold text-foreground">{formatNumber(195000)}</p>
              </div>
            </div>

            <div className="space-y-2 rounded-xl border border-border bg-surface p-2.5">
              {[
                { icon: "🍔", color: "bg-white/10", w: "w-16" },
                { icon: "🚗", color: "bg-primary-subtle", w: "w-12" },
              ].map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className={`flex h-6 w-6 items-center justify-center rounded-full ${row.color} text-[10px]`}>
                    {row.icon}
                  </div>
                  <div className="flex-1">
                    <div className={`h-1.5 ${row.w} rounded bg-white/15`} />
                  </div>
                  <div className="h-1.5 w-8 rounded bg-warning/25" />
                </div>
              ))}
            </div>

            <div className="flex justify-center pt-1">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-on-primary shadow-lg">
                <span className="text-base leading-none">+</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
