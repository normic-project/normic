import type { NextConfig } from "next";

if (process.env.VERCEL_ENV === "production") {
  const expected = {
    NEXT_PUBLIC_APP_URL: "https://normic.tech",
    NORMIC_PUBLIC_ORIGIN: "https://normic.tech",
    NORMIC_REMOTE_MCP_URL: "https://normic.tech/mcp",
    NORMIC_AUTH_AUDIENCE: "https://normic.tech/mcp",
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
};

export default nextConfig;
