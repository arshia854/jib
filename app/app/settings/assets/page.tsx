import { redirect } from "next/navigation";

// Phase 3 (docs/roadmap-status.md): the Assets tab moved to
// app/app/dashboard/page.tsx?tab=assets - this route is now just a thin
// redirect for anything that still links to the old path. No query params
// of its own to preserve (unlike app/app/transactions/page.tsx's redirect).
export default function SettingsAssetsPage() {
  redirect("/app/dashboard?tab=assets");
}
