import { jest } from '@jest/globals';

jest.unstable_mockModule('../services/healthService.js', () => ({
  healthService: {
    buildHealthStatus: jest.fn(),
    buildDeepHealthStatus: jest.fn(),
  }
}));

const { healthService } = await import('../services/healthService.js');
const { app } = await import('../app.js');
const { createHealthRouter } = await import('../routes/health.js');
const request = (await import('supertest')).default;

const mockJobSystem: any = { getMetrics: () => ({ running: true, queueDepth: 0, activeJobs: 0, totals: { enqueued: 0, completed: 0, failed: 0 } }) };
app.use('/api/health', createHealthRouter(mockJobSystem));

describe('Health Check Deep', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 for normal health check', async () => {
    (healthService.buildHealthStatus as any).mockReturnValue({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: 0,
      service: 'disciplr-backend',
      jobs: { running: true, queueDepth: 0, activeJobs: 0 },
    });

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).not.toHaveProperty('details');
  });

  it('should return 200 and details when deep=1 and services are up', async () => {
    (healthService.buildDeepHealthStatus as any).mockResolvedValue({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: 0,
      details: {
        database: { status: 'up' },
        migrations: { status: 'up', pendingCount: 0 },
        jobs: { status: 'up', running: true, queueDepth: 0, activeJobs: 0, totals: { enqueued: 0, completed: 0, failed: 0 } },
        horizonListener: { status: 'disabled' },
      }
    });

    const res = await request(app).get('/api/health?deep=1');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.details.database.status).toBe('up');
    expect(res.body.details.migrations.status).toBe('up');
    expect(res.body.details.horizonListener.status).toBe('disabled');
  });

  it('should return 503 when a critical service is down via deep=1', async () => {
    (healthService.buildDeepHealthStatus as any).mockResolvedValue({
      status: 'error',
      timestamp: new Date().toISOString(),
      uptime: 0,
      details: {
        database: { status: 'down', error: 'Conn error' },
        migrations: { status: 'up', pendingCount: 0 },
        jobs: { status: 'up', running: true, queueDepth: 0, activeJobs: 0, totals: { enqueued: 0, completed: 0, failed: 0 } },
        horizonListener: { status: 'disabled' },
      }
    });

    const res = await request(app).get('/api/health?deep=1');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
  });

  it('should return 200 for /api/health/deep when all services are up', async () => {
    (healthService.buildDeepHealthStatus as any).mockResolvedValue({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: 0,
      details: {
        database: { status: 'up' },
        migrations: { status: 'up', pendingCount: 0 },
        jobs: { status: 'up', running: true, queueDepth: 0, activeJobs: 0, totals: { enqueued: 0, completed: 0, failed: 0 } },
        horizonListener: { status: 'up', lastProcessedAt: new Date().toISOString() },
      }
    });

    const res = await request(app).get('/api/health/deep');
    expect(res.status).toBe(200);
    expect(res.body.details.database.status).toBe('up');
    expect(res.body.details.horizonListener.status).toBe('up');
  });

  it('should return 503 for /api/health/deep when partially degraded', async () => {
    (healthService.buildDeepHealthStatus as any).mockResolvedValue({
      status: 'error',
      timestamp: new Date().toISOString(),
      uptime: 0,
      details: {
        database: { status: 'up' },
        migrations: { status: 'up', pendingCount: 0 },
        jobs: { status: 'down', error: 'Job system not running' },
        horizonListener: { status: 'stale', lastProcessedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), error: 'Heartbeat is stale' },
      }
    });

    const res = await request(app).get('/api/health/deep');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.details.jobs.status).toBe('down');
    expect(res.body.details.horizonListener.status).toBe('stale');
  });

  it('should not expose secrets in deep health response', async () => {
    (healthService.buildDeepHealthStatus as any).mockResolvedValue({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: 0,
      details: {
        database: { status: 'up' },
        migrations: { status: 'up', pendingCount: 0 },
        jobs: { status: 'up', running: true, queueDepth: 0, activeJobs: 0, totals: { enqueued: 0, completed: 0, failed: 0 } },
        horizonListener: { status: 'disabled' },
      }
    });

    const res = await request(app).get('/api/health/deep');
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('DATABASE_URL');
    expect(bodyStr).not.toContain('CONTRACT_ADDRESS');
    expect(bodyStr).not.toContain('HORIZON_URL');
    expect(bodyStr).not.toContain('secret');
    expect(bodyStr).not.toContain('password');
    expect(res.body).not.toHaveProperty('details.jobs.recentFailures');
    expect(res.body).not.toHaveProperty('details.jobs.byType');
  });
});

