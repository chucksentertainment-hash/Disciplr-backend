# Admin Override Safeguards

This document describes the security safeguards and audit metadata collection for admin override endpoints.

## Overview

Admin override endpoints provide elevated privileges to perform critical operations like vault cancellations. These endpoints implement multiple safeguards to ensure accountability, prevent abuse, and maintain system integrity.

## Endpoint

```
POST /api/admin/overrides/vaults/:id/cancel
```

## Required Reason Codes

All admin override requests must include a valid `reasonCode` from the following list:

| Code | Description |
|------|-------------|
| `USER_REQUEST` | Cancellation requested by vault owner |
| `FRAUD_DETECTED` | Fraudulent activity detected |
| `SYSTEM_ERROR` | System malfunction requiring intervention |
| `POLICY_VIOLATION` | Violation of platform policies |
| `EMERGENCY_ADMIN_ACTION` | Urgent administrative action required |
| `COMPLIANCE_REQUIREMENT` | Regulatory or compliance obligation |
| `TESTING_CLEANUP` | Cleanup during testing (dev/staging only) |

## Request Format

```json
{
  "reasonCode": "FRAUD_DETECTED",
  "reason": "Optional human-readable description",
  "details": "Additional context (sanitized)",
  "idempotencyKey": "optional-custom-key"  // Optional, auto-generated if omitted
}
```

## Security Safeguards

### 1. RBAC Enforcement
- Only users with `ADMIN` role can access override endpoints
- Returns `403 Forbidden` for non-admin users (USER, VERIFIER roles)
- Returns `401 Unauthorized` for unauthenticated requests

### 2. Explicit Reason Codes
- All overrides require a valid `reasonCode`
- Invalid or missing reason codes return `400 Bad Request`
- Response includes the list of valid reason codes

### 3. Idempotency
- Duplicate override attempts return `409 Conflict`
- Idempotency tracked via `idempotencyKey` (explicit or auto-generated)
- Response includes original `auditLogId` and `processedAt` timestamp

### 4. PII/Secrets Sanitization
- Emails: `john@example.com` → `[REDACTED_EMAIL]`
- IP addresses: `192.168.1.1` → `[REDACTED_IP]`
- Credit cards: `1234-5678-9012-3456` → `[REDACTED_CARD]`
- SSN: `123-45-6789` → `[REDACTED_SSN]`
- Tokens/secrets: Long alphanumeric strings → `[REDACTED_TOKEN]`

## Response Format

### Success (200 OK)
```json
{
  "vault": {
    "id": "vault-id",
    "status": "cancelled",
    // ... other vault fields
  },
  "auditLogId": "audit-123456",
  "idempotencyKey": "admin-id:vault-id:cancel",
  "previousStatus": "active",
  "newStatus": "cancelled"
}
```

### Idempotent Replay (409 Conflict)
```json
{
  "error": "Override already processed - idempotent replay",
  "idempotencyKey": "admin-id:vault-id:cancel",
  "auditLogId": "audit-123456",
  "processedAt": "2026-01-01T00:00:00.000Z"
}
```

### Already Cancelled (409 Conflict)
```json
{
  "error": "Vault is already cancelled",
  "auditLogId": "audit-789012"
}
```

### Missing Reason Code (400 Bad Request)
```json
{
  "error": "Missing required field: reasonCode",
  "validReasonCodes": ["USER_REQUEST", "FRAUD_DETECTED", "..."]
}
```

## Audit Metadata

Every override operation generates a detailed audit log:

```json
{
  "id": "audit-123456",
  "actor_user_id": "admin-id",
  "action": "admin.override",
  "target_type": "vault",
  "target_id": "vault-id",
  "metadata": {
    "override_type": "vault.cancel",
    "previous_status": "active",
    "new_status": "cancelled",
    "reason_code": "FRAUD_DETECTED",
    "reason_text": "Fraud detected [REDACTED_EMAIL] reported",
    "details": "Suspicious activity from [REDACTED_IP]",
    "idempotency_key": "admin-id:vault-id:cancel",
    "admin_id": "admin-id",
    "request_context": {
      "user_agent": "Mozilla/5.0...",
      "method": "POST",
      "path": "/api/admin/overrides/vaults/vault-id/cancel"
    },
    "diff": {
      "status": {
        "before": "active",
        "after": "cancelled"
      },
      "changed_at": "2026-01-01T00:00:00.000Z"
    }
  },
  "created_at": "2026-01-01T00:00:00.000Z"
}
```

### Metadata Fields

| Field | Description |
|-------|-------------|
| `override_type` | Type of override operation |
| `reason_code` | Categorized reason from valid codes list |
| `reason_text` | Sanitized human-readable description |
| `details` | Additional context (sanitized) |
| `idempotency_key` | Key used for duplicate detection |
| `request_context` | HTTP request metadata |
| `diff` | Before/after state comparison |

## Idempotency Behavior

1. **Explicit Key**: Client provides `idempotencyKey` in request body
2. **Auto-generated**: If omitted, key is generated as `{adminId}:{vaultId}:cancel`
3. **First Request**: Processes operation, returns 200 with `auditLogId`
4. **Duplicate Request**: Returns 409 with original `auditLogId` and `processedAt`

## State Consistency

- Attempting to cancel an already-cancelled vault returns `409` with `auditLogId`
- Non-cancellable statuses (completed, failed) return `409` with current status
- All operations are logged even when no state change occurs

## Testing

Run the override-specific tests:

```bash
# Run all admin tests including override tests
npm test -- tests/admin.test.ts

# Run RBAC security tests
npm test -- src/tests/admin.rbac.test.ts

# Run specific override test pattern
npm test -- --testNamePattern="Admin Override"
```

## Implementation Notes

- In-memory idempotency tracking uses `Map` (use Redis in production)
- Audit logs are stored in-memory for development; use persistent store in production
- All metadata keys are normalized to snake_case
- Nested objects in metadata are recursively sanitized
