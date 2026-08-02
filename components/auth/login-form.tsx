"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { SpinnerIcon, WalletIcon, GoogleIcon, MailIcon, PhoneIcon } from "@/components/icons";

type Method = "phone" | "email";

function googleErrorMessage(error: string | null): string | null {
  if (!error) return null;
  if (error === "AccessDenied") {
    return "این حساب گوگل ایمیل تاییدشده ندارد یا اجازه ورود با آن وجود ندارد.";
  }
  return "ورود با گوگل ناموفق بود. دوباره تلاش کن.";
}

function emailErrorMessage(code: string | undefined): string {
  if (code === "invalid_email_password") return "ایمیل یا رمز عبور اشتباه است.";
  if (code === "email_rate_limited") return "تعداد تلاش‌های شما بیش از حد مجاز است، کمی صبر کن.";
  return "خطا در ورود.";
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const googleError = googleErrorMessage(searchParams.get("error"));

  const [method, setMethod] = useState<Method>("phone");

  const [phone, setPhone] = useState("");
  const [phoneLoading, setPhoneLoading] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  const [emailMode, setEmailMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const [googleLoading, setGoogleLoading] = useState(false);

  async function handlePhoneSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPhoneLoading(true);
    setPhoneError(null);
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
      setPhoneError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
      setPhoneLoading(false);
    }
  }

  function handleGoogle() {
    setGoogleLoading(true);
    signIn("google", { callbackUrl: "/app" });
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setEmailLoading(true);
    setEmailError(null);
    try {
      if (emailMode === "register") {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "خطا در ثبت‌نام.");
      }

      const result = await signIn("email-password", { email, password, redirect: false });
      if (result?.error) {
        setEmailError(emailErrorMessage(result.code));
        setEmailLoading(false);
        return;
      }
      router.push("/app");
      router.refresh();
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
      setEmailLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center px-6 py-10">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-dark text-white">
            <WalletIcon className="h-8 w-8" />
          </div>
          <h1 className="mt-4 text-2xl font-bold text-foreground">به جیب خوش اومدی</h1>
          <p className="mt-2 text-sm text-muted">وارد شو یا ثبت‌نام کن</p>
        </div>

        {googleError && <p className="mb-4 text-center text-sm text-warning">{googleError}</p>}

        {method === "phone" && (
          <form onSubmit={handlePhoneSubmit} className="flex flex-col gap-3">
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
            {phoneError && <p className="text-center text-sm text-warning">{phoneError}</p>}
            <button
              type="submit"
              disabled={phoneLoading || phone.length !== 11}
              className="mt-2 flex items-center justify-center gap-2 rounded-2xl bg-primary-darker py-3.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {phoneLoading && <SpinnerIcon className="h-4 w-4 animate-spin" />}
              دریافت کد تایید
            </button>
          </form>
        )}

        {method === "email" && (
          <form onSubmit={handleEmailSubmit} className="flex flex-col gap-3">
            <div>
              <label className="mb-1.5 block text-xs text-muted">ایمیل</label>
              <input
                type="email"
                dir="ltr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-2xl border border-border bg-surface p-4 text-foreground outline-none focus:border-accent"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-muted">رمز عبور</label>
              <input
                type="password"
                dir="ltr"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-2xl border border-border bg-surface p-4 text-foreground outline-none focus:border-accent"
              />
              {password.length > 0 && password.length < 8 && (
                <p className="mt-1.5 text-xs text-muted">رمز عبور باید حداقل ۸ کاراکتر باشد.</p>
              )}
            </div>
            {emailError && <p className="text-center text-sm text-warning">{emailError}</p>}
            <button
              type="submit"
              disabled={emailLoading || !email || password.length < 8}
              className="mt-2 flex items-center justify-center gap-2 rounded-2xl bg-primary-darker py-3.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {emailLoading && <SpinnerIcon className="h-4 w-4 animate-spin" />}
              {emailMode === "register" ? "ثبت‌نام" : "ورود"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEmailMode(emailMode === "register" ? "login" : "register");
                setEmailError(null);
              }}
              className="text-center text-xs font-medium text-accent"
            >
              {emailMode === "register" ? "قبلاً ثبت‌نام کردی؟ وارد شو" : "حساب نداری؟ ثبت‌نام کن"}
            </button>
          </form>
        )}

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted">یا</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <div className="flex flex-col gap-2">
          {method !== "phone" && (
            <button
              onClick={() => setMethod("phone")}
              className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-surface py-3.5 text-sm font-semibold text-foreground"
            >
              <PhoneIcon className="h-4 w-4" />
              ورود با شماره موبایل
            </button>
          )}

          <button
            onClick={handleGoogle}
            disabled={googleLoading}
            className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-surface py-3.5 text-sm font-semibold text-foreground disabled:opacity-50"
          >
            {googleLoading ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <GoogleIcon className="h-4 w-4" />}
            ورود با گوگل
          </button>

          {method !== "email" && (
            <button
              onClick={() => setMethod("email")}
              className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-surface py-3.5 text-sm font-semibold text-foreground"
            >
              <MailIcon className="h-4 w-4" />
              ورود با ایمیل
            </button>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-muted">
          با ورود، شرایط استفاده و حریم خصوصی جیب رو می‌پذیری.
        </p>
      </div>
    </div>
  );
}
