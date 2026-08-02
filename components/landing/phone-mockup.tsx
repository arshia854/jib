export function PhoneMockup() {
  return (
    <div className="relative mx-auto w-[250px] sm:w-[270px]">
      <div className="absolute -end-4 -top-4 rotate-[8deg] rounded-2xl border border-border bg-surface px-3 py-2 shadow-lg sm:-end-8">
        <p className="flex items-center gap-1 text-[11px] font-medium text-foreground">
          <span aria-hidden>✨</span> دسته‌بندی خودکار
        </p>
      </div>
      <div className="absolute -bottom-3 -start-6 -rotate-6 rounded-2xl border border-border bg-surface px-3 py-2 shadow-lg sm:-start-10">
        <p className="flex items-center gap-1 text-[11px] font-medium text-success">
          <span aria-hidden>+</span> ۱۵,۰۰۰,۰۰۰ تومان
        </p>
      </div>

      <div className="rounded-[2.5rem] border-[10px] border-slate-900 bg-slate-900 shadow-2xl">
        <div className="relative overflow-hidden rounded-[1.9rem] bg-background">
          <div className="absolute left-1/2 top-0 z-10 h-5 w-24 -translate-x-1/2 rounded-b-2xl bg-slate-900" />
          <div className="space-y-3 px-4 pb-6 pt-8">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[9px] text-muted">خوش آمدید</p>
                <p className="text-sm font-bold text-foreground">جیب</p>
              </div>
              <div className="h-6 w-6 rounded-full bg-primary/10" />
            </div>

            <div className="rounded-2xl bg-gradient-to-br from-primary-dark to-primary-dark p-3.5 text-white">
              <p className="text-[9px] text-white/70">موجودی کل</p>
              <p className="mt-1 text-base font-bold">۱۴,۸۰۵,۰۰۰ تومان</p>
            </div>

            <div className="flex gap-2">
              <div className="flex-1 rounded-xl border border-border bg-surface p-2.5">
                <div className="h-4 w-4 rounded-full bg-success/15" />
                <p className="mt-1.5 text-[8px] text-muted">درآمد</p>
                <p className="text-[10px] font-semibold text-foreground">۱۵,۰۰۰,۰۰۰</p>
              </div>
              <div className="flex-1 rounded-xl border border-border bg-surface p-2.5">
                <div className="h-4 w-4 rounded-full bg-warning/15" />
                <p className="mt-1.5 text-[8px] text-muted">هزینه</p>
                <p className="text-[10px] font-semibold text-foreground">۱۹۵,۰۰۰</p>
              </div>
            </div>

            <div className="space-y-2 rounded-xl border border-border bg-surface p-2.5">
              {[
                { icon: "🍔", color: "bg-orange-100", w: "w-16" },
                { icon: "🚗", color: "bg-primary-subtle", w: "w-12" },
              ].map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className={`flex h-6 w-6 items-center justify-center rounded-full ${row.color} text-[10px]`}>
                    {row.icon}
                  </div>
                  <div className="flex-1">
                    <div className={`h-1.5 ${row.w} rounded bg-slate-200`} />
                  </div>
                  <div className="h-1.5 w-8 rounded bg-warning/25" />
                </div>
              ))}
            </div>

            <div className="flex justify-center pt-1">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-dark text-white shadow-lg">
                <span className="text-base leading-none">+</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
