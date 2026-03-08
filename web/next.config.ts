import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";
const overrideApiBase = isProduction
  ? undefined
  : process.env.FPL_API_BASE_URL || process.env.NEXT_PUBLIC_FPL_API_URL;
const defaultApiBase = isProduction
  ? "https://api.cheddarlogic.com/api/v1"
  : "http://localhost:8000/api/v1";
const apiBase = (overrideApiBase || defaultApiBase).replace(/\/+$/, "");

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${apiBase}/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/favicon.ico",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
