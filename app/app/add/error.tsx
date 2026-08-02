"use client";

import { ErrorState } from "@/components/error-state";

export default function AddTransactionError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return <ErrorState error={error} onRetry={unstable_retry} message="مشکلی در بارگذاری فرم تراکنش پیش اومد." />;
}
