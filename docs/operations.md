# Operational Guide

This document describes how to manage the Disciplr-backend service in production.

## Graceful Shutdown

Disciplr-backend implements a graceful shutdown procedure to ensure that no data is lost and all resources are cleaned up correctly.

### Triggering Shutdown

The service listens for the following signals:
- `SIGINT` (typically triggered by Ctrl+C or a container stop command)
- `SIGTERM` (typically triggered by a container orchestrator like Kubernetes or ECS)

### Shutdown Sequence

When a shutdown signal is received, the following sequence occurs:

1. **ETL Worker Stoppage**: The ETL worker stops polling for new Stellar transactions. If a run is in progress, it attempts to abort gracefully at its next checkpoint.
2. **Background Job System Stoppage**: The job system stops accepting new jobs via the `/api/jobs/enqueue` endpoint or internal schedulers. It waits up to 2 seconds for active jobs in the queue to complete.
3. **HTTP Server Closure**: The Express server stops accepting new HTTP connections and waits for active requests to finish.
4. **Database Connection Closure**: The SQLite/PostgreSQL connection is closed cleanly.

### Logging

Shutdown events are logged to stdout:
```text
[Shutdown] Received SIGTERM. Starting graceful shutdown...
[Shutdown] Stopping ETL worker...
[ETLWorker] Stop requested – draining in-flight run...
[ETLWorker] Stopped
[Shutdown] Stopping background job system...
[Shutdown] Closing HTTP server...
[Shutdown] HTTP server closed
[Shutdown] Closing database connection...
Database connection closed
[Shutdown] Graceful shutdown completed successfully
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | 3000 | The port the API listens on. |
| `ENABLE_ETL_WORKER` | `true` | Set to `false` to disable the Stellar ETL worker. |
| `ETL_INTERVAL_MINUTES` | 5 | How often the ETL worker syncs with Horizon. |
| `JOB_WORKER_CONCURRENCY` | 2 | Number of concurrent job workers. |
| `JOB_QUEUE_POLL_INTERVAL_MS` | 250 | How often the job queue checks for new work. |
| `JOB_HISTORY_LIMIT` | 50 | Number of completed/failed jobs to keep in memory metrics. |
