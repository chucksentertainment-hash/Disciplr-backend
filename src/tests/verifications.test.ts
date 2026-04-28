import request from 'supertest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import { verificationsRouter } from '../routes/verifications.js'
import { clearAuditLogs, listAuditLogs } from '../lib/audit-logs.js'
import { UserRole } from '../types/user.js'

type Decision = {
  id: string
  verifierUserId: string
  targetId: string
  result: 'approved' | 'rejected'
  disputed: boolean
  timestamp: string
}

const decisions: Decision[] = []

jest.mock('../services/verifiers.js', () => {
  class VerificationConflictError extends Error {
    constructor() {
      super('conflict: decision already made')
      this.name = 'VerificationConflictError'
    }
  }

  return {
recordVerification: jest.fn(async (
  verifierUserId: string,
  targetId: string,
  result: 'approved' | 'rejected',
  isDisputed: boolean = false,
) => {
  const existing = decisions.find(
    (d) => d.verifierUserId === verifierUserId && d.targetId === targetId,
  )

  if (existing) {
    if (existing.result === result) return existing
    throw new VerificationConflictError()
  }

  const decision: Decision = {
    id: `verification-${decisions.length + 1}`,
    verifierUserId,
    targetId,
    result,
    disputed: isDisputed,
    timestamp: new Date().toISOString(),
  }

  decisions.push(decision)
  return decision
}),
    listVerifications: jest.fn(async () => decisions),
  }
})

const app = express()
app.use(express.json())
app.use('/api/verifications', verificationsRouter)

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

const bearer = (userId: string, role: UserRole = UserRole.VERIFIER) =>
  `Bearer ${jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '1h' })}`

beforeEach(() => {
  decisions.length = 0
  clearAuditLogs()
})

describe('Verification workflow endpoints', () => {
  it('requires authentication for verification decisions', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .send({ targetId: 'vault-1', result: 'approved' })

    expect(res.status).toBe(401)
  })

  it('enforces verifier or admin role for approval', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .set('Authorization', bearer('user-1', UserRole.USER))
      .send({ targetId: 'vault-1', result: 'approved' })

    expect(res.status).toBe(403)
  })

  it('records an approval decision and audit log', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .set('Authorization', bearer('verifier-1'))
      .send({ targetId: 'vault-1', result: 'approved' })

    expect(res.status).toBe(201)
    expect(res.body.verification).toMatchObject({
      verifierUserId: 'verifier-1',
      targetId: 'vault-1',
      result: 'approved',
      disputed: false,
    })

    const logs = listAuditLogs({ action: 'verification.decision.recorded' })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      actor_user_id: 'verifier-1',
      target_type: 'verification',
      target_id: 'vault-1',
    })
  })

  it('records a rejection decision', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .set('Authorization', bearer('verifier-1'))
      .send({ targetId: 'milestone-1', result: 'rejected', disputed: true })

    expect(res.status).toBe(201)
    expect(res.body.verification).toMatchObject({
      verifierUserId: 'verifier-1',
      targetId: 'milestone-1',
      result: 'rejected',
      disputed: true,
    })
  })

  it('replays duplicate approval idempotently', async () => {
    const first = await request(app)
      .post('/api/verifications')
      .set('Authorization', bearer('verifier-1'))
      .send({ targetId: 'vault-2', result: 'approved' })

    const replay = await request(app)
      .post('/api/verifications')
      .set('Authorization', bearer('verifier-1'))
      .send({ targetId: 'vault-2', result: 'approved' })

    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(replay.body.verification.id).toBe(first.body.verification.id)
  })

  it('rejects approve after reject as conflict', async () => {
    await request(app)
      .post('/api/verifications')
      .set('Authorization', bearer('verifier-1'))
      .send({ targetId: 'vault-3', result: 'rejected' })

    const res = await request(app)
      .post('/api/verifications')
      .set('Authorization', bearer('verifier-1'))
      .send({ targetId: 'vault-3', result: 'approved' })

    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/conflicting verification decision/i)
  })

  it('rejects invalid result values', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .set('Authorization', bearer('verifier-1'))
      .send({ targetId: 'vault-4', result: 'maybe' })

    expect(res.status).toBe(400)
  })

  it('requires targetId', async () => {
    const res = await request(app)
      .post('/api/verifications')
      .set('Authorization', bearer('verifier-1'))
      .send({ result: 'approved' })

    expect(res.status).toBe(400)
  })

  it('allows admin to list verification records', async () => {
    await request(app)
      .post('/api/verifications')
      .set('Authorization', bearer('verifier-1'))
      .send({ targetId: 'vault-5', result: 'approved' })

    const res = await request(app)
      .get('/api/verifications')
      .set('Authorization', bearer('admin-1', UserRole.ADMIN))

    expect(res.status).toBe(200)
    expect(res.body.verifications).toHaveLength(1)
  })

  it('forbids non-admin from listing verification records', async () => {
    const res = await request(app)
      .get('/api/verifications')
      .set('Authorization', bearer('verifier-1'))

    expect(res.status).toBe(403)
  })
})