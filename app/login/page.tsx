"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SpinnerIcon, WalletIcon } from "@/components/icons";

export default function LoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در ارسال کد.");
      router.push(`/verify?phone=${encodeURIComponent(data.phoneNumber)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center px-6 py-10">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-white">
            <WalletIcon className="h-8 w-8" />
          </div>
          <h1 className="mt-4 text-2xl font-bold text-foreground">به جیب خوش اومدی</h1>
          <p className="mt-2 text-sm text-muted">با شماره موبایلت وارد شو یا ثبت‌نام کن</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className="mb-1.5 block text-xs text-muted">شماره موبایل</label>
            <input
              type="tel"
              inputMode="numeric"
              dir="ltr"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, "").slice(0, 11))}
              placeholder="09123456789"
              className="w-full rounded-2xl border border-border bg-surface p-4 text-center text-lg tracking-wider text-foreground outline-none focus:border-accent"
              autoFocus
            />
          </div>
          {error && <p className="text-center text-sm text-warning">{error}</p>}
          <button
            type="submit"
            disabled={loading || phone.length !== 11}
            className="mt-2 flex items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {loading && <SpinnerIcon className="h-4 w-4 animate-spin" />}
            دریافت کد تایید
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-muted">
          با ورود، شرایط استفاده و حریم خصوصی جیب رو می‌پذیری.
        </p>
      </div>
    </div>
  );
}
