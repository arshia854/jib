"use client";

import { useState } from "react";
import { XIcon, ShareIcon, DownloadIcon } from "@/components/icons";
import { useInstallPrompt, INSTALL_DISMISS_KEY } from "./use-install-prompt";

export function InstallPrompt() {
  const { platform, deferredPrompt } = useInstallPrompt();
  const [justDismissed, setJustDismissed] = useState(false);

  function dismiss() {
    localStorage.setItem(INSTALL_DISMISS_KEY, "1");
    setJustDismissed(true);
  }

  async function handleInstallClick() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    dismiss();
  }

  if (!platform || justDismissed) return null;

  return (
    <div className="animate-slide-up absolute inset-x-3 bottom-36 z-40 rounded-2xl border border-border bg-surface p-4 shadow-xl">
      <button
        onClick={dismiss}
        aria-label="بستن"
        className="absolute start-3 top-3 rounded-full p-1 text-muted hover:bg-background"
      >
        <XIcon className="h-4 w-4" />
      </button>

      {platform === "android" ? (
        <div className="pe-6">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary-dark">
              <DownloadIcon className="h-4 w-4" />
            </div>
            <p className="text-sm font-semibold text-foreground">جیب رو نصب کن</p>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            برای دسترسی سریع‌تر و استفاده آفلاین، جیب رو روی صفحه اصلی گوشیت نصب کن.
          </p>
          <button
            onClick={handleInstallClick}
            className="mt-3 w-full rounded-xl bg-primary-darker py-2.5 text-sm font-semibold text-white"
          >
            نصب اپلیکیشن
          </button>
        </div>
      ) : (
        <div className="pe-6">
          <p className="text-sm font-semibold text-foreground">جیب رو به صفحه اصلی اضافه کن</p>
          <p className="mt-2.5 flex items-center gap-1.5 text-xs text-muted">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
              <ShareIcon className="h-3.5 w-3.5" />
            </span>
            روی دکمه Share پایین صفحه بزن
          </p>
          <p className="mt-1.5 text-xs text-muted">بعد گزینه «Add to Home Screen» رو انتخاب کن</p>
        </div>
      )}
    </div>
  );
}
