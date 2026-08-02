"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { SpinnerIcon } from "@/components/icons";

const RESEND_SECONDS = 90;

function otpErrorMessage(code: string | undefined): string {
  if (!code) return "کد نامعتبر است.";
  if (code === "otp_expired") return "کد منقضی شده است. دوباره درخواست کد بدهید.";
  if (code === "otp_max_attempts") return "تعداد تلاش‌ها بیش از حد مجاز است. دوباره درخواست کد بدهید.";
  if (code === "otp_rate_limited") return "تعداد درخواست‌های شما بیش از حد مجاز است، لطفاً کمی صبر کنید.";
  if (code === "otp_invalid_format") return "کد باید ۶ رقم باشد.";
  const wrongMatch = /^otp_wrong_(\d+)$/.exec(code);
  if (wrongMatch) return `کد وارد شده اشتباه است. (${wrongMatch[1]} تلاش باقی‌مانده)`;
  return "کد نامعتبر است.";
}

export function VerifyForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const phone = searchParams.get("phone") ?? "";

  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(RESEND_SECONDS);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setInterval(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearInterval(timer);
  }, [secondsLeft]);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const submit = useCallback(
    async (code: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await signIn("phone-otp", { code, redirect: false });
        if (result?.error) {
          setError(otpErrorMessage(result.code));
          setDigits(Array(6).fill(""));
          inputRefs.current[0]?.focus();
          setLoading(false);
          return;
        }
        router.push("/app");
        router.refresh();
      } catch {
        setError("خطای ناشناخته رخ داد.");
        setDigits(Array(6).fill(""));
        inputRefs.current[0]?.focus();
        setLoading(false);
      }
    },
    [router]
  );

  function handleChange(index: number, value: string) {
    const clean = value.replace(/[^\d]/g, "").slice(-1);
    const next = [...digits];
    next[index] = clean;
    setDigits(next);

    if (clean && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    if (next.every((d) => d)) {
      submit(next.join(""));
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text").replace(/[^\d]/g, "").slice(0, 6);
    if (pasted.length === 6) {
      e.preventDefault();
      setDigits(pasted.split(""));
      submit(pasted);
    }
  }

  async function handleResend() {
    setResending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در ارسال مجدد کد.");
      setSecondsLeft(RESEND_SECONDS);
      setDigits(Array(6).fill(""));
      inputRefs.current[0]?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center px-6 py-10">
      <div className="mx-auto w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold text-foreground">کد تایید رو وارد کن</h1>
        <p className="mt-2 text-sm text-muted">
          کد ۶ رقمی ارسال شده به{" "}
          <bdi className="font-medium text-foreground" dir="ltr">
            {phone}
          </bdi>{" "}
          رو وارد کن
        </p>

        <div dir="ltr" className="mt-8 flex justify-center gap-2">
          {digits.map((digit, i) => (
            <input
              key={i}
              ref={(el) => {
                inputRefs.current[i] = el;
              }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              disabled={loading}
              onChange={(e) => handleChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              onPaste={handlePaste}
              className="h-14 w-11 rounded-xl border border-border bg-surface text-center text-xl font-semibold text-foreground outline-none focus:border-accent"
            />
          ))}
        </div>

        {error && <p className="mt-4 text-sm text-warning">{error}</p>}
        {loading && (
          <p className="mt-4 flex items-center justify-center gap-2 text-sm text-muted">
            <SpinnerIcon className="h-4 w-4 animate-spin" />
            در حال بررسی...
          </p>
        )}

        <div className="mt-8">
          {secondsLeft > 0 ? (
            <p className="text-xs text-muted">
              ارسال مجدد کد تا <bdi dir="ltr" className="tabular-fa">{secondsLeft}</bdi> ثانیه دیگر
            </p>
          ) : (
            <button
              onClick={handleResend}
              disabled={resending}
              className="text-sm font-medium text-accent disabled:opacity-50"
            >
              {resending ? "در حال ارسال..." : "ارسال مجدد کد"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
