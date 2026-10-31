# Client facts

One file per active client, named after the tenant's `subdomain` slug. The
`tenant-ops` agent (`.claude/agents/tenant-ops.md`) reads the matching file before
working on a client.

| Client | Slug | File |
| --- | --- | --- |
| Brave / Louder Myanmar | `brave` | [brave.md](brave.md) |
| The Beats Run | `beatsrun` | [beatsrun.md](beatsrun.md) |

## Rules for these files

- Facts only: hosts, payment setup, branding, quirks, open items. Workflow and
  safety rules belong in the agent, not here.
- These files are committed. No secrets, keys, tokens, phone numbers, emails or
  bank account numbers. Name the env var instead.
- Mark anything not yet confirmed as `TODO`, so the agent knows to verify it.

## Adding a client

Copy an existing file to `docs/clients/<slug>.md`, fill in what you know, and add
a row to the table above.
