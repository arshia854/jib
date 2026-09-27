import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";
import { OfflineSyncRegister } from "@/components/pwa/offline-sync-register";
import { THEME_COOKIE } from "@/lib/theme";

export const metadata: Metadata = {
  title: {
    default: "جیب | مدیریت مالی شخصی",
    template: "%s | جیب",
  },
  description: "جیب، دستیار مالی شخصی شما برای ثبت و پیگیری هوشمند تراکنش‌ها",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "جیب",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#000000",
};

// Runs before first paint to resolve "system" against the browser's actual
// prefers-color-scheme and apply data-theme before the page renders -
// otherwise a light-system user would flash the (default/SSR) dark theme
// for a frame. Must stay a plain inline, blocking, non-deferred script and
// the first child of <head>: `next/script`'s afterInteractive/lazyOnload
// strategies and any `async`/`defer` all run after first paint, which is
// exactly the FOUC this exists to prevent. Do not move or refactor this.
const THEME_INIT_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )jib-theme=([^;]*)/);var v=m?decodeURIComponent(m[1]):null;var root=document.documentElement;if(v==="light"||v==="dark"){if(root.dataset.theme!==v)root.dataset.theme=v;}else{var resolved=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";root.dataset.theme=resolved;}}catch(e){}})();`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const store = await cookies();
  const cookieValue = store.get(THEME_COOKIE)?.value;
  // Only an explicit light/dark cookie can be resolved server-side; "system"
  // (or no cookie yet) is left for the blocking script above to resolve
  // against the browser's own prefers-color-scheme, since the server has no
  // way to know that.
  const dataTheme = cookieValue === "light" || cookieValue === "dark" ? cookieValue : undefined;

  return (
    <html lang="fa" dir="rtl" data-theme={dataTheme} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="bg-background text-foreground antialiased">
        {children}
        <ServiceWorkerRegister />
        <OfflineSyncRegister />
      </body>
    </html>
  );
}
