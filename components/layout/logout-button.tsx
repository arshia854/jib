"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogoutIcon, SpinnerIcon } from "@/components/icons";

export function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  return (
    <button
      onClick={handleLogout}
      disabled={loading}
      aria-label="خروج از حساب"
      className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted transition-colors hover:bg-surface hover:text-warning disabled:opacity-50"
    >
      {loading ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : <LogoutIcon className="h-4 w-4" />}
    </button>
  );
}
