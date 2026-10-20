import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthContext } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, requireOwner: vi.fn() };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { requireOwner } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { GET } from "@/app/api/admin/interest/[intakeId]/route";
import { makeInterestMock, scheduledIntake, OWNER_TENANT } from "./interestMocks";

const HASH = "a".repeat(64);
const SUPERSEDED_HASH = "b".repeat(64);

/**
 * A row as it would arrive if the select list ever stopped being an allowlist.
 * The secrets are present here ON PURPOSE: the export must not carry them even
 * when the row it is handed does, which is what makes this a test of the CSV
 * builder rather than a test of the select string.
 */
const ROW_WITH_SECRETS = {
  id: "entry-1",
  name: "Aung Aung",
  email: "aung@example.com",
  phone: "09777000111",
  token_prefix: "Ab12Cd34",
  token_hash: HASH,
  superseded_token_hash: SUPERSEDED_HASH,
  created_at: "2026-08-01T00:00:00.000Z",
  last_link_attempt_at: "2026-08-01T00:00:00.000Z",
  last_link_sent_at: "2026-08-01T00:01:00.000Z",
  invited_at: null,
  first_used_at: null,
  first_converted_enrollment_id: null,
  revoked_at: null,
  superseded_expires_at: null,
  form_data: { tshirt: "M", agree: "true" },
};

/** The event's form fields: one default (not on the interest form) and two custom. */
const FORM_FIELDS = [
  { field_key: "nrc", field_label: "NRC Number", field_type: "text", is_required: true, options: null, is_default: true },
  { field_key: "tshirt", field_label: "T-shirt size", field_type: "select", is_required: true, options: ["S", "M"], is_default: false },
  { field_key: "agree", field_label: "Joins newsletter", field_type: "checkbox", is_required: false, options: null, is_default: false },
];

function request(query = "") {
  return new Request(`http://acme.localhost/api/admin/interest/intake-1${query}`);
}

function authAs(tenantId: string) {
  vi.mocked(requireOwner).mockResolvedValue({
    supabase: {} as never,
    tenantId,
    user: {} as never,
    isAgent: false,
    agentChatId: null,
  } satisfies AuthContext);
}

