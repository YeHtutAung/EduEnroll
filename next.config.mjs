/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      // Untracked routes (they hold refs in the URL) never hand a full URL to
      // the next page, so a tracked page cannot read one from document.referrer.
      // Later entries override earlier ones for the same header key, so these
      // must stay AFTER the global entry above.
      ...[
        "/enroll/payment/:path*",
        "/enroll/:slug/checkout/:path*",
        "/enroll/:slug/status",
        "/enroll/:slug/success",
        "/enroll/:slug/interest",
        "/enroll/form",
        "/status",
      ].map((source) => ({
        source,
        headers: [{ key: "Referrer-Policy", value: "strict-origin" }],
      })),
    ];
  },
};

export default nextConfig;
