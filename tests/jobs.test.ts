import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import { generateAccessToken } from '../src/lib/auth-utils.js'
import { UserRole } from '../src/types/user.js'
import { createJobsRouter } from '../src/routes/jobs.js'
import { BackgroundJobSystem } from '../src/jobs/system.js'
import { clearAuditLogs, listAuditLogs } from '../src/lib/audit-logs.js'

// ---------------------------------------------------------------------------
// Test app – minimal Express instance with the jobs router mounted.
// We bypass the full index.ts bootstrap (which starts a real server and DB)
// and inject a no-op rate limiter so the 10-req/hr strictRateLimiter doesn't
// interfere with the test suite.
// ---------------------------------------------------------------------------

const noopLimiter = (_req: Request, _res: Response, next: NextFunction) => next()

const jobSystem = new BackgroundJobSystem()
jobSystem.start()

const testApp = express()
testApp.use(express.json())
testApp.use('/api/jobs', createJobsRouter(jobSystem, { enqueueLimiter: noopLimiter }))

afterAll(async () => {
  await jobSystem.stop()
})

// ---------------------------------------------------------------------------
// Token fixtures
// ---------------------------------------------------------------------------

const adminToken = generateAccessToken({ userId: 'admin-jobs-test', role: UserRole.ADMIN })
const userToken = generateAccessToken({ userId: 'user-jobs-test', role: UserRole.USER })
const verifierToken = generateAccessToken({ userId: 'verifier-jobs-test', role: UserRole.VERIFIER })

// ---------------------------------------------------------------------------
// Valid request bodies for each job type
// ---------------------------------------------------------------------------

const validBodies = {
  'notification.send': {
    type: 'notification.send',
    payload: { recipient: 'user@example.com', subject: 'Hello', body: 'Test message' },
  },
  'deadline.check': {
    type: 'deadline.check',
    payload: { triggerSource: 'manual' },
  },
  'oracle.call': {
    type: 'oracle.call',
    payload: { oracle: 'chainlink', symbol: 'XLM' },
  },
  'analytics.recompute': {
    type: 'analytics.recompute',
    payload: { scope: 'global' },
  },
} as const

// ---------------------------------------------------------------------------

