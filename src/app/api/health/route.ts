import { NextResponse } from "next/server";

const BUILD_TIME = new Date().toISOString();

export async function GET() {
  return NextResponse.json({
    status: "ok",
    build_time: BUILD_TIME,
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    ref: process.env.VERCEL_GIT_COMMIT_REF ?? "unknown",
  });
}
