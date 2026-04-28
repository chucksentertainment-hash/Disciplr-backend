# Multi-Tenancy and Tenant Isolation

All endpoints mounted under `/api/organizations/:orgId` enforce strict per-organization
data isolation. This document defines the contract that every current and future
org-scoped endpoint must uphold.

## Core isolation rules

1. **Org existence check** — the middleware resolves the org from the in-memory store
   (future: database) before any role check. A fabricated or deleted `orgId` returns
   `404 Organization not found` regardless of the caller's role.

2. **Membership check** — the caller's `userId` (from the verified JWT `sub` claim) must
   appear in the org's member list. Non-members receive `403 Forbidden: not a member of
   this organization`.

3. **Role check** — each endpoint declares the minimum role(s) required. The middleware
   rejects callers whose role is not in the allowed set with
   `403 Forbidden: requires role <roles>`.

4. **Data scoping** — every query inside a handler filters by the `orgId` from
   `req.params`. Client-supplied `orgId` values in query strings or request bodies are
   never trusted for data access decisions.

5. **No cross-org leakage** — pagination, sorting, and filtering are applied *after* the
   org-scope filter. A filter that matches zero records in the target org returns an empty
   result set, not records from another org.

## Roles

| Role     | Description                                      |
|----------|--------------------------------------------------|
| `owner`  | Full control: manage members, access all data.   |
| `admin`  | Manage members (cannot remove last admin), access all data. |
| `member` | Read-only access to org vaults.                  |

## Endpoint access matrix

| Endpoint                                    | Required roles              |
|---------------------------------------------|-----------------------------|
| `GET /api/organizations/:orgId/vaults`      | `owner`, `admin`, `member`  |
| `GET /api/organizations/:orgId/analytics`   | `owner`, `admin`            |
| `GET /api/organizations/:orgId/members`     | `owner`, `admin`, `member`  |
| `POST /api/organizations/:orgId/members`    | `owner`, `admin`            |
| `DELETE /api/organizations/:orgId/members/:userId` | `owner`, `admin`   |
| `PATCH /api/organizations/:orgId/members/:userId/role` | `owner`        |

## Middleware: `requireOrgAccess`

`src/middleware/orgAuth.ts` exports a single factory used by every org-scoped route:

```ts
requireOrgAccess(...allowedRoles: OrgRole[])
```

It performs the three checks above (org existence → membership → role) in order and
short-circuits with the appropriate HTTP error on the first failure. All org-scoped
routes **must** use this middleware and must not implement their own membership checks.

## Adding a new org-scoped endpoint

1. Mount the route under `/api/organizations`.
2. Apply `authenticate` then `requireOrgAccess(...roles)` before the handler.
3. Inside the handler, scope all data queries to `req.params.orgId`.
4. Add the endpoint to the access matrix above.
5. Add regression tests covering:
   - Unauthenticated request → `401`
   - Non-member → `403`
   - Member with insufficient role → `403`
   - Non-existent org → `404`
   - Cross-org data isolation (response must not contain records from another org)

## IDOR prevention

Org IDs are taken exclusively from the authenticated route parameter (`req.params.orgId`).
They are never read from the request body or query string for access-control decisions.
This prevents insecure direct object reference (IDOR) attacks where a caller could
substitute another org's ID to access its data.

## Dual-membership users

A user may belong to multiple organizations with different roles in each. The middleware
evaluates membership and role against the `orgId` in the current request only. Membership
in org B grants no access to org A's endpoints.