describe("GET /api/admin/interest/[intakeId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authAs(OWNER_TENANT);
  });

  it("404s when the intake does not belong to the caller's tenant, and reads no interest rows", async () => {
    // The intake lookup is tenant-scoped, so a foreign intakeId finds nothing —
    // exactly what the database returns. Nothing may be read past that point.
    const mock = makeInterestMock({ intake: { data: null }, entries: { data: [ROW_WITH_SECRETS] } });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await GET(request() as never, { params: { intakeId: "someone-elses-intake" } });

    expect(res.status).toBe(404);
    const tables = mock.client.from.mock.calls.map((c) => c[0]);
    expect(tables).not.toContain("event_interest");
  });

  it("scopes the interest query to the caller's tenant", async () => {
    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: { data: [ROW_WITH_SECRETS] },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await GET(request() as never, { params: { intakeId: "intake-1" } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.entries).toHaveLength(1);
  });

  it("never selects a token hash", async () => {
    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: { data: [ROW_WITH_SECRETS] },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    await GET(request() as never, { params: { intakeId: "intake-1" } });

    for (const cols of mock.selectedColumns) {
      expect(cols).not.toContain("token_hash");
    }
  });

  it("exports CSV with no token and no token hash", async () => {
    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: { data: [ROW_WITH_SECRETS] },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await GET(request("?format=csv") as never, { params: { intakeId: "intake-1" } });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");

    const csv = await res.text();

    // The whole point of the export rule.
    expect(csv).not.toContain(HASH);
    expect(csv).not.toContain(SUPERSEDED_HASH);
    expect(csv.toLowerCase()).not.toContain("token_hash");

    // The prefix exists for display and is expected to be there.
    expect(csv).toContain("Ab12Cd34");
    expect(csv).toContain("aung@example.com");
  });

  it("neutralises spreadsheet formula injection in a name", async () => {
    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: { data: [{ ...ROW_WITH_SECRETS, name: "=cmd|'/c calc'!A1" }] },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await GET(request("?format=csv") as never, { params: { intakeId: "intake-1" } });
    const csv = await res.text();

    // Quoted AND apostrophe-prefixed, so neither Excel nor Sheets evaluates it.
    expect(csv).toContain(`"'=cmd`);
  });

  it("returns the custom fields so the list can label answers", async () => {
    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: { data: [ROW_WITH_SECRETS] },
      formFields: { data: FORM_FIELDS },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await GET(request() as never, { params: { intakeId: "intake-1" } });
    const body = await res.json();

    expect(body.fields).toEqual([
      { field_key: "tshirt", field_label: "T-shirt size", field_type: "select" },
      { field_key: "agree", field_label: "Joins newsletter", field_type: "checkbox" },
    ]);
    expect(body.entries[0].form_data).toEqual({ tshirt: "M", agree: "true" });
  });

  it("exports one CSV column per custom field", async () => {
    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: { data: [ROW_WITH_SECRETS] },
      formFields: { data: FORM_FIELDS },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await GET(request("?format=csv") as never, { params: { intakeId: "intake-1" } });
    const [header, row] = (await res.text()).replace(/^\ufeff/, "").split("\r\n");

    expect(header.endsWith(`"T-shirt size","Joins newsletter"`)).toBe(true);
    expect(header).not.toContain("NRC");
    expect(row.endsWith(`"M","Yes"`)).toBe(true);
  });

  it("neutralises formula injection in a custom-field answer", async () => {
    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: { data: [{ ...ROW_WITH_SECRETS, form_data: { tshirt: "=HYPERLINK(\"x\")" } }] },
      formFields: { data: FORM_FIELDS },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await GET(request("?format=csv") as never, { params: { intakeId: "intake-1" } });

    expect(await res.text()).toContain(`"'=HYPERLINK`);
  });

  it("500s when the form fields cannot be read", async () => {
    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: { data: [ROW_WITH_SECRETS] },
      formFields: { data: null, error: { message: "boom" } },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const res = await GET(request() as never, { params: { intakeId: "intake-1" } });

    expect(res.status).toBe(500);
  });

  it("keeps answers visible after their field is deleted from the form", async () => {
    // The organiser removed "T-shirt size" after people signed up. The answers
    // are still stored, so they must still be listed and exported.
    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: { data: [ROW_WITH_SECRETS] },
      formFields: { data: FORM_FIELDS.filter((f) => f.field_key !== "tshirt") },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const json = await (await GET(request() as never, { params: { intakeId: "intake-1" } })).json();
    expect(json.fields).toEqual([
      { field_key: "agree", field_label: "Joins newsletter", field_type: "checkbox" },
      { field_key: "tshirt", field_label: "tshirt (removed field)", field_type: "text" },
    ]);

    const csv = await (
      await GET(request("?format=csv") as never, { params: { intakeId: "intake-1" } })
    ).text();
    const [header, row] = csv.replace(/^\ufeff/, "").split("\r\n");
    expect(header.endsWith(`"Joins newsletter","tshirt (removed field)"`)).toBe(true);
    expect(row.endsWith(`"Yes","M"`)).toBe(true);
  });

  it("labels a hidden answer with its field's label when the field still exists", async () => {
    // Changed to a file upload, so it is no longer an interest field — but the
    // earlier answers keep their label.
    const mock = makeInterestMock({
      intake: { data: scheduledIntake() },
      entries: { data: [ROW_WITH_SECRETS] },
      formFields: {
        data: FORM_FIELDS.map((f) => (f.field_key === "tshirt" ? { ...f, field_type: "file" } : f)),
      },
    });
    vi.mocked(createAdminClient).mockReturnValue(mock.client as never);

    const json = await (await GET(request() as never, { params: { intakeId: "intake-1" } })).json();
    expect(json.fields).toContainEqual({ field_key: "tshirt", field_label: "T-shirt size", field_type: "file" });
  });
});
