"use client";

import { useState } from "react";
import { THEME_COOKIE, THEME_VALUES, type ThemePreference } from "@/lib/theme";

const LABELS: Record<ThemePreference, string> = {
  system: "سیستم",
  light: "روشن",
  dark: "تاریک",
};

const THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function resolveSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

// Applies data-theme for `next` immediately (rather than waiting on a
// navigation/reload) - mirrors the resolution logic of the blocking inline
// script in app/layout.tsx, which only runs once, on initial page load.
// Kept as a plain module-level function (not inlined in the component body)
// alongside setThemeCookie below - both write to globals (`document`), and
// the react-compiler lint rule reads such a write inside a component/hook
// body as mutating a value from outside it.
function applyTheme(next: ThemePreference) {
  document.documentElement.dataset.theme = next === "system" ? resolveSystemTheme() : next;
}

function setThemeCookie(next: ThemePreference) {
  document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${THEME_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

// Purely client-side (no fetch/API route, no DB write) - unlike
// AssetDisplayToggle, this preference lives only in the jib-theme cookie
// that app/layout.tsx's server-side render and blocking inline script both
// read, so there's nothing to await and no saving/error state to show.
export function ThemeToggle({ initialPreference }: { initialPreference: ThemePreference }) {
  const [preference, setPreference] = useState(initialPreference);

  function select(next: ThemePreference) {
    setThemeCookie(next);
    applyTheme(next);
    setPreference(next);
  }

  return (
    <div className="flex items-center gap-1.5 rounded-full border border-border bg-background p-1">
      {THEME_VALUES.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => select(value)}
          aria-pressed={preference === value}
          className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
            preference === value ? "bg-primary text-on-primary" : "text-muted"
          }`}
        >
          {LABELS[value]}
        </button>
      ))}
    </div>
  );
}
