"use client";

import { useState } from "react";
import { CheckIcon, SpinnerIcon } from "@/components/icons";

// Flips User.showBalanceInAssets (see app/api/settings/asset-display/route.ts
// and lib/data/dashboard.ts). A single boolean, so this is a plain
// pill-style toggle button (same selected/unselected visual language as
// components/settings/profile-facts-form.tsx's option buttons) rather than
// a dedicated iOS-style switch component - no other on/off control exists
// yet in this codebase to match instead.
export function AssetDisplayToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !enabled;
    setSaving(true);
    setError(null);
    setEnabled(next);
    try {
      const res = await fetch("/api/settings/asset-display", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "خطا در ذخیره‌سازی.");
    } catch (err) {
      setEnabled(!next);
      setError(err instanceof Error ? err.message : "خطای ناشناخته");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        disabled={saving}
        aria-pressed={enabled}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
          enabled ? "bg-primary text-on-primary" : "border border-border bg-background text-muted"
        }`}
      >
        {saving ? (
          <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
        ) : (
          enabled && <CheckIcon className="h-3.5 w-3.5" />
        )}
        {enabled ? "روشن" : "خاموش"}
      </button>
      {error && <p className="mt-2 text-xs text-warning">{error}</p>}
    </div>
  );
}
