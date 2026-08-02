import Link from "next/link";
import { WalletIcon } from "@/components/icons";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary-dark">
        <WalletIcon className="h-8 w-8" />
      </div>
      <h1 className="text-lg font-bold">صفحه پیدا نشد</h1>
      <p className="text-sm text-muted">آدرسی که دنبالش بودید وجود نداره یا جابه‌جا شده.</p>
      <Link
        href="/app"
        className="mt-2 inline-flex items-center justify-center rounded-2xl bg-primary-darker px-6 py-3 text-sm font-semibold text-white"
      >
        رفتن به داشبورد
      </Link>
    </div>
  );
}
