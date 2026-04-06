import type { NextConfig } from "next";
import path from "node:path";

const isProduction = process.env.NODE_ENV === "production";
const overrideApiBase = isProduction
  ? undefined
  : process.env.FPL_API_BASE_URL;
const defaultApiBase = isProduction
  ? "https://api.cheddarlogic.com/api/v1"
  : "http://localhost:8001/api/v1";
const apiBase = (overrideApiBase || defaultApiBase).replace(/\/+$/, "");

// Do NOT add `turbopack: {}` here — when present, Next.js 16 uses Turbopack
// for production builds too, and Turbopack on Node <22 fails to parse
// globals.css ([app-client] context) producing a broken 70-byte CSS bundle.
// Turbopack is opted-in explicitly for local dev via `next dev --turbo`.
const nextConfig: NextConfig = {
  // Silence "multiple lockfiles" workspace root warning for monorepo setup.
  outputFileTracingRoot: path.join(__dirname, ".."),
  // better-sqlite3 is a native Node addon and cannot be bundled by webpack.
  // serverExternalPackages prevents bundling; the webpack externals entry below
  // prevents webpack's module-resolution from failing at build time when the
  // package only exists under packages/data/node_modules (file: workspace dep).
  serverExternalPackages: ["better-sqlite3"],
  webpack(config, { isServer }) {
    if (isServer) {
      // Prevent webpack from attempting to resolve (and failing on) better-sqlite3.
      const prev = config.externals ?? [];
      config.externals = Array.isArray(prev)
        ? [...prev, "better-sqlite3"]
        : [prev as never, "better-sqlite3"];
    } else {
      // Client bundles must never receive better-sqlite3; return an empty module.
      config.resolve.fallback = {
        ...config.resolve.fallback,
        "better-sqlite3": false,
      };
    }
    return config;
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
      ...(isProduction
        ? [
            {
              source: "/_next/static/:path*",
              headers: [
                {
                  key: "Cache-Control",
                  value: "public, max-age=31536000, immutable",
                },
              ],
            },
          ]
        : []),
      // Prevent Cloudflare (and any other CDN) from caching dynamic pages.
      // force-dynamic sets no-store on the server response, but CF can override
      // that when caching is enabled for the zone. This header makes it explicit.
      {
        source: "/",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, must-revalidate",
          },
        ],
      },
      {
        source: "/(cards|results|fpl|analytics|subscribe)",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, must-revalidate",
          },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, must-revalidate",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
