import express from 'express'
import request from 'supertest'
import { jest } from '@jest/globals'

// abuse-monitor.ts captures SECURITY_* env values at module load. Keep these
// overrides before the dynamic import below so this suite uses small thresholds.
const securityEnvKeys = [
  'SECURITY_RATE_LIMIT_WINDOW_MS',
  'SECURITY_RATE_LIMIT_MAX_REQUESTS',
  'SECURITY_SUSPICIOUS_WINDOW_MS',
  'SECURITY_SUSPICIOUS_404_THRESHOLD',
  'SECURITY_SUSPICIOUS_DISTINCT_PATH_THRESHOLD',
  'SECURITY_SUSPICIOUS_BAD_REQUEST_THRESHOLD',
  'SECURITY_SUSPICIOUS_HIGH_VOLUME_THRESHOLD',
  'SECURITY_FAILED_LOGIN_WINDOW_MS',
  'SECURITY_FAILED_LOGIN_BURST_THRESHOLD',
  'SECURITY_ALERT_COOLDOWN_MS',
] as const

const previousSecurityEnv = Object.fromEntries(
  securityEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof securityEnvKeys)[number], string | undefined>

Object.assign(process.env, {
  SECURITY_RATE_LIMIT_WINDOW_MS: '1000',
  SECURITY_RATE_LIMIT_MAX_REQUESTS: '3',
  SECURITY_SUSPICIOUS_WINDOW_MS: '1000',
  SECURITY_SUSPICIOUS_404_THRESHOLD: '3',
  SECURITY_SUSPICIOUS_DISTINCT_PATH_THRESHOLD: '3',
  SECURITY_SUSPICIOUS_BAD_REQUEST_THRESHOLD: '3',
  SECURITY_SUSPICIOUS_HIGH_VOLUME_THRESHOLD: '3',
  SECURITY_FAILED_LOGIN_WINDOW_MS: '1000',
  SECURITY_FAILED_LOGIN_BURST_THRESHOLD: '3',
  SECURITY_ALERT_COOLDOWN_MS: '1000',
})

jest.unstable_mockModule('../services/healthService.js', () => ({
  healthService: {
    checkDatabase: jest.fn(),
    checkHorizon: jest.fn(),
  },
}))

const abuseMonitor = await import('../security/abuse-monitor.js')
const { createHealthRouter } = await import('../routes/health.js')

const {
  __resetSecurityMonitorForTests,
  getSecurityMetricsSnapshot,
  securityMetricsMiddleware,
  securityRateLimitMiddleware,
} = abuseMonitor

for (const key of securityEnvKeys) {
  if (previousSecurityEnv[key] === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = previousSecurityEnv[key]
  }
}

const makeMetricsApp = () => {
  const app = express()
  app.use(express.json())
  app.use(securityMetricsMiddleware)
  app.get('/ok', (_req, res) => res.status(200).json({ ok: true }))
  app.get('/missing/:id', (_req, res) => res.status(404).json({ error: 'missing' }))
  app.get('/bad', (_req, res) => res.status(400).json({ error: 'bad' }))
  app.post('/auth/login', (_req, res) => res.status(401).json({ error: 'invalid' }))
  app.post('/login', (_req, res) => res.status(403).json({ error: 'forbidden' }))
  return app
}

const makeRateLimitApp = () => {
  const app = express()
  app.use(securityRateLimitMiddleware)
  app.get('/limited', (_req, res) => res.status(200).json({ ok: true }))
  return app
}

const makeHealthApp = () => {
  const app = express()
  app.use('/api/health', createHealthRouter({ getMetrics: () => ({ queued: 0 }) } as any))
  return app
}

const suspiciousCount = (pattern: string): number => {
  const snapshot = getSecurityMetricsSnapshot() as any
  return snapshot.metrics.suspiciousPatterns[pattern]
}

const suspiciousLogs = (logSpy: jest.SpiedFunction<typeof console.log>, pattern?: string) =>
  logSpy.mock.calls
    .map(([line]) => JSON.parse(String(line)))
    .filter((entry) => entry.event === 'security.suspicious_pattern')
    .filter((entry) => (pattern ? entry.pattern === pattern : true))

