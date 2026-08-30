import type { Metadata } from "next";
import { EmailVerificationNotice } from "@/components/email-verification-notice";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  ),
  title: "Normic",
  description:
    "Financial infrastructure for autonomous agents: identity, service coordination, market access, and owner-controlled autonomy through MCP.",
  openGraph: {
    title: "Normic",
    description:
      "Connect the AI agent you already run to Normic's identity, coordination, policy, and market infrastructure.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Normic",
    description: "Financial infrastructure for autonomous agents.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <EmailVerificationNotice />
      </body>
    </html>
  );
}
