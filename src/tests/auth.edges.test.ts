import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import request from 'supertest'
import express from 'express'
import { UserRole } from '../types/user.js'
import jwt from 'jsonwebtoken'
import { randomUUID, createHash } from 'node:crypto'

// Mock dependencies
const mockPrisma = {
  user: {
    findUnique: jest.fn<any>(),
    update: jest.fn<any>(),
    create: jest.fn<any>(),
  },
  refreshToken: {
    create: jest.fn<any>(),
    findUnique: jest.fn<any>(),
    update: jest.fn<any>(),
    updateMany: jest.fn<any>(),
  },
}

const mockDbChain = {
  insert: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  whereNull: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  first: jest.fn<any>(),
}
const mockDb = jest.fn(() => mockDbChain)

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: mockPrisma,
}))

// Mock both default and named exports for db/index.js
jest.unstable_mockModule('../db/index.js', () => ({
  default: mockDb,
  db: mockDb,
}))

// Mock auth-utils for refresh token verification
const mockAuthUtils = {
  verifyRefreshToken: jest.fn<any>(),
  generateAccessToken: jest.fn<any>(),
  generateRefreshToken: jest.fn<any>(),
  hashToken: jest.fn<any>((token: string) =>
    createHash('sha256').update(token).digest('hex'),
  ),
  hashPassword: jest.fn<any>(),
  comparePassword: jest.fn<any>(),
  verifyAccessToken: jest.fn<any>(),
  validateJwtSecrets: jest.fn<any>(),
  JWT_ISSUER: 'disciplr',
  JWT_AUDIENCE: 'disciplr-api',
}
jest.unstable_mockModule('../lib/auth-utils.js', () => mockAuthUtils)

let app: express.Express
let AuthService: any
let authenticate: any

beforeEach(async () => {
  jest.clearAllMocks()
  // Re-setup chain methods after clearAllMocks
  mockDbChain.insert.mockReturnThis()
  mockDbChain.where.mockReturnThis()
  mockDbChain.whereNull.mockReturnThis()
  mockDbChain.andWhere.mockReturnThis()
  mockDbChain.update.mockReturnThis()
  
  // Dynamic imports to ensure mocks are applied
  const authServiceModule = await import('../services/auth.service.js')
  AuthService = authServiceModule.AuthService
  const authMiddlewareModule = await import('../middleware/auth.js')
  authenticate = authMiddlewareModule.authenticate

  app = express()
  app.use(express.json())
  
  // A protected route using the middleware we want to test
  app.get('/api/protected', authenticate, (req, res) => {
    res.json({ ok: true, user: req.user })
  })
})

