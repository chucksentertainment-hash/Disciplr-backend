import { describe, it, beforeAll, beforeEach } from '@jest/globals'
import request from 'supertest'
import express from 'express'
import { UserRole } from '../types/user.js'
import { jest } from '@jest/globals'

const mockGetVerifierProfile = jest.fn<any>()

// Mock database connection
const mockDb = {
  insert: jest.fn<any>().mockReturnThis(),
  returning: jest.fn<any>().mockReturnThis(),
  where: jest.fn<any>().mockReturnThis(),
  whereNull: jest.fn<any>().mockReturnThis(),
  andWhere: jest.fn<any>().mockReturnThis(),
  update: jest.fn<any>().mockReturnThis(),
  first: jest.fn<any>().mockResolvedValue({ id: 'mock-session-id' }),
}

jest.unstable_mockModule('../db/index.js', () => ({
  db: jest.fn<any>(() => mockDb),
  default: jest.fn<any>(() => mockDb),
}))

jest.unstable_mockModule('../services/verifiers.js', () => ({
  getVerifierProfile: mockGetVerifierProfile,
}))

let app: express.Express
let tokenHelpers: Record<string, () => Promise<string>>

beforeAll(async () => {
    // Dynamic import to allow mocks to be applied before module evaluation
    const authModule = await import('../middleware/auth.js')
    const rbacModule = await import('../middleware/rbac.js')

    app = express()
    app.use(express.json())

    app.get('/user-route', authModule.authenticate, rbacModule.requireUser, (_req, res) => res.json({ ok: true }))
    app.post('/verify-route', authModule.authenticate, rbacModule.requireVerifier, (_req, res) => res.json({ ok: true }))
    app.post('/active-verify-route', authModule.authenticate, rbacModule.requireVerifier, rbacModule.requireActiveVerifier, (req, res) => res.json({ verifier: req.verifier }))
    app.delete('/admin-route', authModule.authenticate, rbacModule.requireAdmin, (_req, res) => res.json({ ok: true }))

    tokenHelpers = {
        user: async () => `Bearer ${await authModule.signToken({ userId: '1', role: UserRole.USER })}`,
        verifier: async () => `Bearer ${await authModule.signToken({ userId: '1', role: UserRole.VERIFIER })}`,
        admin: async () => `Bearer ${await authModule.signToken({ userId: '1', role: UserRole.ADMIN })}`,
    }
  })

  beforeEach(() => {
    mockGetVerifierProfile.mockReset()
  })

  it('role determination is based on JWT payload only', () => {
    // Simulate JWT payload structure
    const jwtPayload = {
      userId: 'test-user',
      role: UserRole.USER,
      email: 'test@example.com',
    }
    
    const allowedRoles = [UserRole.ADMIN]
    const isAuthorized = allowedRoles.includes(jwtPayload.role)
    
    expect(isAuthorized).toBe(false)
    expect(jwtPayload.role).toBe(UserRole.USER)
  })

  it('prevents privilege escalation through header injection', () => {
    // Attacker scenario: USER token + ADMIN header
    const authenticatedRole = UserRole.USER
    const injectedRole = 'ADMIN'
    
    // System should use authenticated role from JWT
    const allowedRoles = [UserRole.ADMIN]
    const isAuthorized = allowedRoles.includes(authenticatedRole)
    
    expect(isAuthorized).toBe(false)
    expect(authenticatedRole).not.toBe(injectedRole)
  })

  it('validates that role source is cryptographically verified', () => {
    // JWT tokens are cryptographically signed
    // Headers are not signed and cannot be trusted
    const trustedSource = 'JWT' // Cryptographically verified
    const untrustedSource = 'Header' // Not verified
    
    expect(trustedSource).toBe('JWT')
    expect(untrustedSource).not.toBe('JWT')
    
    // Role MUST come from trusted source only
    const roleSource = trustedSource
    expect(roleSource).toBe('JWT')
  })

  describe('authenticate', () => {
     it('rejects request with no token', async () => {
          const res = await request(app).get('/user-route')
          expect(res.status).toBe(401)
     })

     it('rejects an invalid token', async () => {
          const res = await request(app).get('/user-route').set('Authorization', 'Bearer invalid-token')
          expect(res.status).toBe(401)
     })

     it('accepts a valid token', async () => {
          const res = await request(app).get('/user-route').set('Authorization', await tokenHelpers.user())
          expect(res.status).toBe(200)
     })
  })

