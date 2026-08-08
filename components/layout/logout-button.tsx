"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogoutIcon, SpinnerIcon } from "@/components/icons";

// Bounds how long logout waits on the service worker's cache-clear
// acknowledgment (see public/sw.js's "CLEAR_AUTH_CACHE" handler) - if no
// service worker is controlling the page (unsupported browser, or the SW
// hasn't taken control yet) the message is never acknowledged, and logout
// must still complete rather than hang.
const CACHE_CLEAR_TIMEOUT_MS = 2000;

// Clears the service worker's cached authenticated pages (dashboard,
// transactions, reports, ...) so they aren't readable from Cache Storage by
// the next person to use this device after logout. Awaited by handleLogout
// below so the clear completes before the redirect fires, rather than
// racing it. Resolves (never rejects) once there's nothing left to wait on.
async function clearAuthCache(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const controller = navigator.serviceWorker.controller;
  if (!controller) return;

  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(resolve, CACHE_CLEAR_TIMEOUT_MS);
    channel.port1.onmessage = () => {
      clearTimeout(timeout);
      resolve();
    };
    controller.postMessage({ type: "CLEAR_AUTH_CACHE" }, [channel.port2]);
  });
}

export function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    await Promise.all([fetch("/api/auth/logout", { method: "POST" }), clearAuthCache()]);
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
