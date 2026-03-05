# Subdomain Routing — EduEnroll

## How It Works

EduEnroll uses **wildcard subdomain routing** so each registered school gets its own URL:

```
nihonmoment.edu-enroll-xi.vercel.app
sakura-academy.edu-enroll-xi.vercel.app
```

### Request Flow

```
Browser → nihonmoment.edu-enroll-xi.vercel.app/enroll/april-2026
       → Vercel routes *.edu-enroll-xi.vercel.app to the Next.js app
       → Middleware extracts "nihonmoment" from hostname
       → Sets x-tenant-slug: nihonmoment header
       → API routes call resolveTenantId() → looks up tenant_id from tenants table
       → All queries scoped to that tenant_id via .eq("tenant_id", tenantId)
```

### Middleware Logic (`src/middleware.ts`)

```
1. Extract subdomain from hostname
   - "nihonmoment.edu-enroll-xi.vercel.app" → parts[0] = "nihonmoment"
   - "nihonmoment.localhost:3005" → parts[0] = "nihonmoment"

2. Fallback for plain localhost
   - No subdomain detected → check ?tenant= query param

3. Skip tenant detection for:
   - /register (SaaS registration page)
   - /api/saas/* (registration API)
   - /superadmin (platform admin)
   - /onboarding (post-registration wizard)

4. Set x-tenant-slug header → forwarded to API routes
```

## Vercel Setup

### 1. Wildcard Domain (Vercel Dashboard)

Go to **Project Settings → Domains** and add:

```
*.edu-enroll-xi.vercel.app
```

Or for a custom domain:

```
*.eduenroll.com
eduenroll.com
```

Vercel automatically routes all subdomains to your single Next.js deployment. No additional configuration needed — the middleware handles tenant detection.

### 2. DNS for Custom Domain

If using a custom domain like `eduenroll.com`:

| Type  | Name | Value                          |
|-------|------|--------------------------------|
| A     | @    | 76.76.21.21                    |
| CNAME | *    | cname.vercel-dns.com           |

The wildcard CNAME (`*`) ensures any subdomain routes to Vercel.

### 3. Environment Variables (Vercel Dashboard)

Set these in **Project Settings → Environment Variables**:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

## How New Schools Get Their Subdomain

1. School registers at `/register` with a chosen subdomain (e.g. `nihonmoment`)
2. `POST /api/saas/register` validates the slug and checks uniqueness
3. Creates row in `tenants` table with `subdomain = 'nihonmoment'`
4. Immediately accessible at `nihonmoment.edu-enroll-xi.vercel.app`
5. No DNS changes or Vercel config updates needed — wildcard handles it

## Local Development

Since `localhost` doesn't support real subdomains easily, use the query param fallback:

```
http://localhost:3005/enroll/april-2026?tenant=nihonmoment
http://localhost:3005/admin/dashboard?tenant=nihonmoment
```

Or use subdomain-style localhost (requires `/etc/hosts` entry):

```
# Add to /etc/hosts (or C:\Windows\System32\drivers\etc\hosts)
127.0.0.1 nihonmoment.localhost

# Then access:
http://nihonmoment.localhost:3005/enroll/april-2026
```

## Security

- **RLS (Row Level Security)**: Every table is scoped by `tenant_id`. Even if the middleware is bypassed, the database enforces isolation.
- **Admin routes**: `requireAuth()` resolves tenant from the user's profile — not from the URL. An admin can only see their own tenant's data.
- **Public routes**: `resolveTenantId()` reads the `x-tenant-slug` header set by middleware. The slug is validated against the `tenants` table.
- **Service role**: Only used in `createAdminClient()` for public APIs (registration, enrollment) where no auth session exists.
