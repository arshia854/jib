import Link from "next/link";
import { AlertIcon } from "@/components/icons";

export default function TransactionNotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-warning/10 text-warning">
        <AlertIcon className="h-7 w-7" />
      </div>
      <p className="text-sm font-medium text-foreground">این تراکنش یافت نشد</p>
      <p className="text-xs text-muted">ممکنه حذف شده باشه یا متعلق به شما نباشه.</p>
      <Link
        href="/app/transactions"
        className="mt-2 inline-flex items-center justify-center rounded-2xl bg-primary px-6 py-3 text-sm font-semibold text-on-primary"
      >
        بازگشت به تراکنش‌ها
      </Link>
    </div>
  );
}
