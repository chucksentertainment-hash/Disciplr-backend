# Notifications API

Authenticated inbox endpoints for end users.

## Security rules

- Every endpoint requires `Authorization: Bearer <jwt>`.
- Each operation is scoped to `req.user.userId`.
- Requests against another user's notification return `404` to avoid leaking record existence.
- Notification metadata is sanitized before storage. Only safe reference fields such as `vaultId` are retained.
- Generated notification messages should avoid embedding sensitive vault details directly in the message body.

## Endpoints

### `GET /api/notifications`

Returns the authenticated user's inbox.

Query parameters:

- `page`: page number, default `1`
- `pageSize`: page size, default `20`, max `100`
- `sortBy`: one of `created_at`, `read_at`, `title`, `type`
- `sortOrder`: `asc` or `desc`, default `desc`
- `status`: `all`, `read`, or `unread`, default `all`
- `includeArchived`: `true` to include archived notifications, default `false`

Example response:

```json
{
  "data": [
    {
      "id": "notif_123",
      "user_id": "user_123",
      "type": "vault_failure",
      "title": "Vault Deadline Reached",
      "message": "A vault in your account has expired and been marked as failed.",
      "data": {
        "vaultId": "vault_123"
      },
      "idempotency_key": null,
      "read_at": null,
      "archived_at": null,
      "created_at": "2026-04-24T10:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 1,
    "totalPages": 1,
    "hasNext": false,
    "hasPrev": false
  },
  "sort": {
    "sortBy": "created_at",
    "sortOrder": "desc"
  }
}
```

### `PATCH /api/notifications/:id/read`

Marks one notification as read for the authenticated user.

- `200`: notification updated
- `404`: notification missing, archived, or owned by another user

### `POST /api/notifications/read-all`

Marks all unread, non-archived notifications as read for the authenticated user.

Example response:

```json
{
  "updated": 4
}
```

### `DELETE /api/notifications/:id`

Soft-deletes a notification by setting `archived_at`.

- The record remains in the database for auditability.
- Archived notifications are hidden from the default inbox view.
- Use `includeArchived=true` on list requests to retrieve them.

Example response:

```json
{
  "message": "Notification archived",
  "notification": {
    "id": "notif_123",
    "archived_at": "2026-04-24T10:05:00.000Z"
  }
}
```

## Test expectations

- Unauthenticated requests return `401`.
- Cross-user read, archive, and list access is blocked.
- Pagination and sorting behavior is covered by `src/tests/notification.test.ts`.
