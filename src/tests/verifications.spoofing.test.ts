import express from 'express'
import request from 'supertest'
import { jest } from '@jest/globals'

const mockRecordVerification = jest.fn<any>()
const mockListVerifications = jest.fn<any>()

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 'auth-verifier', role: 'VERIFIER' } as any
    next()
  },
}))

jest.unstable_mockModule('../middleware/rbac.js', () => ({
  requireVerifier: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireActiveVerifier: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.verifier = { userId: 'auth-verifier', status: 'approved', createdAt: new Date().toISOString() } as any
    next()
  },
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

jest.unstable_mockModule('../services/verifiers.js', () => ({
  recordVerification: mockRecordVerification,
  listVerifications: mockListVerifications,
}))

const { verificationsRouter } = await import('../routes/verifications.js')

describe('verification route spoofing protections', () => {
  const app = express()
  app.use(express.json())
  app.use('/api/verifications', verificationsRouter)

  beforeEach(() => {
    mockRecordVerification.mockReset()
    mockListVerifications.mockReset()
  })

  test('uses authenticated verifier identity, not client-supplied body identity', async () => {
    mockRecordVerification.mockResolvedValue({
      id: 'verification-1',
      verifierUserId: 'auth-verifier',
      targetId: 'target-1',
      result: 'approved',
      disputed: false,
      timestamp: new Date().toISOString(),
    })

    await request(app)
      .post('/api/verifications')
      .send({
        verifierUserId: 'spoofed-verifier',
        userId: 'spoofed-verifier',
        targetId: 'target-1',
        result: 'approved',
      })
      .expect(201)

    expect(mockRecordVerification).toHaveBeenCalledWith('auth-verifier', 'target-1', 'approved', false)
  })
})
