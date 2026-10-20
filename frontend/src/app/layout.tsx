import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AegisMacro SOC Console",
  description:
    "Autonomous macroeconomic risk oracle and liquidity circuit breaker on GenLayer: staked Watchtowers, 2-of-3 feed consensus, and integer-BPS risk tiers.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F8FAFC",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-tier="0">
      <body>{children}</body>
    </html>
  );
}
