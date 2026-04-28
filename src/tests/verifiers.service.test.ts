import { jest } from '@jest/globals'
import { clearAuditLogs, listAuditLogs } from '../lib/audit-logs.js'

type VerifierRow = {
  user_id: string
  display_name: string | null
  metadata: Record<string, unknown> | null
  status: string
  created_at: Date
  approved_at: Date | null
  suspended_at: Date | null
  deactivated_at: Date | null
}

type VerificationRow = {
  id: string
  verifier_user_id: string
  target_id: string
  result: 'approved' | 'rejected'
  disputed: boolean
  timestamp: Date
}

const verifiers = new Map<string, VerifierRow>()
const verifications: VerificationRow[] = []

function makeDb() {
  const db: any = (tableName: string) => makeQuery(tableName)
  db.fn = { now: () => new Date('2026-04-25T00:00:00.000Z') }
  db.transaction = async (callback: (trx: any) => unknown) => {
    const snapshot = new Map(verifiers)
    try {
      return await callback(db)
    } catch (error) {
      verifiers.clear()
      for (const [key, value] of snapshot.entries()) {
        verifiers.set(key, value)
      }
      throw error
    }
  }
  return db
}

function makeQuery(tableName: string) {
  let whereClause: Record<string, unknown> = {}
  let insertPayload: any
  let updatePayload: any
  let countMode = false

  const query: any = {
    insert(payload: any) {
      insertPayload = payload
      return query
    },
    where(payload: Record<string, unknown>) {
      whereClause = payload
      return query
    },
    update(payload: any) {
      updatePayload = payload
      return query
    },
    select() {
      return query
    },
    count() {
      countMode = true
      return query
    },
    async orderBy() {
      if (tableName === 'verifiers') {
        return [...verifiers.values()]
      }
      if (tableName === 'verifications') {
        return [...verifications]
      }
      return []
    },
    async first() {
      if (countMode) {
        return { count: String(filterRows(tableName, whereClause).length) }
      }
      if (tableName !== 'verifiers') return undefined
      return verifiers.get(String(whereClause.user_id))
    },
    async del() {
      if (tableName === 'verifications') {
        const before = verifications.length
        if (Object.keys(whereClause).length === 0) {
          verifications.length = 0
        } else {
          for (let index = verifications.length - 1; index >= 0; index -= 1) {
            if (matchesWhere(verifications[index], whereClause)) {
              verifications.splice(index, 1)
            }
          }
        }
        return before - verifications.length
      }
      if (tableName !== 'verifiers') return 0
      if (Object.keys(whereClause).length === 0) {
        const count = verifiers.size
        verifiers.clear()
        return count
      }
      return verifiers.delete(String(whereClause.user_id)) ? 1 : 0
    },
    async returning() {
      if (tableName === 'verifications') {
        const row: VerificationRow = {
          id: `verification-${verifications.length + 1}`,
          verifier_user_id: insertPayload.verifier_user_id,
          target_id: insertPayload.target_id,
          result: insertPayload.result,
          disputed: insertPayload.disputed ?? false,
          timestamp: new Date('2026-04-25T00:00:00.000Z'),
        }
        verifications.push(row)
        return [row]
      }
      if (tableName !== 'verifiers') return []
      if (insertPayload) {
        const row: VerifierRow = {
          user_id: insertPayload.user_id,
          display_name: insertPayload.display_name ?? null,
          metadata: insertPayload.metadata ?? null,
          status: insertPayload.status,
          created_at: new Date('2026-04-25T00:00:00.000Z'),
          approved_at: insertPayload.approved_at ?? null,
          suspended_at: insertPayload.suspended_at ?? null,
          deactivated_at: insertPayload.deactivated_at ?? null,
        }
        verifiers.set(row.user_id, row)
        return [row]
      }

      const row = verifiers.get(String(whereClause.user_id))
      if (!row) return []
      Object.assign(row, updatePayload)
      return [row]
    },
  }

  return query
}

function filterRows(tableName: string, whereClause: Record<string, unknown>): any[] {
  if (tableName === 'verifiers') {
    return [...verifiers.values()].filter((row) => matchesWhere(row, whereClause))
  }
  if (tableName === 'verifications') {
    return verifications.filter((row) => matchesWhere(row, whereClause))
  }
  return []
}

function matchesWhere(row: Record<string, unknown>, whereClause: Record<string, unknown>): boolean {
  return Object.entries(whereClause).every(([key, value]) => row[key] === value)
}

jest.unstable_mockModule('../db/knex.js', () => ({
  db: makeDb(),
}))

const {
  InvalidVerifierStatusTransitionError,
  canTransition,
  createOrGetVerifierProfile,
  createVerifierProfile,
  deleteVerifierProfile,
  getVerifierProfile,
  getVerifierStats,
  listVerifierProfiles,
  listVerifications,
  recordVerification,
  resetVerifiers,
  transitionVerifier,
  updateVerifierProfile,
} = await import('../services/verifiers.js')

