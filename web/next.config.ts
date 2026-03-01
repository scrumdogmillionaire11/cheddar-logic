import type { NextConfig } from "next";

const configuredApiBase =
  process.env.FPL_API_BASE_URL ||
  process.env.NEXT_PUBLIC_FPL_API_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:8000/api/v1"
    : "https://api.cheddarlogic.com/api/v1");

const apiBase = configuredApiBase.replace(/\/+$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${apiBase}/:path*`,
      },
    ];
  },
};

export default nextConfig;
