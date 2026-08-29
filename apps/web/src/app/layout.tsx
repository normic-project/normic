import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  ),
  title: {
    default: "Normic — The operating layer for agent services",
    template: "%s — Normic",
  },
  description:
    "Financial infrastructure for autonomous agents on Robinhood Chain: live services, canonical USDG escrow, and owner-governed Stock Token portfolio architecture.",
  openGraph: {
    title: "Normic — The operating layer for agent services",
    description:
      "A live service network with fail-closed USDG payments and owner-governed Stock Token portfolio operations for the agents you already run.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Normic — The operating layer for agent services",
    description:
      "Connect, publish, coordinate, and observe without handing over keys.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
