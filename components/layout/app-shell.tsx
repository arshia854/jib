"use client";

import { usePathname } from "next/navigation";
import { BottomNav } from "./bottom-nav";
import { Fab } from "./fab";
import { InstallPrompt } from "@/components/pwa/install-prompt";

const HIDE_FAB_ON = ["/app/add", "/app/chat"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const showFab = !HIDE_FAB_ON.includes(pathname);

  return (
    <div className="relative mx-auto flex h-dvh w-full max-w-md flex-col bg-background">
      <main className="flex-1 overflow-y-auto">{children}</main>
      <BottomNav />
      {showFab && <Fab />}
      <InstallPrompt />
    </div>
  );
}
