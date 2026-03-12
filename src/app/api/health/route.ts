import { headers } from "next/headers";
import { NextResponse } from "next/server";

// Evaluated at build time — used to verify which deployment is serving
const BUILD_TIME = new Date().toISOString();

export async function GET() {
  const h = headers();
  return NextResponse.json({
    status: "ok",
    build_time: BUILD_TIME,
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    ref: process.env.VERCEL_GIT_COMMIT_REF ?? "unknown",
    debug: {
      host: h.get("host"),
      "x-tenant-slug": h.get("x-tenant-slug"),
      "x-forwarded-host": h.get("x-forwarded-host"),
      "x-real-ip": h.get("x-real-ip"),
    },
  });
}
