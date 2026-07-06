import { vi } from "vitest";

// Mock Next.js server internals used by API routes
vi.mock("next/headers", () => ({
  headers: () => ({ get: () => null }),
  cookies: () => ({ get: () => null }),
}));
