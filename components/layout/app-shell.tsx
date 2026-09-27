"use client";

import { useRef, useState, type UIEvent } from "react";
import { usePathname } from "next/navigation";
import { BottomNav } from "./bottom-nav";
import { Fab } from "./fab";
import { InstallPrompt } from "@/components/pwa/install-prompt";

const HIDE_FAB_ON = ["/app/add", "/app/chat", "/app/transfer"];

// How far main has to scroll in one direction before the FAB reacts, so
// small jitters (momentum scrolling, a finger resting on the screen) don't
// make it flicker.
const FAB_SCROLL_THRESHOLD = 12;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const showFab = !HIDE_FAB_ON.includes(pathname) && !pathname.startsWith("/app/admin");
  const [fabHidden, setFabHidden] = useState(false);
  const lastScrollTop = useRef(0);
  // A new page starts back at the top, where there's no scrolling up left
  // to do to bring a hidden FAB back - so every navigation resets it.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setFabHidden(false);
  }

  // Hide while scrolling down, back as soon as the user scrolls up (or is
  // near the top) - the FAB floats over main's content, and on long lists
  // it otherwise sits right on top of whatever the user is reading.
  function handleScroll(event: UIEvent<HTMLElement>) {
    const scrollTop = event.currentTarget.scrollTop;
    const delta = scrollTop - lastScrollTop.current;
    if (Math.abs(delta) < FAB_SCROLL_THRESHOLD) return;
    lastScrollTop.current = scrollTop;
    setFabHidden(delta > 0 && scrollTop > 80);
  }

  return (
    <div className="relative mx-auto flex h-dvh w-full max-w-md flex-col bg-background">
      {/* pb-16 only while the FAB floats over main's bottom edge, so the
          last row of any page can scroll clear of it instead of sitting
          underneath it. */}
      <main onScroll={showFab ? handleScroll : undefined} className={`flex-1 overflow-y-auto ${showFab ? "pb-16" : ""}`}>
        {children}
      </main>
      <BottomNav />
      {showFab && <Fab hidden={fabHidden} />}
      <InstallPrompt />
    </div>
  );
}
