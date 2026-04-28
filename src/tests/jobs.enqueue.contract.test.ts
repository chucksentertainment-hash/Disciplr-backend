import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { createJobsRouter } from '../routes/jobs.js'
import { BackgroundJobSystem } from '../jobs/system.js'
import { UserRole } from '../types/user.js'
import { clearAuditLogs, listAuditLogs } from '../lib/audit-logs.js'
import { JWT_AUDIENCE, JWT_ISSUER } from '../lib/auth-utils.js'

const noopLimiter = (_req: Request, _res: Response, next: NextFunction) => next()

let adminToken = ''
let userToken = ''

const validBody = {
  type: 'deadline.check',
  payload: { triggerSource: 'manual' },
} as const

describe('POST /api/jobs/enqueue contract', () => {
  const jobSystem = new BackgroundJobSystem()
  const app = express()
  app.use(express.json())
  app.use('/api/jobs', createJobsRouter(jobSystem, { enqueueLimiter: noopLimiter }))

  beforeAll(() => {
    jobSystem.start()
  })

  beforeAll(async () => {
    adminToken = jwt.sign(
      { userId: 'admin-contract', sub: 'admin-contract', role: UserRole.ADMIN },
      process.env.JWT_ACCESS_SECRET || 'fallback-access-secret',
      { audience: JWT_AUDIENCE, issuer: JWT_ISSUER, expiresIn: '15m' },
    )
    userToken = jwt.sign(
      { userId: 'user-contract', sub: 'user-contract', role: UserRole.USER },
      process.env.JWT_ACCESS_SECRET || 'fallback-access-secret',
      { audience: JWT_AUDIENCE, issuer: JWT_ISSUER, expiresIn: '15m' },
    )
  })

  beforeEach(() => {
    clearAuditLogs()
  })

  afterAll(async () => {
    await jobSystem.stop()
  })

  it('rejects non-admin callers', async () => {
    const response = await request(app)
      .post('/api/jobs/enqueue')
      .set('Authorization', `Bearer ${userToken}`)
      .send(validBody)

    expect(response.status).toBe(403)
  })

  it('rejects invalid options consistently', async () => {
    const response = await request(app)
      .post('/api/jobs/enqueue')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...validBody, delayMs: -1, maxAttempts: 2.5 })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    expect(response.body.error.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'delayMs' }),
        expect.objectContaining({ path: 'maxAttempts' }),
      ]),
    )
  })

  it('accepts valid payload and records an audit log', async () => {
    const response = await request(app)
      .post('/api/jobs/enqueue')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...validBody, delayMs: 1000, maxAttempts: 5 })

    expect(response.status).toBe(202)
    expect(response.body.job.type).toBe('deadline.check')
    expect(response.body.job.maxAttempts).toBe(5)

    const auditLogs = listAuditLogs({ action: 'job.enqueue', target_id: response.body.job.id, limit: 10 })
    expect(auditLogs).toHaveLength(1)
    expect(auditLogs[0]?.actor_user_id).toBe('admin-contract')
  })
})
