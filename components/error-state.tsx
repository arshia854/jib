"use client";

import { useEffect } from "react";
import { AlertIcon } from "@/components/icons";

interface ErrorStateProps {
  error: Error & { digest?: string };
  onRetry: () => void;
  message?: string;
}

export function ErrorState({ error, onRetry, message = "مشکلی در بارگذاری این بخش پیش اومد." }: ErrorStateProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-warning/10 text-warning">
        <AlertIcon className="h-7 w-7" />
      </div>
      <p className="text-sm font-medium text-foreground">{message}</p>
      <button
        onClick={onRetry}
        className="mt-1 rounded-2xl bg-primary-darker px-6 py-3 text-sm font-semibold text-white"
      >
        تلاش مجدد
      </button>
    </div>
  );
}
