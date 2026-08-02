"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";

export default function RootError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    fetch("/api/log-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: error.message, stack: error.stack }),
    }).catch(() => {});
  }, [error]);

  return <ErrorState error={error} onRetry={unstable_retry} />;
}
