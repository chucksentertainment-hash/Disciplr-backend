# Jobs Enqueue Contract

`POST /api/jobs/enqueue` is admin-only and validates payload by job type using a discriminated schema.

## Supported job types

- `notification.send`
- `deadline.check`
- `oracle.call`
- `analytics.recompute`

## Enqueue options

- `delayMs`: optional, must be `>= 0`
- `maxAttempts`: optional integer, bounds `1..10`

Options parsing behavior:

- `delayMs` is floored before queue scheduling.
- `maxAttempts` is used as provided after schema validation.

## Error contract

Invalid payloads return:

- HTTP `400`
- `VALIDATION_ERROR` response body from `formatValidationError`
- field-level paths (for example `payload.scope`, `maxAttempts`, `delayMs`)

## Security

- Endpoint requires valid auth token and `ADMIN` role.
- Non-admin users receive `403`.
- On success, enqueue action writes `job.enqueue` audit logs.
