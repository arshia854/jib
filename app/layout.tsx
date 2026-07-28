import type { Metadata, Viewport } from "next";
import "@fontsource-variable/vazirmatn/wght.css";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";
import { AppShell } from "@/components/layout/app-shell";

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
  themeColor: "#1E3A8A",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fa" dir="rtl">
      <body className="antialiased">
        <AppShell>{children}</AppShell>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
