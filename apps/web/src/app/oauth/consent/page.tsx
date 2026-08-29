import type { Metadata } from "next";
import { OAuthConsent } from "./oauth-consent";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Authorize MCP client",
  robots: { index: false, follow: false },
};

export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string | string[] }>;
}) {
  const value = (await searchParams).authorization_id;
  const authorizationId = typeof value === "string" ? value : "";
  return <OAuthConsent authorizationId={authorizationId} />;
}
