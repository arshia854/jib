"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

interface RevealProps {
  children: ReactNode;
  delay?: number;
  className?: string;
}

export function Reveal({ children, delay = 0, className = "" }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  // Content is visible by default (see .reveal in globals.css). Only once we
  // have a working IntersectionObserver confirming this element is currently
  // off-screen do we opt it into the hide-then-reveal animation below — so a
  // slow/failed observer or delayed hydration can never leave content stuck
  // invisible.
  const [offscreen, setOffscreen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        } else {
          setOffscreen(true);
        }
      },
      { threshold: 0.15 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const revealClassName = ["reveal", offscreen && !visible ? "pre-reveal" : "", visible ? "is-visible" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={ref} className={revealClassName} style={visible ? { animationDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  );
}
