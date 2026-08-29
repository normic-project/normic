import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  transpilePackages: ["@normic/core"],
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  poweredByHeader: false,
};

export default nextConfig;
