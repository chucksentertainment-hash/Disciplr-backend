import request from 'supertest'
import express from 'express'
import { beforeAll, describe, it, expect, jest } from '@jest/globals'

// Mock database and helpers
const mockDb = {
  insert: jest.fn<any>().mockReturnThis(),
  returning: jest.fn<any>().mockReturnThis(),
  where: jest.fn<any>().mockReturnThis(),
  first: jest.fn<any>().mockResolvedValue({}),
  select: jest.fn<any>().mockReturnThis(),
}

// Mock the services before they are imported by middlewares
jest.unstable_mockModule('../db/index.js', () => ({
  default: jest.fn<any>(() => mockDb),
}))

let mockRole: string | null = null

jest.unstable_mockModule('../models/organizations.js', () => ({
  getOrganization: jest.fn<any>((id: string) => ({ id, name: 'Test Org' })),
  getMemberRole: jest.fn<any>(() => mockRole),
}))

let requireOrgRole: any, requireTeamRole: any
const app = express()
app.use(express.json())

beforeAll(async () => {
    // We use dynamic imports to ensure mocks are applied
    const orgAuthModule = await import('../middleware/orgAuth.js')
    requireOrgRole = orgAuthModule.requireOrgRole
    requireTeamRole = orgAuthModule.requireTeamRole

    // Setup routes after middlewares are loaded
    app.get('/org/:orgId/admin', (req, res, next) => {
      (req as any).user = { userId: 'user-1', sub: 'user-1', role: 'user' }
      next()
    }, requireOrgRole(['admin']), (req, res) => res.json({ ok: true }))

    app.get('/team/:orgId/member', (req, res, next) => {
      (req as any).user = { userId: 'user-2', sub: 'user-2', role: 'user' }
      next()
    }, requireTeamRole(['member', 'lead']), (req, res) => res.json({ ok: true }))
})

describe('Enterprise Hierarchy & RBAC', () => {
  it('should allow access with correct organization role', async () => {
    mockRole = 'admin'
    
    const res = await request(app).get('/org/org-1/admin')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('should deny access with incorrect organization role', async () => {
    mockRole = 'member'
    
    const res = await request(app).get('/org/org-1/admin')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/requires role admin/)
  })

  it('should allow access with correct team role', async () => {
    mockRole = 'member'
    
    const res = await request(app).get('/team/team-1/member')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('should deny access with incorrect team role', async () => {
    mockRole = null
    
    const res = await request(app).get('/team/org-1/member')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not a member of this organization/)
  })
})

describe('Enterprise Guard & Exposure', () => {
  let enterpriseGuard: any
  const enterpriseApp = express()
  enterpriseApp.use(express.json())

  beforeAll(async () => {
    const guardModule = await import('../middleware/enterpriseGuard.js')
    enterpriseGuard = guardModule.enterpriseGuard

    enterpriseApp.get('/enterprise/data', (req, res, next) => {
      // Mock authenticated user
      (req as any).user = { 
        userId: 'user-1', 
        isEnterprise: (req.headers['x-is-enterprise'] === 'true'),
        enterpriseId: req.headers['x-enterprise-id']
      }
      next()
    }, enterpriseGuard, (req, res) => res.json({ ok: true }))
  })

  it('should allow access for verified enterprise users', async () => {
    const res = await request(enterpriseApp)
      .get('/enterprise/data')
      .set('x-is-enterprise', 'true')
      .set('x-enterprise-id', 'ent-123')
    
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('should deny access for non-enterprise users with 403', async () => {
    const res = await request(enterpriseApp)
      .get('/enterprise/data')
      .set('x-is-enterprise', 'false')
    
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Forbidden')
    expect(res.body.message).toMatch(/restricted to enterprise accounts/)
  })

  it('should deny access when enterpriseId is missing', async () => {
    const res = await request(enterpriseApp)
      .get('/enterprise/data')
      .set('x-is-enterprise', 'true')
      // missing x-enterprise-id
    
    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/Enterprise configuration missing/)
  })
})
