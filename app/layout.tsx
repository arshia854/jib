import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";
import { OfflineSyncRegister } from "@/components/pwa/offline-sync-register";

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fa" dir="rtl">
      <body className="bg-background text-foreground antialiased">
        {children}
        <ServiceWorkerRegister />
        <OfflineSyncRegister />
      </body>
    </html>
  );
}
