import { NextResponse } from "next/server";

export type BuyerErrorCode =
  | "UNAUTHENTICATED" | "FORBIDDEN" | "CONFLICT" | "DELETION_IN_PROGRESS"
  | "VALIDATION" | "RATE_LIMITED" | "NOT_FOUND" | "SERVER";

// Mobile spec common error shape: { error: { code, message } }.
export function buyerError(status: number, code: BuyerErrorCode, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}
