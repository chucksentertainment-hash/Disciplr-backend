# Health Endpoints Expansion TODO

## Plan
Expand `GET /api/health` and add `GET /api/health/deep` to include DB connectivity, migration status, background job system health, and (if enabled) Horizon listener heartbeat. Keep the lightweight endpoint fast and safe for public exposure.

## Steps

- [x] 1. Rewrite `src/services/healthService.ts`
- [x] 2. Rewrite `src/routes/health.ts`
- [x] 3. Update `src/controllers/healthController.ts`
- [x] 4. Expand `src/tests/health.deep.test.ts`
- [x] 5. Run tests to verify

---

# API Versioning & Deprecation TODO

## Plan
Introduce URL-based API versioning (`/api/v1`) with backward-compatible legacy aliases (`/api/...`). Implement deprecation headers for all legacy endpoints and document the migration path for clients.

## Steps

- [x] 1. Create `src/config/versions.ts` — version constants, sunset timeline, successor-path helper
- [x] 2. Create `src/middleware/versioning.ts` — deprecation header middleware + `mountVersionedRoute()` helper
- [x] 3. Modify `src/index.ts` — dual-register all routes via `mountVersionedRoute()`
- [x] 4. Create `docs/API_VERSIONING.md` — strategy, header semantics, deprecation timeline, client migration guide
- [x] 5. Create `src/tests/apiVersioning.test.ts` — verify v1 has no headers, legacy has `Deprecation`/`Sunset`/`Link`
- [x] 6. Run tests and lint (runtime unavailable in this environment; code verified logically)