describe('verifier service lifecycle and audit behavior', () => {
  beforeEach(() => {
    verifiers.clear()
    verifications.length = 0
    clearAuditLogs()
  })

  test('defines explicit verifier status transitions', () => {
    expect(canTransition('pending', 'approved')).toBe(true)
    expect(canTransition('approved', 'suspended')).toBe(true)
    expect(canTransition('suspended', 'approved')).toBe(true)
    expect(canTransition('suspended', 'deactivated')).toBe(true)
    expect(canTransition('deactivated', 'pending')).toBe(true)
    expect(canTransition('deactivated', 'approved')).toBe(false)
    expect(canTransition('pending', 'suspended')).toBe(false)
  })

  test('creates audit records for verifier creation and status changes', async () => {
    const created = await createVerifierProfile('verifier-1', { displayName: 'Verifier One' }, { actorUserId: 'admin-1' })
    expect(created.after.status).toBe('pending')
    expect(created.auditLog?.action).toBe('verifier.created')

    const approved = await transitionVerifier('verifier-1', 'approved', { actorUserId: 'admin-1', reason: 'qualified' })
    expect(approved?.after.status).toBe('approved')
    expect(approved?.auditLog?.action).toBe('verifier.approved')
    expect(approved?.auditLog?.target_id).toBe('verifier-1')

    const logs = listAuditLogs({ target_type: 'verifier', target_id: 'verifier-1' })
    expect(logs).toHaveLength(2)
    expect(logs[0].metadata).toHaveProperty('reason', 'qualified')

    const suspended = await transitionVerifier('verifier-1', 'suspended', { actorUserId: 'admin-1' })
    expect(suspended?.auditLog?.action).toBe('verifier.suspended')

    const deactivated = await transitionVerifier('verifier-1', 'deactivated', { actorUserId: 'admin-1' })
    expect(deactivated?.auditLog?.action).toBe('verifier.deactivated')

    const reactivated = await transitionVerifier('verifier-1', 'pending', { actorUserId: 'admin-1' })
    expect(reactivated?.auditLog?.action).toBe('verifier.reactivated')
  })

  test('blocks invalid status transitions', async () => {
    await createVerifierProfile('verifier-2', { status: 'deactivated' }, { actorUserId: 'admin-1' })

    await expect(transitionVerifier('verifier-2', 'approved', { actorUserId: 'admin-1' }))
      .rejects.toBeInstanceOf(InvalidVerifierStatusTransitionError)
  })

  test('skips audit records for no-op updates', async () => {
    await createVerifierProfile('verifier-3', { displayName: 'Same' }, { actorUserId: 'admin-1' })
    clearAuditLogs()

    const result = await updateVerifierProfile('verifier-3', { displayName: 'Same' }, { actorUserId: 'admin-1' })
    expect(result?.changedFields).toEqual([])
    expect(result?.auditLog).toBeNull()
    expect(listAuditLogs({ target_type: 'verifier', target_id: 'verifier-3' })).toEqual([])
  })

  test('createOrGet returns existing rows and audits missing-row creation', async () => {
    const created = await createOrGetVerifierProfile('verifier-4', { displayName: 'New' }, { actorUserId: 'admin-1' })
    expect(created.userId).toBe('verifier-4')
    expect(listAuditLogs({ target_type: 'verifier', target_id: 'verifier-4' })).toHaveLength(1)

    clearAuditLogs()
    const existing = await createOrGetVerifierProfile('verifier-4', undefined, { actorUserId: 'admin-1' })
    expect(existing.userId).toBe('verifier-4')
    expect(listAuditLogs({ target_type: 'verifier', target_id: 'verifier-4' })).toEqual([])
  })

  test('deleteVerifierProfile audits deletes and handles missing rows', async () => {
    await createVerifierProfile('verifier-5', undefined, { actorUserId: 'admin-1' })
    clearAuditLogs()

    const deleted = await deleteVerifierProfile('verifier-5', { actorUserId: 'admin-1' })
    expect(deleted.deleted).toBe(true)
    expect(deleted.auditLog?.action).toBe('verifier.deleted')

    const missing = await deleteVerifierProfile('verifier-5', { actorUserId: 'admin-1' })
    expect(missing.deleted).toBe(false)
    expect(missing.auditLog).toBeNull()
  })

  test('maps verifier reads, lists, verification records, stats, and resets', async () => {
    await createVerifierProfile('verifier-7', { status: 'approved', metadata: { region: 'west' } }, { actorUserId: 'admin-1' })

    const profile = await getVerifierProfile('verifier-7')
    expect(profile?.metadata).toEqual({ region: 'west' })

    const missing = await getVerifierProfile('missing')
    expect(missing).toBeUndefined()

    const profiles = await listVerifierProfiles()
    expect(profiles.map((item) => item.userId)).toContain('verifier-7')

    const approved = await recordVerification('verifier-7', 'target-1', 'approved')
    const rejected = await recordVerification('verifier-7', 'target-2', 'rejected', true)
    expect(approved.verifierUserId).toBe('verifier-7')
    expect(rejected.disputed).toBe(true)

    const records = await listVerifications()
    expect(records).toHaveLength(2)

    const stats = await getVerifierStats('verifier-7')
    expect(stats).toMatchObject({
      totalVerifications: 2,
      approvals: 1,
      rejections: 1,
      disputes: 1,
      approvalRatio: 0.5,
      rejectionRatio: 0.5,
      disputeRate: 0.5,
    })

    await resetVerifiers()
    expect(verifiers.size).toBe(0)
    expect(verifications).toHaveLength(0)
  })

  test('rolls back verifier creation when audit creation fails', async () => {
    await expect(createVerifierProfile('verifier-6', undefined, { actorUserId: '' }))
      .rejects.toThrow('Invalid audit log entry')

    expect(verifiers.has('verifier-6')).toBe(false)
    expect(listAuditLogs({ target_type: 'verifier', target_id: 'verifier-6' })).toEqual([])
  })
})