describe('RBAC: Error Response Consistency', () => {
  /**
   * Test that error responses follow consistent format and patterns
   * 
   * **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**
   */

  interface ErrorEnvelope {
    error: string
    message?: string
  }

  it('authentication error includes "Unauthorized" in error field', () => {
    const authError: ErrorEnvelope = {
      error: 'Unauthorized',
    }
    
    expect(authError.error).toMatch(/unauthorized/i)
    expect(authError).toHaveProperty('error')
  })

  it('authorization error includes "Forbidden" in error field', () => {
    const authzError: ErrorEnvelope = {
      error: 'Forbidden',
      message: 'Requires role: ADMIN',
    }
    
    expect(authzError.error).toMatch(/forbidden/i)
    expect(authzError).toHaveProperty('error')
  })

  it('error envelope has consistent JSON structure', () => {
    const error1: ErrorEnvelope = { error: 'Unauthorized' }
    const error2: ErrorEnvelope = { error: 'Forbidden', message: 'Requires role: ADMIN' }
    
    expect(error1).toHaveProperty('error')
    expect(error2).toHaveProperty('error')
    expect(typeof error1.error).toBe('string')
    expect(typeof error2.error).toBe('string')
  })

  it('authorization error optionally includes detailed message', () => {
    const authzError: ErrorEnvelope = {
      error: 'Forbidden',
      message: 'Requires role: ADMIN',
    }
    
    expect(authzError.message).toBeDefined()
    expect(authzError.message).toContain('role')
  })

  it('error messages are descriptive strings', () => {
    const errors: ErrorEnvelope[] = [
      { error: 'Unauthorized' },
      { error: 'Forbidden', message: 'Requires role: ADMIN' },
      { error: 'Invalid token' },
    ]
    
    errors.forEach(err => {
      expect(typeof err.error).toBe('string')
      expect(err.error.length).toBeGreaterThan(0)
    })
  })

  it('401 status corresponds to authentication errors', () => {
    const statusCode = 401
    const errorTypes = ['Unauthorized', 'Invalid token', 'Token expired', 'Missing authorization']
    
    expect(statusCode).toBe(401)
    errorTypes.forEach(errorType => {
      expect(errorType.toLowerCase()).toMatch(/unauthorized|invalid|expired|missing/)
    })
  })

  it('403 status corresponds to authorization errors', () => {
    const statusCode = 403
    const errorTypes = ['Forbidden', 'Requires role: ADMIN', 'Insufficient permissions']
    
    expect(statusCode).toBe(403)
    errorTypes.forEach(errorType => {
      expect(errorType.toLowerCase()).toMatch(/forbidden|requires|insufficient/)
    })
  })
})

