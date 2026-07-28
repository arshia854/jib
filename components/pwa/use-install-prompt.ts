import { useSyncExternalStore } from "react";

export const INSTALL_DISMISS_KEY = "jeeb-install-dismissed";

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type Platform = "android" | "ios" | null;

interface InstallState {
  platform: Platform;
  deferredPrompt: BeforeInstallPromptEvent | null;
}

const HIDDEN_STATE: InstallState = { platform: null, deferredPrompt: null };

function detectPlatform(): InstallState {
  if (typeof window === "undefined") return HIDDEN_STATE;
  if (localStorage.getItem(INSTALL_DISMISS_KEY)) return HIDDEN_STATE;

  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  if (isStandalone) return HIDDEN_STATE;

  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  return isIOS ? { platform: "ios", deferredPrompt: null } : HIDDEN_STATE;
}

let cachedSnapshot: InstallState | null = null;

function getSnapshot(): InstallState {
  if (!cachedSnapshot) {
    cachedSnapshot = detectPlatform();
  }
  return cachedSnapshot;
}

function getServerSnapshot(): InstallState {
  return HIDDEN_STATE;
}

function subscribe(callback: () => void) {
  function handleBeforeInstallPrompt(e: Event) {
    e.preventDefault();
    if (localStorage.getItem(INSTALL_DISMISS_KEY)) return;
    cachedSnapshot = { platform: "android", deferredPrompt: e as BeforeInstallPromptEvent };
    callback();
  }

  window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  return () => window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
}

export function useInstallPrompt(): InstallState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
