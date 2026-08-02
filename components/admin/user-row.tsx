"use client";

import Link from "next/link";
import { useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { formatJalaaliDate, formatNumber } from "@/lib/format";
import { BanIcon, CheckIcon, SpinnerIcon } from "@/components/icons";
import type { UserRole } from "@/lib/auth/session";

export interface UserRowUser {
  id: number;
  name: string | null;
  phoneNumber: string | null;
  email: string | null;
  role: UserRole;
  blockedAt: Date | string | null;
  createdAt: Date | string;
  transactionCount: number;
}

export function UserRow({ user }: { user: UserRowUser }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = Boolean(user.blockedAt);

  async function toggleBlocked(e: MouseEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
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

  return (
    <div className="py-1">
      <div className="flex items-center gap-3 py-2">
        <Link href={`/app/admin/users/${user.id}`} className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary-dark">
            {(user.name ?? user.phoneNumber ?? user.email ?? "ک").charAt(0)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {user.name ?? "بدون‌نام"}
              {user.role === "admin" && <span className="text-accent"> · مدیر</span>}
            </p>
            <p dir="ltr" className="truncate text-left text-xs text-muted">
              {user.phoneNumber ?? user.email ?? "—"}
            </p>
            <p className="text-xs text-muted">
              {formatJalaaliDate(user.createdAt)} · {formatNumber(user.transactionCount)} تراکنش
              {blocked && <span className="text-warning"> · مسدود</span>}
            </p>
          </div>
        </Link>
        <button
          onClick={toggleBlocked}
          disabled={pending}
          aria-label={blocked ? "رفع مسدودیت" : "مسدود کردن"}
          className={`shrink-0 rounded-full p-2 disabled:opacity-50 ${
            blocked ? "text-success hover:bg-success/10" : "text-warning hover:bg-warning/10"
          }`}
        >
          {pending ? (
            <SpinnerIcon className="h-4 w-4 animate-spin" />
          ) : blocked ? (
            <CheckIcon className="h-4 w-4" />
          ) : (
            <BanIcon className="h-4 w-4" />
          )}
        </button>
      </div>
      {error && <p className="pb-2 text-xs text-warning">{error}</p>}
    </div>
  );
}
