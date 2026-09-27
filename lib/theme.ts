// Shared between server (app/layout.tsx, app/app/settings/page.tsx) and
// client (components/settings/theme-toggle.tsx) code - kept dependency-free
// so it needs no "use client"/"server-only" marker either way.
export const THEME_COOKIE = "jib-theme";

export type ThemePreference = "system" | "light" | "dark";

export const THEME_VALUES: ThemePreference[] = ["system", "light", "dark"];

export function isThemePreference(v: unknown): v is ThemePreference {
  return typeof v === "string" && (THEME_VALUES as string[]).includes(v);
}
