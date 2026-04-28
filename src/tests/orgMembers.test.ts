import request from 'supertest'
import express, { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import { UserRole } from '../types/user.js'
import { orgMembersRouter } from '../routes/orgMembers.js'
import { setOrganizations, setOrgMembers } from '../models/organizations.js'

jest.mock('../services/membership.js', () => {
  const actual = jest.requireActual<any>('../services/membership.js')
  return {
    ...actual,
    listOrgMemberships: jest.fn(async (orgId: string) => {
      const { getOrgMembers } = await import('../models/organizations.js')
      return getOrgMembers(orgId).map((member) => ({
        id: `${member.orgId}:${member.userId}`,
        user_id: member.userId,
        organization_id: member.orgId,
        team_id: null,
        role: member.role,
      }))
    }),
    createMembership: jest.fn(async (input: any) => ({
      id: `${input.organization_id}:${input.user_id}`,
      user_id: input.user_id,
      organization_id: input.organization_id,
      team_id: input.team_id ?? null,
      role: input.role ?? 'member',
    })),
    removeMembership: jest.fn(async () => undefined),
    updateMemberRole: jest.fn(async (userId: string, orgId: string, role: string) => ({
      id: `${orgId}:${userId}`,
      user_id: userId,
      organization_id: orgId,
      team_id: null,
      role,
    })),
  }
})

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

function mockAuthenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' })
    return
  }

  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET)
    req.user = payload as any
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

jest.mock('../middleware/auth.js', () => ({
  authenticate: mockAuthenticate,
}))

jest.mock('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn(),
}))

const app = express()
app.use(express.json())
app.use('/api/organizations', orgMembersRouter)

const ORG_ALPHA = 'org-alpha'
const ORG_BETA = 'org-beta'

const bearer = (sub: string, role: string = UserRole.USER) =>
  `Bearer ${jwt.sign({ sub, role }, JWT_SECRET, { expiresIn: '1h' })}`

beforeEach(() => {
  setOrganizations([
    { id: ORG_ALPHA, name: 'Alpha Corp', createdAt: '2025-01-01T00:00:00Z' },
    { id: ORG_BETA, name: 'Beta Inc', createdAt: '2025-02-01T00:00:00Z' },
  ])

  setOrgMembers([
    { orgId: ORG_ALPHA, userId: 'alice', role: 'owner' },
    { orgId: ORG_ALPHA, userId: 'bob', role: 'admin' },
    { orgId: ORG_ALPHA, userId: 'carol', role: 'member' },
    { orgId: ORG_BETA, userId: 'dave', role: 'owner' },
  ])
})

describe('Organization membership routes', () => {
  it('returns 401 when listing members without authentication', async () => {
    const res = await request(app).get(`/api/organizations/${ORG_ALPHA}/members`)

    expect(res.status).toBe(401)
  })

  it('allows an org member to list members in their own org', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/members`)
      .set('Authorization', bearer('carol'))

    expect(res.status).toBe(200)
    expect(res.body.members).toHaveLength(3)
    expect(res.body.members.every((m: any) => m.organization_id === ORG_ALPHA)).toBe(true)
  })

  it('prevents cross-org member enumeration', async () => {
    const res = await request(app)
      .get(`/api/organizations/${ORG_ALPHA}/members`)
      .set('Authorization', bearer('dave'))

    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/not a member/i)
  })

  it('forbids a regular member from adding members', async () => {
    const res = await request(app)
      .post(`/api/organizations/${ORG_ALPHA}/members`)
      .set('Authorization', bearer('carol'))
      .send({ userId: 'erin', role: 'member' })

    expect(res.status).toBe(403)
  })

  it('allows an org admin to add a member', async () => {
    const res = await request(app)
      .post(`/api/organizations/${ORG_ALPHA}/members`)
      .set('Authorization', bearer('bob'))
      .send({ userId: 'erin', role: 'member' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      orgId: ORG_ALPHA,
      userId: 'erin',
      role: 'member',
    })
  })

  it('defaults new member role to member when role is omitted', async () => {
    const res = await request(app)
      .post(`/api/organizations/${ORG_ALPHA}/members`)
      .set('Authorization', bearer('alice'))
      .send({ userId: 'erin' })

    expect(res.status).toBe(201)
    expect(res.body.role).toBe('member')
  })

  it('returns 400 when userId is missing while adding member', async () => {
    const res = await request(app)
      .post(`/api/organizations/${ORG_ALPHA}/members`)
      .set('Authorization', bearer('alice'))
      .send({ role: 'member' })

    expect(res.status).toBe(400)
  })

  it('forbids a regular member from removing members', async () => {
    const res = await request(app)
      .delete(`/api/organizations/${ORG_ALPHA}/members/bob`)
      .set('Authorization', bearer('carol'))

    expect(res.status).toBe(403)
  })

  it('allows an owner to remove a member', async () => {
    const res = await request(app)
      .delete(`/api/organizations/${ORG_ALPHA}/members/carol`)
      .set('Authorization', bearer('alice'))

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      message: 'Member removed.',
      orgId: ORG_ALPHA,
      userId: 'carol',
    })
  })

  it('forbids non-owner from updating member role', async () => {
    const res = await request(app)
      .patch(`/api/organizations/${ORG_ALPHA}/members/carol/role`)
      .set('Authorization', bearer('bob'))
      .send({ role: 'admin' })

    expect(res.status).toBe(403)
  })

  it('allows owner to update member role', async () => {
    const res = await request(app)
      .patch(`/api/organizations/${ORG_ALPHA}/members/carol/role`)
      .set('Authorization', bearer('alice'))
      .send({ role: 'admin' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      orgId: ORG_ALPHA,
      userId: 'carol',
      role: 'admin',
    })
  })

  it('returns 400 for invalid role update', async () => {
    const res = await request(app)
      .patch(`/api/organizations/${ORG_ALPHA}/members/carol/role`)
      .set('Authorization', bearer('alice'))
      .send({ role: 'superadmin' })

    expect(res.status).toBe(400)
  })
})