import type { NextConfig } from "next";

const PRIVY_CHILD_SOURCES = [
  "https://auth.privy.io",
  "https://verify.walletconnect.com",
  "https://verify.walletconnect.org",
] as const;
const PRIVY_CONNECT_SOURCES = [
  "https://auth.privy.io",
  "wss://relay.walletconnect.com",
  "wss://relay.walletconnect.org",
  "wss://www.walletlink.org",
  "https://*.rpc.privy.systems",
  "https://explorer-api.walletconnect.com",
] as const;

export function contentSecurityPolicy(supabaseUrl?: string) {
  const connectSources: string[] = ["'self'"];
  if (supabaseUrl?.trim()) {
    const url = new URL(supabaseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.origin === "null"
    )
      throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a valid HTTPS origin.");
    connectSources.push(url.origin);
  }
  connectSources.push(...PRIVY_CONNECT_SOURCES);
  return [
    "frame-ancestors 'none'",
    `child-src ${PRIVY_CHILD_SOURCES.join(" ")}`,
    `frame-src ${PRIVY_CHILD_SOURCES.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
  ].join("; ");
}

if (process.env.VERCEL_ENV === "production") {
  const expected = {
    NEXT_PUBLIC_APP_URL: "https://normic.tech",
    NORMIC_PUBLIC_ORIGIN: "https://normic.tech",
    NORMIC_REMOTE_MCP_URL: "https://normic.tech/mcp",
    NORMIC_AUTH_AUDIENCE: "https://normic.tech/mcp",
    NORMIC_OWNER_AUTH_AUDIENCE: "authenticated",
  } as const;
  for (const [name, value] of Object.entries(expected)) {
    if (process.env[name] !== value)
      throw new Error(
        `${name} must be ${value} for the production deployment.`,
      );
  }
  for (const name of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  ]) {
    if (!process.env[name]?.trim())
      throw new Error(
        `${name} is required for the production OAuth consent flow.`,
      );
  }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  transpilePackages: ["@normic/core", "@normic/mcp"],
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  poweredByHeader: false,
  headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy(process.env.NEXT_PUBLIC_SUPABASE_URL),
          },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