describe('Jobs API', () => {
  beforeEach(() => {
    clearAuditLogs()
  })

  // -------------------------------------------------------------------------
  describe('Authentication', () => {
    const routes = [
      { method: 'get', path: '/api/jobs/metrics' },
      { method: 'get', path: '/api/jobs/health' },
      { method: 'post', path: '/api/jobs/enqueue' },
    ] as const

    for (const { method, path } of routes) {
      it(`${method.toUpperCase()} ${path} – 401 with no token`, async () => {
        const res = await (request(testApp) as any)[method](path)
        expect(res.status).toBe(401)
        expect(res.body).toHaveProperty('error')
      })

      it(`${method.toUpperCase()} ${path} – 401 with a malformed token`, async () => {
        const res = await (request(testApp) as any)[method](path)
          .set('Authorization', 'Bearer not-a-real-token')
        expect(res.status).toBe(401)
        expect(res.body).toHaveProperty('error')
      })
    }
  })

  // -------------------------------------------------------------------------
  describe('Authorization – non-admin roles', () => {
    const routes = [
      { method: 'get', path: '/api/jobs/metrics' },
      { method: 'get', path: '/api/jobs/health' },
      { method: 'post', path: '/api/jobs/enqueue' },
    ] as const

    for (const { method, path } of routes) {
      it(`${method.toUpperCase()} ${path} – 403 for USER role`, async () => {
        const res = await (request(testApp) as any)[method](path)
          .set('Authorization', `Bearer ${userToken}`)
          .send(validBodies['notification.send'])
        expect(res.status).toBe(403)
        expect(res.body).toHaveProperty('error')
      })

      it(`${method.toUpperCase()} ${path} – 403 for VERIFIER role`, async () => {
        const res = await (request(testApp) as any)[method](path)
          .set('Authorization', `Bearer ${verifierToken}`)
          .send(validBodies['notification.send'])
        expect(res.status).toBe(403)
        expect(res.body).toHaveProperty('error')
      })
    }

    it('POST /api/jobs/enqueue – 403 for USER role attempting deadline.check', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${userToken}`)
        .send(validBodies['deadline.check'])

      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error')
    })
  })

  // -------------------------------------------------------------------------
  describe('GET /api/jobs/metrics', () => {
    it('returns 200 with queue metrics for admin', async () => {
      const res = await request(testApp)
        .get('/api/jobs/metrics')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(res.body).toHaveProperty('running')
      expect(res.body).toHaveProperty('concurrency')
      expect(res.body).toHaveProperty('queueDepth')
      expect(res.body).toHaveProperty('byType')
    })

    it('totals contains all expected counter fields', async () => {
      const res = await request(testApp)
        .get('/api/jobs/metrics')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(res.body.totals).toMatchObject({
        enqueued: expect.any(Number),
        executions: expect.any(Number),
        completed: expect.any(Number),
        failed: expect.any(Number),
        retried: expect.any(Number),
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('GET /api/jobs/health', () => {
    it('returns a health document for admin', async () => {
      const res = await request(testApp)
        .get('/api/jobs/health')
        .set('Authorization', `Bearer ${adminToken}`)

      expect([200, 503]).toContain(res.status)
      expect(res.body).toHaveProperty('status')
      expect(res.body).toHaveProperty('timestamp')
      expect(res.body).toHaveProperty('queue')
    })

    it('queue sub-document contains expected fields', async () => {
      const res = await request(testApp)
        .get('/api/jobs/health')
        .set('Authorization', `Bearer ${adminToken}`)

      expect(res.body.queue).toMatchObject({
        running: expect.any(Boolean),
        queueDepth: expect.any(Number),
        delayedJobs: expect.any(Number),
        activeJobs: expect.any(Number),
        failureRate: expect.any(Number),
      })
    })

    it('status is one of: ok | degraded | down', async () => {
      const res = await request(testApp)
        .get('/api/jobs/health')
        .set('Authorization', `Bearer ${adminToken}`)

      expect(['ok', 'degraded', 'down']).toContain(res.body.status)
    })
  })

  // -------------------------------------------------------------------------
  describe('POST /api/jobs/enqueue – input validation', () => {
    it('returns 400 when body is not a JSON object', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send([1, 2, 3])
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields.some((f: { path: string }) => f.path === 'root')).toBe(true)
    })

    it('returns 400 for an unknown job type', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ type: 'unknown.job', payload: {} })
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields.some((f: { path: string }) => f.path === 'type')).toBe(true)
    })

    it('returns 400 when type is missing', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ payload: { triggerSource: 'manual' } })
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields.some((f: { path: string }) => f.path === 'type')).toBe(true)
    })

    it('returns 400 for invalid notification.send payload (missing required fields)', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ type: 'notification.send', payload: { recipient: 'x@x.com' } })
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields.some((f: { path: string }) => f.path === 'payload.subject')).toBe(true)
      expect(res.body.error.fields.some((f: { path: string }) => f.path === 'payload.body')).toBe(true)
    })

    it('returns 400 for invalid deadline.check payload (bad triggerSource)', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ type: 'deadline.check', payload: { triggerSource: 'cron' } })
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields.some((f: { path: string }) => f.path === 'payload.triggerSource')).toBe(true)
    })

    it('returns 400 for invalid oracle.call payload (missing oracle)', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ type: 'oracle.call', payload: { symbol: 'XLM' } })
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields.some((f: { path: string }) => f.path === 'payload.oracle')).toBe(true)
    })

    it('returns 400 for invalid analytics.recompute payload (bad scope)', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ type: 'analytics.recompute', payload: { scope: 'everything' } })
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields.some((f: { path: string }) => f.path === 'payload.scope')).toBe(true)
    })

    it('returns 400 for negative delayMs', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validBodies['deadline.check'], delayMs: -1 })
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields).toContainEqual(expect.objectContaining({ path: 'delayMs' }))
    })

    it('returns 400 for non-numeric delayMs', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validBodies['deadline.check'], delayMs: 'soon' })
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields).toContainEqual(expect.objectContaining({ path: 'delayMs' }))
    })

    it('returns 400 for maxAttempts below 1', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validBodies['deadline.check'], maxAttempts: 0 })
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields).toContainEqual(expect.objectContaining({ path: 'maxAttempts' }))
    })

    it('returns 400 for maxAttempts above 10', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validBodies['deadline.check'], maxAttempts: 11 })
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields).toContainEqual(expect.objectContaining({ path: 'maxAttempts' }))
    })

    it('returns 400 for non-integer maxAttempts', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validBodies['deadline.check'], maxAttempts: 2.5 })
        .expect(400)

      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields).toContainEqual(expect.objectContaining({ path: 'maxAttempts' }))
    })
  })

  // -------------------------------------------------------------------------
  describe('POST /api/jobs/enqueue – success cases', () => {
    for (const [jobType, body] of Object.entries(validBodies)) {
      it(`enqueues a ${jobType} job and returns 202`, async () => {
        const res = await request(testApp)
          .post('/api/jobs/enqueue')
          .set('Authorization', `Bearer ${adminToken}`)
          .send(body)
          .expect(202)

        expect(res.body).toMatchObject({
          queued: true,
          job: {
            id: expect.any(String),
            type: jobType,
            runAt: expect.any(String),
            maxAttempts: expect.any(Number),
          },
        })
      })
    }

    it('respects delayMs option', async () => {
      const now = Date.now()
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validBodies['deadline.check'], delayMs: 60_000 })
        .expect(202)

      expect(new Date(res.body.job.runAt).getTime()).toBeGreaterThanOrEqual(now + 59_000)
    })

    it('floors decimal delayMs as part of options parsing', async () => {
      const now = Date.now()
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validBodies['deadline.check'], delayMs: 1500.9 })
        .expect(202)

      expect(new Date(res.body.job.runAt).getTime()).toBeGreaterThanOrEqual(now + 1400)
      expect(new Date(res.body.job.runAt).getTime()).toBeLessThanOrEqual(now + 2500)
    })

    it('respects maxAttempts option', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...validBodies['deadline.check'], maxAttempts: 5 })
        .expect(202)

      expect(res.body.job.maxAttempts).toBe(5)
    })

    it('defaults maxAttempts to 3 when not provided', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(validBodies['deadline.check'])
        .expect(202)

      expect(res.body.job.maxAttempts).toBe(3)
    })

    it('writes an audit log entry for successful enqueue', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(validBodies['analytics.recompute'])
        .expect(202)

      const logs = listAuditLogs({ action: 'job.enqueue', target_id: res.body.job.id, limit: 10 })
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({
        actor_user_id: 'admin-jobs-test',
        action: 'job.enqueue',
        target_type: 'job',
        target_id: res.body.job.id,
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('POST /api/jobs/enqueue – response shape', () => {
    it('job.id is a UUID', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(validBodies['analytics.recompute'])
        .expect(202)

      expect(res.body.job.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
    })

    it('job.runAt is a valid ISO-8601 string', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(validBodies['analytics.recompute'])
        .expect(202)

      expect(new Date(res.body.job.runAt).toISOString()).toBe(res.body.job.runAt)
    })

    it('queued is true', async () => {
      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(validBodies['oracle.call'])
        .expect(202)

      expect(res.body.queued).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  describe('Rate limiting – enqueue limiter is applied in production', () => {
    it('response from enqueue includes RateLimit headers when limiter is active', async () => {
      // Create a separate app that uses the real strictRateLimiter
      const { createJobsRouter: makeRouter } = await import('../src/routes/jobs.js')
      const limitedApp = express()
      limitedApp.use(express.json())
      limitedApp.use('/api/jobs', makeRouter(jobSystem))

      const res = await request(limitedApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(validBodies['deadline.check'])

      // strictRateLimiter uses standardHeaders:true — RateLimit-* headers must be present
      const hasRateLimitHeader =
        'ratelimit-limit' in res.headers ||
        'x-ratelimit-limit' in res.headers ||
        'ratelimit-remaining' in res.headers

      expect(hasRateLimitHeader).toBe(true)
    })
  })
})
