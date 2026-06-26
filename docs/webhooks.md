# Webhook Delivery System

The webhook system delivers vault lifecycle events to registered HTTP endpoints. Subscribers are stored in PostgreSQL and scoped per organization.

## Storage Model

Webhook subscribers are stored in the `webhook_subscribers` table:

| Column | Type | Description |
|---|---|---|
| `id` | `uuid` (PK, auto-generated) | Unique subscriber identifier |
| `organization_id` | `varchar(255)` | Owning organization (NOT NULL) |
| `url` | `varchar(2048)` | Target webhook URL |
| `secret` | `text` | HMAC signing secret |
| `events` | `jsonb` | Array of event types to receive; empty array = wildcard (all events) |
| `active` | `boolean` | Whether the subscriber is active |
| `created_at` | `timestamptz` | Creation timestamp |
| `updated_at` | `timestamptz` | Last update timestamp |

Index: `(organization_id, active)` for efficient org-scoped lookups.

## Secret Handling Decision

The `secret` column stores the HMAC signing secret in plaintext. Hashing is not viable because the raw secret is required to compute HMAC-SHA256 signatures for outgoing webhook requests.

**Recommendation for production:** Encrypt the secret at rest using one of:
- PostgreSQL `pgcrypto` extension (`pgp_sym_encrypt` / `pgp_sym_decrypt`)
- Application-level AES-256-GCM encryption before storage, with the encryption key managed via a secrets manager (AWS KMS, HashiCorp Vault)

The trade-off is that the encryption key must be available to the application at runtime to decrypt secrets for signing, which shifts the protection boundary from the database layer to the key management layer.

## Organization Isolation

All subscriber queries are scoped by `organization_id`. When dispatching events, only subscribers belonging to the same organization as the event source receive the delivery. This prevents cross-tenant information leakage.

## API

### `addSubscriber(organizationId, url, secret, events)`

Creates a new webhook subscriber. The URL is validated against the SSRF allowlist (`isUrlAllowed`). Returns the created subscriber.

### `removeSubscriber(id)`

Deletes a subscriber by ID. Returns `true` if found.

### `listSubscribers(organizationId)`

Returns all active subscribers for an organization.

### `dispatchWebhookEvent(payload)`

Delivers an event to all eligible active subscribers for the organization specified in `payload.organizationId`. Uses exponential-backoff retry (max 3 attempts). Failures are collected per-subscriber.
