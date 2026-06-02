# Notification Delivery System

The application uses an abstraction for notification delivery, allowing for multiple providers (Email, Console, etc.) and reliable delivery via background jobs.

## Architecture

1.  **Job Enqueueing**: Notifications are enqueued as `notification.send` jobs.
2.  **Job Execution**: The job handler uses `NotificationService` to select and execute the configured provider.
3.  **Retries**: Jobs are automatically retried with exponential backoff on failure.

## Provider Interface

All providers must implement the `NotificationProvider` interface:

```typescript
export interface NotificationProvider {
  name: string
  send(recipient: string, subject: string, body: string): Promise<void>
}
```

## Configuration

The active provider is selected via the `NOTIFICATION_PROVIDER` environment variable.
Available providers:
- `email`: Sends via Email (Stub implementation).
- `console`: Logs to console (Default for local development).

## Observability

- **Metrics**: Queue metrics can be accessed via `GET /api/jobs/metrics`.
- **Logs**: Job execution is logged. PII (recipient, subject, body) is filtered from the logs for security and compliance.
- **Failures**: Persistent failures are recorded and observable via the metrics endpoint.

## Retry Policy

The system uses an exponential backoff strategy:
- `delay = min(60s, 1s * 2^(attempt - 1))`
- Execution is observable via `/api/jobs/metrics` and failures are tracked with their error messages.
