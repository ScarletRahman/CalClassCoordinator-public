import path from "node:path";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Content Security Policy. Next's App Router streams its payload through inline <script> tags,
 * so script-src needs 'unsafe-inline' unless every page uses per-request nonces; React's `style`
 * props need 'unsafe-inline' for styles. Everything else is same-origin only. The pdf.js worker
 * used for in-browser transcript parsing is bundled and served from /_next/static (worker-src 'self').
 * 'wasm-unsafe-eval' lets the page compile WebAssembly (not JavaScript): the transcript OCR engine,
 * used for image-only PDFs, is a same-origin wasm module that runs in a worker in the browser.
 * Dev mode adds eval (React refresh) and websockets (HMR).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // The repo root, so the standalone build lands at .next/standalone/web/server.js. Real data in
  // ../data is supplied at runtime via CCC_DATA_DIR, so it is excluded from tracing below.
  outputFileTracingRoot: path.join(__dirname, ".."),
  outputFileTracingExcludes: { "*": ["../data/**", "./.data/**"] },
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