describe('security abuse monitor suspicious pattern alerts', () => {
  let now = 1_000_000
  let dateSpy: jest.SpiedFunction<typeof Date.now>
  let logSpy: jest.SpiedFunction<typeof console.log>

  beforeEach(() => {
    now = 1_000_000
    dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    __resetSecurityMonitorForTests()
  })

  afterEach(() => {
    dateSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('emits and counts a high_volume alert once threshold is reached', async () => {
    const app = makeMetricsApp()

    await request(app).get('/ok').set('x-forwarded-for', '10.0.0.1').expect(200)
    await request(app).get('/ok').set('x-forwarded-for', '10.0.0.1').expect(200)
    await request(app).get('/ok').set('x-forwarded-for', '10.0.0.1').expect(200)

    expect(suspiciousCount('high_volume')).toBe(1)
    expect(suspiciousLogs(logSpy, 'high_volume')).toHaveLength(1)
  })

  it('requires both 404 count and distinct paths for endpoint_scan', async () => {
    const app = makeMetricsApp()

    await request(app).get('/missing/same').set('x-forwarded-for', '10.0.0.2').expect(404)
    await request(app).get('/missing/same').set('x-forwarded-for', '10.0.0.2').expect(404)
    await request(app).get('/missing/same').set('x-forwarded-for', '10.0.0.2').expect(404)

    expect(suspiciousCount('endpoint_scan')).toBe(0)

    await request(app).get('/missing/a').set('x-forwarded-for', '10.0.0.3').expect(404)
    await request(app).get('/missing/b').set('x-forwarded-for', '10.0.0.3').expect(404)
    await request(app).get('/missing/c?token=secret').set('x-forwarded-for', '10.0.0.3').expect(404)

    expect(suspiciousCount('endpoint_scan')).toBe(1)
    const [log] = suspiciousLogs(logSpy, 'endpoint_scan')
    expect(log).toMatchObject({
      pattern: 'endpoint_scan',
      current404Count: 3,
      distinctPathCount: 3,
    })
    expect(JSON.stringify(log)).not.toContain('token=secret')
  })

  it('emits repeated_bad_requests alerts for repeated 400 responses', async () => {
    const app = makeMetricsApp()

    await request(app).get('/bad').set('x-forwarded-for', '10.0.0.4').expect(400)
    await request(app).get('/bad').set('x-forwarded-for', '10.0.0.4').expect(400)
    await request(app).get('/bad').set('x-forwarded-for', '10.0.0.4').expect(400)

    expect(suspiciousCount('repeated_bad_requests')).toBe(1)
    expect(suspiciousLogs(logSpy, 'repeated_bad_requests')).toHaveLength(1)
  })

  it('emits failed_login_burst alerts for /auth and /login failures', async () => {
    const app = makeMetricsApp()

    await request(app).post('/auth/login').set('x-forwarded-for', '10.0.0.5').expect(401)
    await request(app).post('/login').set('x-forwarded-for', '10.0.0.5').expect(403)
    await request(app).post('/auth/login').set('x-forwarded-for', '10.0.0.5').expect(401)

    const snapshot = getSecurityMetricsSnapshot() as any
    expect(snapshot.metrics.failedLoginAttempts).toBe(3)
    expect(snapshot.metrics.suspiciousPatterns.failed_login_burst).toBe(1)
    expect(suspiciousLogs(logSpy, 'failed_login_burst')).toHaveLength(1)
  })

  it('deduplicates identical IP/category alerts inside cooldown and counts again after expiry', async () => {
    const app = makeMetricsApp()

    for (let i = 0; i < 3; i += 1) {
      await request(app).get('/bad').set('x-forwarded-for', '10.0.0.6').expect(400)
    }
    for (let i = 0; i < 3; i += 1) {
      await request(app).get('/bad').set('x-forwarded-for', '10.0.0.6').expect(400)
    }

    expect(suspiciousCount('repeated_bad_requests')).toBe(1)
    expect(suspiciousLogs(logSpy, 'repeated_bad_requests')).toHaveLength(1)

    now += 1_001
    await request(app).get('/bad').set('x-forwarded-for', '10.0.0.6').expect(400)
    await request(app).get('/bad').set('x-forwarded-for', '10.0.0.6').expect(400)
    await request(app).get('/bad').set('x-forwarded-for', '10.0.0.6').expect(400)

    expect(suspiciousCount('repeated_bad_requests')).toBe(2)
    expect(suspiciousLogs(logSpy, 'repeated_bad_requests')).toHaveLength(2)
  })

  it('deduplicates per IP independently', async () => {
    const app = makeMetricsApp()

    for (const ip of ['10.0.0.7', '10.0.0.8']) {
      for (let i = 0; i < 3; i += 1) {
        await request(app).get('/bad').set('x-forwarded-for', ip).expect(400)
      }
    }

    expect(suspiciousCount('repeated_bad_requests')).toBe(2)
  })

  it('deduplicates per category independently', async () => {
    const app = makeMetricsApp()

    for (let i = 0; i < 3; i += 1) {
      await request(app).get('/ok').set('x-forwarded-for', '10.0.0.7').expect(200)
    }

    expect(suspiciousCount('high_volume')).toBe(1)

    for (let i = 0; i < 3; i += 1) {
      await request(app).get('/bad').set('x-forwarded-for', '10.0.0.7').expect(400)
    }

    expect(suspiciousCount('high_volume')).toBe(1)
    expect(suspiciousCount('repeated_bad_requests')).toBe(1)
  })

  it('exposes accurate security snapshot through GET /api/health/security', async () => {
    const app = makeHealthApp()
    const metricsApp = makeMetricsApp()

    await request(metricsApp).post('/auth/login').set('x-forwarded-for', '10.0.0.9').expect(401)

    const res = await request(app).get('/api/health/security').expect(200)

    expect(res.body).toMatchObject({
      metrics: {
        failedLoginAttempts: 1,
        rateLimitTriggers: 0,
      },
      thresholds: {
        alertCooldownMs: 1000,
      },
      activeIpCount: 1,
    })
    expect(res.body.topSources[0]).toMatchObject({
      ip: '10.0.0.9',
      failedLoginsInWindow: 1,
    })
  })

  it('limits topSources to ten entries sorted by suspicious-window activity', async () => {
    const app = makeMetricsApp()

    for (let ipIndex = 1; ipIndex <= 11; ipIndex += 1) {
      for (let requestIndex = 0; requestIndex < ipIndex; requestIndex += 1) {
        await request(app).get('/ok').set('x-forwarded-for', `192.0.2.${ipIndex}`).expect(200)
      }
    }

    const snapshot = getSecurityMetricsSnapshot() as any
    expect(snapshot.topSources).toHaveLength(10)
    expect(snapshot.topSources[0]).toMatchObject({
      ip: '192.0.2.11',
      eventsInSuspiciousWindow: 11,
    })
    expect(snapshot.topSources.map((source: any) => source.ip)).not.toContain('192.0.2.1')
  })

  it('increments rate limit counters and emits rate limit logs', async () => {
    const app = makeRateLimitApp()

    await request(app).get('/limited').set('x-forwarded-for', '10.0.0.10').expect(200)
    await request(app).get('/limited').set('x-forwarded-for', '10.0.0.10').expect(200)
    await request(app).get('/limited').set('x-forwarded-for', '10.0.0.10').expect(200)
    await request(app).get('/limited').set('x-forwarded-for', '10.0.0.10').expect(429)

    const snapshot = getSecurityMetricsSnapshot() as any
    expect(snapshot.metrics.rateLimitTriggers).toBe(1)
    expect(logSpy.mock.calls.map(([line]) => JSON.parse(String(line))).some((entry) => entry.event === 'security.rate_limit_triggered')).toBe(true)
  })

  it('does not log request bodies, credentials, cookies, or email values', async () => {
    const app = makeMetricsApp()

    await request(app)
      .post('/auth/login')
      .set('x-forwarded-for', '10.0.0.11')
      .set('authorization', 'Bearer secret-token')
      .set('cookie', 'session=secret-cookie')
      .send({ email: 'person@example.com', password: 'secret-password' })
      .expect(401)

    const output = logSpy.mock.calls.map(([line]) => String(line)).join('\n')
    expect(output).not.toContain('secret-token')
    expect(output).not.toContain('secret-cookie')
    expect(output).not.toContain('person@example.com')
    expect(output).not.toContain('secret-password')
  })

  it('cleans up idle IP state on the periodic cleanup pass', async () => {
    const app = makeMetricsApp()

    await request(app).get('/ok').set('x-forwarded-for', '10.0.0.12').expect(200)

    // Cleanup runs every 200 processed response events. The 3_001ms jump is
    // beyond the configured stale window: max(1000, 1000, 1000) + 1000.
    now += 3_001
    for (let i = 0; i < 199; i += 1) {
      await request(app).get('/ok').set('x-forwarded-for', '10.0.0.13').expect(200)
    }

    const snapshot = getSecurityMetricsSnapshot() as any
    expect(snapshot.topSources.map((source: any) => source.ip)).not.toContain('10.0.0.12')
    expect(snapshot.topSources.map((source: any) => source.ip)).toContain('10.0.0.13')
  })

  it('reads array-form x-forwarded-for and falls back to socket remote address', () => {
    const callbacks: Array<() => void> = []
    const next = jest.fn()

    securityMetricsMiddleware(
      {
        headers: { 'x-forwarded-for': ['10.0.0.14, 10.0.0.15'] },
        originalUrl: '/ok',
        method: 'GET',
        socket: { remoteAddress: 'socket-ip' },
      } as any,
      {
        statusCode: 200,
        on: (_event: string, callback: () => void) => callbacks.push(callback),
      } as any,
      next,
    )
    callbacks[0]()

    securityMetricsMiddleware(
      {
        headers: {},
        originalUrl: '/ok',
        method: 'GET',
        socket: { remoteAddress: 'socket-ip' },
      } as any,
      {
        statusCode: 200,
        on: (_event: string, callback: () => void) => callbacks.push(callback),
      } as any,
      next,
    )
    callbacks[1]()

    const snapshot = getSecurityMetricsSnapshot() as any
    expect(snapshot.topSources.map((source: any) => source.ip)).toEqual(
      expect.arrayContaining(['10.0.0.14', 'socket-ip']),
    )
    expect(next).toHaveBeenCalledTimes(2)
  })
})
