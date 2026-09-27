// Client-side counterpart to lib/notifications/send-push.ts - requests
// Notification permission, subscribes the already-registered service
// worker (public/sw.js, registered by components/pwa/service-worker-
// register.tsx) to Web Push, and POSTs the resulting subscription to
// POST /api/notifications/subscribe. A plain async function rather than a
// React hook: unlike components/pwa/use-install-prompt.ts (which tracks
// reactive browser-event state), there's no state to subscribe a component
// to here - this is a one-shot imperative action meant to be called from a
// button's onClick, matching lib/offline/sync-transactions.ts's own
// plain-async-function shape (also called imperatively/on an event from a
// thin "use client" wrapper, not itself a hook).
//
// Not called from anywhere yet in this phase - no settings-page toggle
// exists to wire it into (that placement is a later, separate decision per
// this phase's own brief).

export interface SubscribeToPushResult {
  success: boolean;
  error?: string;
}

// Web Push's applicationServerKey option needs the VAPID public key as a
// raw Uint8Array, not the base64url string it's distributed as - standard
// conversion (see https://developer.mozilla.org/docs/Web/API/PushManager/subscribe
// and the Web Push protocol's own VAPID spec), not project-specific.
// Returns Uint8Array<ArrayBuffer> explicitly (not the plain `Uint8Array`
// TS infers from `Uint8Array.from`, which widens to the
// ArrayBuffer|SharedArrayBuffer-backed generic and then fails to satisfy
// PushManager.subscribe's `applicationServerKey?: BufferSource` under this
// installed TS/DOM-lib version) - a `new Uint8Array(length)` is always
// plain-ArrayBuffer-backed, so filling it in place keeps that guarantee.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

export async function subscribeToPushNotifications(): Promise<SubscribeToPushResult> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { success: false, error: "این مرورگر از اعلان‌ها پشتیبانی نمی‌کند." };
  }

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!publicKey) {
    return { success: false, error: "قابلیت اعلان‌ها فعلاً فعال نیست." };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { success: false, error: "اجازه نمایش اعلان داده نشد." };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    const res = await fetch("/api/notifications/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      return { success: false, error: data?.error || "ثبت اشتراک اعلان ناموفق بود." };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "ثبت اشتراک اعلان ناموفق بود.",
    };
  }
}
