import { Response, NextFunction } from 'express'
import type { AuthenticatedRequest } from './auth.js'
import { getUserOrganizationRole } from '../services/membership.js'
import { getOrgMembers } from '../models/organizations.js'

export function requireOrgAccess(...allowedRoles: string[]) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const orgId = req.params.orgId || (req.query.orgId as string)
    const userId = req.user?.userId || (req.user as any)?.sub

    if (!orgId || !userId) {
      res.status(401).json({ error: 'Auth/Org info missing' })
      return
    }

    let role: string | null = null

    // STEP 1: Try DB
    try {
      role = await getUserOrganizationRole(userId, orgId)
    } catch {
      // ignore DB failure
    }

    // STEP 2: fallback
    const members = getOrgMembers(orgId)

    // 🚨 KEY FIX (404 handling)
    if (!members || members.length === 0) {
      res.status(404).json({ error: 'organization not found' })
      return
    }

    const member = members.find((m) => m.userId === userId)
    role = role || member?.role || null

    // STEP 3: access checks
    if (!role) {
      res.status(403).json({ error: 'not a member' })
      return
    }

    if (!allowedRoles.includes(role)) {
      res.status(403).json({
        error: `requires role ${allowedRoles.join(' or ')}`,
      })
      return
    }

    next()
  }
}