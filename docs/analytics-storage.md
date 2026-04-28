# Analytics Storage Migration (SQLite -> PostgreSQL)

## Goal

Move analytics persistence to PostgreSQL for production workloads while keeping existing `/api/analytics` behavior stable.

## Data model

### `analytics_vault_summary`

- Single-row summary keyed by `id=1`
- `total_vaults`, `active_vaults`, `completed_vaults`, `failed_vaults`
- `total_locked_capital`, `active_capital`, `success_rate`
- `last_updated`

### `analytics_vault_daily_rollups`

- Daily materialized rollup keyed by `bucket_date`
- Same aggregate fields as summary table
- Supports historical analytics and backfill verification

## Runtime storage modes

Configure with environment variables:

- `ANALYTICS_STORAGE=postgres` enables PostgreSQL reads for analytics summary.
- `ANALYTICS_DUAL_WRITE=true` enables dual-write of summary/rollups to PostgreSQL while SQLite remains active.

Recommended migration rollout:

1. Deploy with `ANALYTICS_DUAL_WRITE=true`, `ANALYTICS_STORAGE` unset.
2. Run backfill once and compare summary parity.
3. Switch read path to `ANALYTICS_STORAGE=postgres`.
4. Keep dual-write briefly for safety.
5. Disable dual-write after confidence window.

## Backfill strategy

- Use `backfillAnalyticsStorage()` from `src/db/database.ts`.
- It initializes analytics tables in PostgreSQL and recomputes:
  - global summary row (`analytics_vault_summary`)
  - daily rollups (`analytics_vault_daily_rollups`) from `vaults.created_at`.

## Validation checklist

1. Run migration: `npm run migrate:latest`
2. Trigger summary recompute/backfill.
3. Verify row counts and totals:
   - SQLite `vault_analytics_summary` vs PostgreSQL `analytics_vault_summary`
4. Run contract tests:
   - `npm test -- tests/analytics.test.ts`
   - `npm test -- tests/jobs.test.ts`

## Security / privacy considerations

- Analytics responses remain aggregate-only.
- No additional PII fields are emitted by `/api/analytics`.
- Audit logs and privacy logger behavior are unchanged.
