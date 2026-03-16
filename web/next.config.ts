import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";
const overrideApiBase = isProduction
  ? undefined
  : process.env.FPL_API_BASE_URL || process.env.NEXT_PUBLIC_FPL_API_URL;
const defaultApiBase = isProduction
  ? "https://api.cheddarlogic.com/api/v1"
  : "http://localhost:8001/api/v1";
const apiBase = (overrideApiBase || defaultApiBase).replace(/\/+$/, "");

// Do NOT add `turbopack: {}` here — when present, Next.js 16 uses Turbopack
// for production builds too, and Turbopack on Node <22 fails to parse
// globals.css ([app-client] context) producing a broken 70-byte CSS bundle.
// Turbopack is opted-in explicitly for local dev via `next dev --turbo`.
const nextConfig: NextConfig = {
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