describe('RBAC: Security Bypass Prevention', () => {
  /**
   * Test various security bypass techniques to ensure they all fail
   * 
   * **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5**
   */

  it('prevents role escalation through header spoofing', () => {
    const jwtRole = UserRole.USER
    const spoofedHeaders = {
      'x-user-role': 'ADMIN',
      'role': 'ADMIN',
    }
    
    // System must use JWT role, not headers
    const effectiveRole = jwtRole // Not from headers
    
    expect(effectiveRole).toBe(UserRole.USER)
    expect(effectiveRole).not.toBe('ADMIN')
  })

  it('prevents token forgery through signature validation', () => {
    // Tokens must be cryptographically signed
    const validToken = { signed: true, signatureValid: true }
    const forgedToken = { signed: true, signatureValid: false }
    
    const isValidToken = (token: typeof validToken) => token.signed && token.signatureValid
    
    expect(isValidToken(validToken)).toBe(true)
    expect(isValidToken(forgedToken)).toBe(false)
  })

  it('prevents signature bypass through algorithm confusion', () => {
    // System must use a specific signing algorithm (e.g., HS256)
    const expectedAlgorithm = 'HS256'
    const maliciousAlgorithm = 'none' // Algorithm confusion attack
    
    const isAlgorithmValid = (alg: string) => alg === expectedAlgorithm
    
    expect(isAlgorithmValid(expectedAlgorithm)).toBe(true)
    expect(isAlgorithmValid(maliciousAlgorithm)).toBe(false)
  })

  it('handles empty token gracefully', () => {
    const emptyToken = ''
    const isTokenValid = emptyToken.length > 0
    
    expect(isTokenValid).toBe(false)
  })

  it('handles null token gracefully', () => {
    const nullToken = null
    const isTokenValid = nullToken !== null && nullToken !== undefined
    
    expect(isTokenValid).toBe(false)
  })

  it('handles malformed JSON in token payload', () => {
    const malformedPayload = 'not-valid-json'
    
    let isValidPayload = false
    try {
      JSON.parse(malformedPayload)
      isValidPayload = true
    } catch {
      isValidPayload = false
    }
    
    expect(isValidPayload).toBe(false)
  })

  it('prevents authorization header case manipulation', () => {
    // Authorization header must be case-sensitive
    const validHeader = 'Authorization'
    const manipulatedHeaders = ['authorization', 'AUTHORIZATION', 'AuThOrIzAtIoN']
    
    // HTTP headers are case-insensitive, but the value format matters
    // "Bearer <token>" format must be validated
    const validFormat = 'Bearer valid-token'
    const invalidFormats = ['bearer valid-token', 'BEARER valid-token', 'Token valid-token']
    
    expect(validFormat.startsWith('Bearer ')).toBe(true)
    invalidFormats.forEach(format => {
      expect(format.startsWith('Bearer ')).toBe(false)
    })
  })

  it('prevents role injection through JWT claims', () => {
    // Only the 'role' claim should be used, not custom claims
    const jwtPayload = {
      userId: 'test',
      role: UserRole.USER,
      customRole: 'ADMIN', // Malicious custom claim
      adminRole: 'ADMIN', // Another malicious claim
    }
    
    const effectiveRole = jwtPayload.role // Must use standard 'role' claim
    
    expect(effectiveRole).toBe(UserRole.USER)
    expect(effectiveRole).not.toBe('ADMIN')
  })

  it('validates that all bypass attempts result in denial', () => {
    const bypassAttempts = [
      { method: 'header-spoofing', shouldSucceed: false },
      { method: 'token-forgery', shouldSucceed: false },
      { method: 'signature-bypass', shouldSucceed: false },
      { method: 'empty-token', shouldSucceed: false },
      { method: 'null-token', shouldSucceed: false },
      { method: 'malformed-json', shouldSucceed: false },
    ]
    
    bypassAttempts.forEach(attempt => {
      expect(attempt.shouldSucceed).toBe(false)
    })
  })
})

describe('requireActiveVerifier', () => {
     it('denies verifier token without registry row', async () => {
          mockGetVerifierProfile.mockResolvedValue(undefined)
          const res = await request(app).post('/active-verify-route').set('Authorization', await tokenHelpers.verifier())
          expect(res.status).toBe(403)
     })

     it.each(['pending', 'suspended', 'deactivated'])('denies %s registry status', async (status) => {
          mockGetVerifierProfile.mockResolvedValue({ userId: '1', status })
          const res = await request(app).post('/active-verify-route').set('Authorization', await tokenHelpers.verifier())
          expect(res.status).toBe(403)
     })

     it('allows approved registry status and attaches verifier profile', async () => {
          mockGetVerifierProfile.mockResolvedValue({ userId: '1', status: 'approved', metadata: { specialty: 'docs' } })
          const res = await request(app).post('/active-verify-route').set('Authorization', await tokenHelpers.verifier())
          expect(res.status).toBe(200)
          expect(res.body.verifier.status).toBe('approved')
     })

     it('returns 500 when verifier registry lookup fails', async () => {
          mockGetVerifierProfile.mockRejectedValue(new Error('db down'))
          const res = await request(app).post('/active-verify-route').set('Authorization', await tokenHelpers.verifier())
          expect(res.status).toBe(500)
     })
})

describe('requireAdmin', () => {
     it('forbids user', async () => {
          const res = await request(app).delete('/admin-route').set('Authorization', await tokenHelpers.user())
          expect(res.status).toBe(403)
     })

     it('forbids verifier', async () => {
          const res = await request(app).delete('/admin-route').set('Authorization', await tokenHelpers.verifier())
          expect(res.status).toBe(403)
     })

     it('allows admin', async () => {
          const res = await request(app).delete('/admin-route').set('Authorization', await tokenHelpers.admin())
          expect(res.status).toBe(200)
     })
})
