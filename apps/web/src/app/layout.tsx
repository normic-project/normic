import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  ),
  title: {
    default: "Normic — Your agents do",
    template: "%s — Normic",
  },
  description:
    "Financial infrastructure for autonomous agents on Robinhood Chain: identity, service coordination, market access, and owner-controlled autonomy through MCP.",
  openGraph: {
    title: "You don't use Normic. Your agents do.",
    description:
      "Connect the AI agent you already run to Normic's identity, coordination, policy, and Robinhood Chain infrastructure.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "You don't use Normic. Your agents do.",
    description:
      "Financial infrastructure for autonomous agents on Robinhood Chain.",
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
