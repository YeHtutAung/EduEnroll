import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockSweep = vi.fn();
vi.mock("@/server/conversions/sweep", () => ({
  sweepConversions: (...a: unknown[]) => mockSweep(...a),
}));

// Middleware calls auth.getUser() on every /api path. Anything else it touched
// would show up here as a missing method.
const mockGetUser = vi.fn(async () => ({ data: { user: null } }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: mockGetUser } }),
}));

const { GET, dynamic, maxDuration } = await import("@/app/api/cron/conversions/route");
const { middleware } = await import("@/middleware");

const SECRET = "cron-secret-sentinel-value";
const COUNTS = { expired: 1, contextDeleted: 2, processed: 3 };

const request = (authorization?: string) =>
  new NextRequest("https://edu-enroll-xi.vercel.app/api/cron/conversions", {
    headers: authorization === undefined ? {} : { authorization },
  });

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
const logged = () => JSON.stringify([...errorSpy.mock.calls, ...logSpy.mock.calls]);

beforeEach(() => {
  mockSweep.mockReset();
  mockSweep.mockResolvedValue(COUNTS);
  vi.stubEnv("CRON_SECRET", SECRET);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/cron/conversions", () => {
  it("returns 401 when CRON_SECRET is unset, even for 'Bearer undefined'", async () => {
    vi.stubEnv("CRON_SECRET", undefined);

    for (const header of ["Bearer undefined", "Bearer ", "Bearer", undefined]) {
      const res = await GET(request(header));
      expect(res.status).toBe(401);
    }
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it("returns 401 when CRON_SECRET is only whitespace", async () => {
    vi.stubEnv("CRON_SECRET", "   ");

    for (const header of ["Bearer    ", "Bearer ", "Bearer undefined"]) {
      const res = await GET(request(header));
      expect(res.status).toBe(401);
    }
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong secret, of the same or a different length", async () => {
    for (const header of [
      "Bearer wrong",
      `Bearer ${"x".repeat(SECRET.length)}`,
      `Bearer ${SECRET}x`,
      SECRET,
      `bearer ${SECRET}`,
    ]) {
      const res = await GET(request(header));
      expect(res.status).toBe(401);
    }
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it("returns 401 with no header", async () => {
    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it("runs the sweep and returns counts for the right secret", async () => {
    const res = await GET(request(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(COUNTS);
    expect(mockSweep).toHaveBeenCalledTimes(1);
  });

  it("logs counts only, and never the secret", async () => {
    await GET(request(`Bearer ${SECRET}`));

    expect(logSpy).toHaveBeenCalledWith("[conversions] sweep", JSON.stringify(COUNTS));
    expect(logged()).not.toContain(SECRET);
  });

  it("returns 500 with no detail when the sweep throws", async () => {
    mockSweep.mockRejectedValue(new Error(`database said ${SECRET}`));

    const res = await GET(request(`Bearer ${SECRET}`));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal Server Error" });
    expect(errorSpy).toHaveBeenCalledWith("[conversions] sweep failed:", "Error");
    expect(logged()).not.toContain(SECRET);
  });

  it("never caches, and has the time its batch needs", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(60);
  });
});

describe("vercel.json", () => {
  const config = JSON.parse(readFileSync(path.resolve(__dirname, "../../../vercel.json"), "utf8"));

  it("schedules the route once a day", () => {
    expect(config.crons).toEqual([{ path: "/api/cron/conversions", schedule: "0 20 * * *" }]);
  });

  it("keeps every other key", () => {
    expect(Object.keys(config).sort()).toEqual(
      ["$schema", "crons", "framework", "git", "headers", "regions", "rewrites"].sort(),
    );
    expect(config.regions).toEqual(["sin1"]);
    expect(config.git.deploymentEnabled).toEqual({ main: true, staging: true, dev: false });
  });
});

// A cron request runs through the tenant middleware like any other /api path.
describe("middleware on the cron path", () => {
  const cronRequest = (host: string) => {
    const headers = new Headers({ authorization: `Bearer ${SECRET}`, "user-agent": "vercel-cron/1.0", host });
    return new NextRequest(new Request(`https://${host}/api/cron/conversions`, { headers }));
  };

  it.each([
    "edu-enroll-xi.vercel.app",
    "edu-enroll-abc123-team.vercel.app",
    "www.kuunyi.com",
    "kuunyi.com",
  ])("passes %s through with the bearer header and no redirect", async (host) => {
    vi.stubEnv("VERCEL_ENV", "production");

    const res = await middleware(cronRequest(host));

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-request-authorization")).toBe(`Bearer ${SECRET}`);
    expect(res.headers.get("x-middleware-request-x-tenant-slug")).toBeNull();
  });
});