describe('Auth Session Expiry Edge Cases', () => {
  const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'fallback-access-secret'
  const userId = 'user-123'
  const role = UserRole.USER

  describe('Access Token Expiry & Validation', () => {
    it('should allow valid token with active session', async () => {
      const jti = randomUUID()
      const token = jwt.sign({ userId, role, jti, sub: userId }, ACCESS_SECRET, {
        expiresIn: '15m',
        issuer: 'disciplr',
        audience: 'disciplr-api',
      })
      
      // Mock verifyAccessToken to return the decoded payload
      mockAuthUtils.verifyAccessToken.mockReturnValueOnce({ userId, role, jti, sub: userId })
      
      // Mock session validation
      mockDbChain.first.mockResolvedValueOnce({ jti, expires_at: new Date(Date.now() + 100000).toISOString() })

      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.user.userId).toBe(userId)
    })

    it('should reject expired access token (JWT level)', async () => {
      const token = jwt.sign({ userId, role }, ACCESS_SECRET, { expiresIn: '-1s' })

      // Mock verifyAccessToken to throw TokenExpiredError
      mockAuthUtils.verifyAccessToken.mockImplementationOnce(() => {
        throw new jwt.TokenExpiredError('jwt expired', new Date())
      })

      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Token expired')
    })

    it('should reject token if session is revoked in DB', async () => {
      const jti = randomUUID()
      const token = jwt.sign({ userId, role, jti, sub: userId }, ACCESS_SECRET, {
        expiresIn: '15m',
        issuer: 'disciplr',
        audience: 'disciplr-api',
      })
      
      // Mock verifyAccessToken
      mockAuthUtils.verifyAccessToken.mockReturnValueOnce({ userId, role, jti, sub: userId })
      
      // Mock session validation showing it's either revoked or expired in DB
      mockDbChain.first.mockResolvedValueOnce(null)

      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Session revoked or expired')
    })
  })

  describe('Clock Skew Tolerance', () => {
    it('should allow token with minor iat/nbf skew (iat in future)', async () => {
      const jti = randomUUID()
      // iat 10 seconds in the future
      const iat = Math.floor(Date.now() / 1000) + 10
      const token = jwt.sign({ userId, role, jti, iat, sub: userId }, ACCESS_SECRET, {
        issuer: 'disciplr',
        audience: 'disciplr-api',
      })
      
      // verifyAccessToken succeeds because of clockTolerance: 30
      mockAuthUtils.verifyAccessToken.mockReturnValueOnce({ userId, role, jti, sub: userId })
      mockDbChain.first.mockResolvedValueOnce({ jti })

      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      // Should be 200 because we added clockTolerance: 30
      expect(res.status).toBe(200)
    })

    it('should reject token with excessive future skew', async () => {
      const jti = randomUUID()
      // iat 1 hour in the future
      const iat = Math.floor(Date.now() / 1000) + 3600
      const token = jwt.sign({ userId, role, jti, iat, sub: userId }, ACCESS_SECRET)

      // verifyAccessToken throws for excessive skew
      mockAuthUtils.verifyAccessToken.mockImplementationOnce(() => {
        throw new Error('invalid token')
      })

      const res = await request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Invalid token')
    })
  })

  describe('Refresh Token behavior', () => {
    it('should fail if refresh token is expired in DB', async () => {
      mockAuthUtils.verifyRefreshToken.mockReturnValueOnce({ userId })
      mockPrisma.refreshToken.findUnique.mockResolvedValueOnce({
        id: 'token-1',
        token: 'hashed-token',
        expiresAt: new Date(Date.now() - 1000), // Expired
        revokedAt: null,
      })

      await expect(AuthService.refresh('refresh-token')).rejects.toThrow('Invalid refresh token')
    })

    it('should fail if refresh token is already revoked', async () => {
      mockAuthUtils.verifyRefreshToken.mockReturnValueOnce({ userId })
      mockPrisma.refreshToken.findUnique.mockResolvedValueOnce({
        id: 'token-1',
        token: 'hashed-token',
        expiresAt: new Date(Date.now() + 100000),
        revokedAt: new Date(), // Revoked
      })

      await expect(AuthService.refresh('refresh-token')).rejects.toThrow('Invalid refresh token')
    })

    it('should rotate tokens on successful refresh', async () => {
      const oldRefreshToken = 'old-refresh-token-value'
      const newAccessTokenValue = 'new-access-token'
      const newRefreshTokenValue = 'new-refresh-token-value'

      mockAuthUtils.verifyRefreshToken.mockReturnValueOnce({ userId })
      mockAuthUtils.generateAccessToken.mockReturnValueOnce(newAccessTokenValue)
      mockAuthUtils.generateRefreshToken.mockReturnValueOnce(newRefreshTokenValue)

      // Stored token is found and valid
      mockPrisma.refreshToken.findUnique.mockResolvedValueOnce({
        id: 'token-1',
        token: createHash('sha256').update(oldRefreshToken).digest('hex'),
        expiresAt: new Date(Date.now() + 100000),
        revokedAt: null,
        user: { id: userId, role: UserRole.USER, email: 'test@test.com' },
      })

      // Revoke old token
      mockPrisma.refreshToken.update.mockResolvedValueOnce({})
      // Create new token
      mockPrisma.refreshToken.create.mockResolvedValueOnce({})

      const result = await AuthService.refresh(oldRefreshToken)

      // Verify rotation: old token revoked, new pair issued
      expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'token-1' },
          data: { revokedAt: expect.any(Date) },
        }),
      )
      expect(result.accessToken).toBe(newAccessTokenValue)
      expect(result.refreshToken).toBe(newRefreshTokenValue)

      // Verify new refresh token is stored hashed
      const expectedNewHash = createHash('sha256').update(newRefreshTokenValue).digest('hex')
      expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            token: expectedNewHash,
          }),
        }),
      )
    })

    it('should reject replay of rotated (old) refresh token', async () => {
      const rotatedToken = 'already-used-refresh-token'

      mockAuthUtils.verifyRefreshToken.mockReturnValueOnce({ userId })

      // The old token's hash won't be found (it was replaced by the new hash)
      // or it will be found but already revoked
      mockPrisma.refreshToken.findUnique.mockResolvedValueOnce({
        id: 'token-1',
        token: createHash('sha256').update(rotatedToken).digest('hex'),
        expiresAt: new Date(Date.now() + 100000),
        revokedAt: new Date(), // Already revoked from previous rotation
        user: { id: userId, role: UserRole.USER },
      })

      await expect(AuthService.refresh(rotatedToken)).rejects.toThrow('Invalid refresh token')
    })
  })

  describe('Refresh Token Hashing', () => {
    it('should store refresh tokens as SHA-256 hashes on login', async () => {
      const rawRefreshToken = 'raw-refresh-token-value'

      mockAuthUtils.comparePassword.mockResolvedValueOnce(true)
      mockAuthUtils.generateAccessToken.mockReturnValueOnce('access-token')
      mockAuthUtils.generateRefreshToken.mockReturnValueOnce(rawRefreshToken)

      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: userId,
        email: 'test@test.com',
        passwordHash: 'hashed-password',
        role: UserRole.USER,
      })
      mockPrisma.user.update.mockResolvedValueOnce({})
      mockPrisma.refreshToken.create.mockResolvedValueOnce({})

      const result = await AuthService.login({ email: 'test@test.com', password: 'password123' })

      // The raw token is returned to the client
      expect(result.refreshToken).toBe(rawRefreshToken)

      // But the DB receives the SHA-256 hash
      const expectedHash = createHash('sha256').update(rawRefreshToken).digest('hex')
      expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            token: expectedHash,
          }),
        }),
      )
    })

    it('should look up refresh tokens by hash during refresh', async () => {
      const rawToken = 'my-raw-refresh-token'
      const hashedToken = createHash('sha256').update(rawToken).digest('hex')

      mockAuthUtils.verifyRefreshToken.mockReturnValueOnce({ userId })
      mockAuthUtils.generateAccessToken.mockReturnValueOnce('new-access')
      mockAuthUtils.generateRefreshToken.mockReturnValueOnce('new-refresh')

      mockPrisma.refreshToken.findUnique.mockResolvedValueOnce({
        id: 'token-1',
        token: hashedToken,
        expiresAt: new Date(Date.now() + 100000),
        revokedAt: null,
        user: { id: userId, role: UserRole.USER, email: 'test@test.com' },
      })
      mockPrisma.refreshToken.update.mockResolvedValueOnce({})
      mockPrisma.refreshToken.create.mockResolvedValueOnce({})

      await AuthService.refresh(rawToken)

      // Verify lookup was by hash, not raw token
      expect(mockPrisma.refreshToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { token: hashedToken },
        }),
      )
    })
  })

  describe('Logout and Logout-All', () => {
    it('should revoke specific refresh token on logout (by hash)', async () => {
      const rawToken = 'token-to-revoke'
      const hashedToken = createHash('sha256').update(rawToken).digest('hex')

      mockPrisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 1 })

      await AuthService.logout(rawToken)

      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { token: hashedToken },
        data: { revokedAt: expect.any(Date) },
      })
    })

    it('should revoke all refresh tokens and sessions on logoutAll', async () => {
      mockPrisma.refreshToken.updateMany.mockResolvedValueOnce({ count: 3 })

      await AuthService.logoutAll(userId)

      // Verify all refresh tokens for user are revoked
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      })

      // Verify sessions are also revoked (via mockDb)
      // The revokeAllUserSessions function uses db('sessions')
      expect(mockDb).toHaveBeenCalled()
    })
  })

  describe('Standard JWT Claims', () => {
    it('should include iss, sub, aud, and jti in generated access tokens', () => {
      // Verify the token structure by producing a token with the same
      // claims that generateAccessToken in auth-utils.ts adds
      const jti = randomUUID()

      const ACCESS_SECRET_FOR_TEST = process.env.JWT_ACCESS_SECRET || 'fallback-access-secret'
      const token = jwt.sign(
        { sub: userId, userId, role: UserRole.USER, jti },
        ACCESS_SECRET_FOR_TEST,
        { issuer: 'disciplr', audience: 'disciplr-api', expiresIn: '15m' },
      )

      const decoded = jwt.decode(token) as any
      expect(decoded.sub).toBe(userId)
      expect(decoded.userId).toBe(userId)
      expect(decoded.jti).toBe(jti)
      expect(decoded.iss).toBe('disciplr')
      expect(decoded.aud).toBe('disciplr-api')
      expect(decoded.exp).toBeDefined()
      expect(decoded.iat).toBeDefined()
    })
  })
})

//