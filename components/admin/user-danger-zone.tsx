"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BanIcon, CheckIcon, TrashIcon, SpinnerIcon } from "@/components/icons";

export function UserDangerZone({ userId, blocked }: { userId: number; blocked: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function toggleBlocked() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: blocked ? "unblock" : "block" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در بروزرسانی کاربر.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setPending(false);
    }
  }

  async function handleDelete() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در حذف کاربر.");
      router.push("/app/admin/users");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطای ناشناخته");
      setPending(false);
    }
  }

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-foreground">عملیات</h2>

      <button
        onClick={toggleBlocked}
        disabled={pending}
        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-border py-3 text-sm font-semibold text-foreground disabled:opacity-50"
      >
        {pending ? (
          <SpinnerIcon className="h-4 w-4 animate-spin" />
        ) : blocked ? (
          <CheckIcon className="h-4 w-4" />
        ) : (
          <BanIcon className="h-4 w-4" />
        )}
        {blocked ? "رفع مسدودیت کاربر" : "مسدود کردن کاربر"}
      </button>

      {!confirmingDelete ? (
        <button
          onClick={() => setConfirmingDelete(true)}
          disabled={pending}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-warning/30 py-3 text-sm font-semibold text-warning disabled:opacity-50"
        >
          <TrashIcon className="h-4 w-4" />
          حذف کاربر
        </button>
      ) : (
        <div className="space-y-2 rounded-2xl bg-warning/10 p-3">
          <p className="text-xs text-warning">
            این کاربر و تمام اطلاعات مرتبط (تراکنش‌ها، حساب‌ها، دسته‌بندی‌ها و گفتگوها) برای همیشه حذف می‌شود. این
            عملیات غیرقابل بازگشت است.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleDelete}
              disabled={pending}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-warning py-2.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {pending && <SpinnerIcon className="h-4 w-4 animate-spin" />}
              بله، حذف شود
            </button>
            <button
              onClick={() => setConfirmingDelete(false)}
              disabled={pending}
              className="flex-1 rounded-xl border border-border py-2.5 text-xs font-semibold text-foreground disabled:opacity-50"
            >
              انصراف
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-warning">{error}</p>}
    </section>
  );
}
