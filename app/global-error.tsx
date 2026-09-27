"use client";

import { useEffect } from "react";
import "./globals.css";
import { AlertIcon } from "@/components/icons";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="fa" dir="rtl">
      <body className="flex min-h-dvh items-center justify-center bg-background text-foreground antialiased">
        <div className="flex flex-col items-center gap-3 px-6 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-warning/10 text-warning">
            <AlertIcon className="h-8 w-8" />
          </div>
          <h1 className="text-lg font-bold">مشکلی پیش اومد</h1>
          <p className="text-sm text-muted">خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره تلاش کنید.</p>
          <button
            onClick={() => unstable_retry()}
            className="mt-2 rounded-2xl bg-primary px-6 py-3 text-sm font-semibold text-on-primary"
          >
            تلاش مجدد
          </button>
        </div>
      </body>
    </html>
  );
}
