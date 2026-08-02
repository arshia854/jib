"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SpinnerIcon, CheckIcon } from "@/components/icons";

export default function OnboardingPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, age: Number(age) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطا در ذخیره اطلاعات.");
      router.push("/app");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته رخ داد.");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center px-6 py-10">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-foreground">چند قدم مونده</h1>
          <p className="mt-2 text-sm text-muted">برای شخصی‌سازی جیب، کمی درباره خودت بگو</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className="mb-1.5 block text-xs text-muted">اسم</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثلاً آرشیا"
              maxLength={60}
              className="w-full rounded-2xl border border-border bg-surface p-4 text-sm text-foreground outline-none focus:border-accent"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-muted">سن</label>
            <input
              type="number"
              inputMode="numeric"
              dir="ltr"
              value={age}
              onChange={(e) => setAge(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
              placeholder="۲۵"
              className="w-full rounded-2xl border border-border bg-surface p-4 text-center text-sm text-foreground outline-none focus:border-accent"
            />
          </div>

          {error && <p className="text-center text-sm text-warning">{error}</p>}

          <button
            type="submit"
            disabled={loading || !name.trim() || !age}
            className="mt-2 flex items-center justify-center gap-2 rounded-2xl bg-primary-darker py-3.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {loading ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <CheckIcon className="h-4 w-4" />}
            بزن بریم
          </button>
        </form>
      </div>
    </div>
  );
}
