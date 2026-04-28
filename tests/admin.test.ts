import request from 'supertest'
import { app } from '../src/app.js'
import { db } from '../src/db/index.js'
import { UserRole, UserStatus } from '../src/types/user.js'
import { generateAccessToken } from '../src/lib/auth-utils.js'
import { clearProcessedOverrides, ValidOverrideReasonCodes } from '../src/routes/admin.js'
import { clearAuditLogs } from '../src/lib/audit-logs.js'

describe('Admin User Management API', () => {
  let adminToken: string
  let userToken: string
  let verifierToken: string
  let testUsers: any[] = []

  beforeAll(async () => {
    // Clean up any existing test data
    await db('users').where('email', 'like', '%test%').del()

    // Create test users
    const adminUser = {
      id: 'admin-test-id',
      email: 'admin-test@example.com',
      passwordHash: 'hashed-password',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    const regularUser = {
      id: 'user-test-id',
      email: 'user-test@example.com',
      passwordHash: 'hashed-password',
      role: UserRole.USER,
      status: UserStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    const verifierUser = {
      id: 'verifier-test-id',
      email: 'verifier-test@example.com',
      passwordHash: 'hashed-password',
      role: UserRole.VERIFIER,
      status: UserStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    await db('users').insert([adminUser, regularUser, verifierUser])
    testUsers = [adminUser, regularUser, verifierUser]

    // Generate JWT tokens
    adminToken = generateAccessToken({ userId: adminUser.id, role: UserRole.ADMIN })
    userToken = generateAccessToken({ userId: regularUser.id, role: UserRole.USER })
    verifierToken = generateAccessToken({ userId: verifierUser.id, role: UserRole.VERIFIER })
  })

  afterAll(async () => {
    // Clean up test data
    await db('users').where('email', 'like', '%test%').del()
    await db.destroy()
  })

  describe('Authentication & Authorization', () => {
    test('should deny access without authentication', async () => {
      const response = await request(app)
        .get('/api/admin/users')
        .expect(401)

      expect(response.body).toHaveProperty('error', 'Unauthorized: Missing or invalid token')
    })

    test('should deny access to non-admin users', async () => {
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403)

      expect(response.body).toHaveProperty('error', 'Forbidden: Insufficient permissions')
    })

    test('should deny access to verifier users', async () => {
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${verifierToken}`)
        .expect(403)

      expect(response.body).toHaveProperty('error', 'Forbidden: Insufficient permissions')
    })

    test('should allow access to admin users', async () => {
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body).toHaveProperty('data')
      expect(response.body).toHaveProperty('pagination')
    })
  })

  describe('GET /api/admin/users', () => {
    test('should return paginated users list', async () => {
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body).toHaveProperty('data')
      expect(response.body).toHaveProperty('pagination')
      expect(response.body.pagination).toHaveProperty('limit')
      expect(response.body.pagination).toHaveProperty('offset')
      expect(response.body.pagination).toHaveProperty('total')
      expect(response.body.pagination).toHaveProperty('hasMore')
      expect(Array.isArray(response.body.data)).toBe(true)
    })

    test('should filter users by role', async () => {
      const response = await request(app)
        .get('/api/admin/users?role=USER')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body.data.every((user: any) => user.role === 'USER')).toBe(true)
    })

    test('should filter users by status', async () => {
      const response = await request(app)
        .get('/api/admin/users?status=ACTIVE')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body.data.every((user: any) => user.status === 'ACTIVE')).toBe(true)
    })

    test('should search users by email', async () => {
      const response = await request(app)
        .get('/api/admin/users?search=admin-test')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body.data.some((user: any) => user.email.includes('admin-test'))).toBe(true)
    })

    test('should reject invalid role filter', async () => {
      const response = await request(app)
        .get('/api/admin/users?role=INVALID')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400)

      expect(response.body).toHaveProperty('error', 'Invalid role value')
    })

    test('should reject invalid status filter', async () => {
      const response = await request(app)
        .get('/api/admin/users?status=INVALID')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400)

      expect(response.body).toHaveProperty('error', 'Invalid status value')
    })

    test('should respect pagination limits', async () => {
      const response = await request(app)
        .get('/api/admin/users?limit=1&offset=0')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body.data).toHaveLength(1)
      expect(response.body.pagination.limit).toBe(1)
      expect(response.body.pagination.offset).toBe(0)
    })
  })

  describe('PATCH /api/admin/users/:id/role', () => {
    test('should update user role successfully', async () => {
      const targetUserId = testUsers[1].id // regular user
      const response = await request(app)
        .patch(`/api/admin/users/${targetUserId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: UserRole.VERIFIER })
        .expect(200)

      expect(response.body).toHaveProperty('user')
      expect(response.body).toHaveProperty('auditLogId')
      expect(response.body.user.role).toBe(UserRole.VERIFIER)
    })

    test('should create audit log for role update', async () => {
      const targetUserId = testUsers[1].id
      await request(app)
        .patch(`/api/admin/users/${targetUserId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: UserRole.USER })
        .expect(200)

      // Check audit log was created
      const auditResponse = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      const roleUpdateLog = auditResponse.body.audit_logs.find((log: any) => 
        log.action === 'user.role.update' && 
        log.target_id === targetUserId
      )

      expect(roleUpdateLog).toBeDefined()
      expect(roleUpdateLog.metadata).toHaveProperty('old_role')
      expect(roleUpdateLog.metadata).toHaveProperty('new_role')
      expect(roleUpdateLog.metadata).toHaveProperty('admin_id')
    })

    test('should reject invalid role', async () => {
      const targetUserId = testUsers[1].id
      const response = await request(app)
        .patch(`/api/admin/users/${targetUserId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'INVALID_ROLE' })
        .expect(400)

      expect(response.body).toHaveProperty('error', 'Invalid role. Must be one of: USER, VERIFIER, ADMIN')
    })

    test('should return 404 for non-existent user', async () => {
      const response = await request(app)
        .patch('/api/admin/users/non-existent-id/role')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: UserRole.VERIFIER })
        .expect(404)

      expect(response.body).toHaveProperty('error', 'User not found')
    })

    test('should reject role update to same role', async () => {
      const targetUserId = testUsers[1].id
      const response = await request(app)
        .patch(`/api/admin/users/${targetUserId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: UserRole.USER })
        .expect(400)

      expect(response.body).toHaveProperty('error', 'User already has this role')
    })
  })

  describe('PATCH /api/admin/users/:id/status', () => {
    test('should update user status successfully', async () => {
      const targetUserId = testUsers[1].id
      const response = await request(app)
        .patch(`/api/admin/users/${targetUserId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: UserStatus.SUSPENDED })
        .expect(200)

      expect(response.body).toHaveProperty('user')
      expect(response.body).toHaveProperty('auditLogId')
      expect(response.body.user.status).toBe(UserStatus.SUSPENDED)
    })

    test('should create audit log for status update', async () => {
      const targetUserId = testUsers[1].id
      await request(app)
        .patch(`/api/admin/users/${targetUserId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: UserStatus.ACTIVE })
        .expect(200)

      // Check audit log was created
      const auditResponse = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      const statusUpdateLog = auditResponse.body.audit_logs.find((log: any) => 
        log.action === 'user.status.update' && 
        log.target_id === targetUserId
      )

      expect(statusUpdateLog).toBeDefined()
      expect(statusUpdateLog.metadata).toHaveProperty('old_status')
      expect(statusUpdateLog.metadata).toHaveProperty('new_status')
      expect(statusUpdateLog.metadata).toHaveProperty('admin_id')
    })

    test('should reject invalid status', async () => {
      const targetUserId = testUsers[1].id
      const response = await request(app)
        .patch(`/api/admin/users/${targetUserId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'INVALID_STATUS' })
        .expect(400)

      expect(response.body).toHaveProperty('error', 'Invalid status. Must be one of: ACTIVE, INACTIVE, SUSPENDED')
    })

    test('should return 404 for non-existent user', async () => {
      const response = await request(app)
        .patch('/api/admin/users/non-existent-id/status')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: UserStatus.SUSPENDED })
        .expect(404)

      expect(response.body).toHaveProperty('error', 'User not found')
    })

    test('should reject status update to same status', async () => {
      const targetUserId = testUsers[1].id
      const response = await request(app)
        .patch(`/api/admin/users/${targetUserId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: UserStatus.ACTIVE })
        .expect(400)

      expect(response.body).toHaveProperty('error', 'User already has this status')
    })
  })

  describe('Audit Logs Integration', () => {
    test('should include user management actions in audit logs', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      const userActions = response.body.audit_logs.filter((log: any) => 
        log.action === 'user.role.update' || log.action === 'user.status.update'
      )

      expect(userActions.length).toBeGreaterThan(0)
    })

    test('should filter audit logs by action', async () => {
      const response = await request(app)
        .get('/api/admin/audit-logs?action=user.role.update')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body.audit_logs.every((log: any) => log.action === 'user.role.update')).toBe(true)
    })

    test('should normalize metadata keys and include admin_id', async () => {
      const targetUserId = testUsers[1].id

      await request(app)
        .patch(`/api/admin/users/${targetUserId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: UserRole.VERIFIER })
        .expect(200)

      const response = await request(app)
        .get('/api/admin/audit-logs?action=user.role.update')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      const auditLog = response.body.audit_logs.find((log: any) => log.target_id === targetUserId)
      expect(auditLog).toBeDefined()
      expect(auditLog.metadata).toHaveProperty('admin_id', testUsers[0].id)
      expect(auditLog.metadata).toHaveProperty('old_role')
      expect(auditLog.metadata).toHaveProperty('new_role')
      expect(auditLog.metadata).not.toHaveProperty('oldRole')
    })

    test('should strip sensitive data from metadata', async () => {
      const loginResponse = await request(app)
        .post('/api/auth/login')
        .send({ userId: 'sensitive-audit-user' })
        .expect(200)

      const createdAuditLogId = loginResponse.body.auditLogId

      const detailResponse = await request(app)
        .get(`/api/admin/audit-logs/${createdAuditLogId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(detailResponse.body.metadata).toHaveProperty('user_agent')
      expect(detailResponse.body.metadata).not.toHaveProperty('ip')
      expect(detailResponse.body.metadata).not.toHaveProperty('email')
      expect(detailResponse.body.metadata).not.toHaveProperty('token')
    })
  })

  describe('DELETE /api/admin/users/:id (Soft Delete)', () => {
    let deleteTargetUser: any

    beforeAll(async () => {
      deleteTargetUser = {
        id: 'delete-target-test-id',
        email: 'delete-target-test@example.com',
        passwordHash: 'hashed-password',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date()
      }
      await db('users').insert(deleteTargetUser)
    })

    afterAll(async () => {
      await db('users').where('id', deleteTargetUser.id).del()
    })

    test('should soft-delete user successfully', async () => {
      const response = await request(app)
        .delete(`/api/admin/users/${deleteTargetUser.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body).toHaveProperty('message', 'User soft-deleted')
      expect(response.body).toHaveProperty('result')
      expect(response.body.result.deletionType).toBe('soft')
      expect(response.body.result.deletedAt).toBeDefined()
      expect(response.body).toHaveProperty('auditLogId')
    })

    test('should return 409 when soft-deleting already deleted user', async () => {
      const response = await request(app)
        .delete(`/api/admin/users/${deleteTargetUser.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409)

      expect(response.body).toHaveProperty('error', 'User is already deleted')
      expect(response.body).toHaveProperty('deletedAt')
    })

    test('should return 404 for non-existent user', async () => {
      const response = await request(app)
        .delete('/api/admin/users/non-existent-id')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404)

      expect(response.body).toHaveProperty('error', 'User not found')
    })

    test('should prevent admin from deleting own account', async () => {
      const response = await request(app)
        .delete(`/api/admin/users/${testUsers[0].id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400)

      expect(response.body).toHaveProperty('error', 'Cannot delete your own account')
    })

    test('should exclude soft-deleted users from list by default', async () => {
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      const deletedUser = response.body.data.find((u: any) => u.id === deleteTargetUser.id)
      expect(deletedUser).toBeUndefined()
    })

    test('should include soft-deleted users when includeDeleted is true', async () => {
      const response = await request(app)
        .get('/api/admin/users?includeDeleted=true')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      const deletedUser = response.body.data.find((u: any) => u.id === deleteTargetUser.id)
      expect(deletedUser).toBeDefined()
      expect(deletedUser.deletedAt).toBeDefined()
    })
  })

  describe('POST /api/admin/users/:id/restore', () => {
    let restoreTargetUser: any

    beforeAll(async () => {
      restoreTargetUser = {
        id: 'restore-target-test-id',
        email: 'restore-target-test@example.com',
        passwordHash: 'hashed-password',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        deleted_at: new Date()
      }
      await db('users').insert(restoreTargetUser)
    })

    afterAll(async () => {
      await db('users').where('id', restoreTargetUser.id).del()
    })

    test('should restore soft-deleted user successfully', async () => {
      const response = await request(app)
        .post(`/api/admin/users/${restoreTargetUser.id}/restore`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body).toHaveProperty('message', 'User restored')
      expect(response.body).toHaveProperty('user')
      expect(response.body.user.deletedAt).toBeUndefined()
      expect(response.body).toHaveProperty('auditLogId')
    })

    test('should return 400 when restoring non-deleted user', async () => {
      const response = await request(app)
        .post(`/api/admin/users/${restoreTargetUser.id}/restore`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400)

      expect(response.body).toHaveProperty('error', 'User is not deleted')
    })

    test('should return 404 for non-existent user', async () => {
      const response = await request(app)
        .post('/api/admin/users/non-existent-id/restore')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404)

      expect(response.body).toHaveProperty('error', 'User not found')
    })
  })

  describe('DELETE /api/admin/users/:id?hard=true (Hard Delete)', () => {
    let hardDeleteTargetUser: any

    beforeEach(async () => {
      hardDeleteTargetUser = {
        id: 'hard-delete-target-test-id',
        email: 'hard-delete-target-test@example.com',
        passwordHash: 'hashed-password',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date()
      }
      await db('users').where('id', hardDeleteTargetUser.id).del()
      await db('users').insert(hardDeleteTargetUser)
    })

    afterEach(async () => {
      if (hardDeleteTargetUser?.id) {
        await db('users').where('id', hardDeleteTargetUser.id).del()
      }
    })

    test('should hard-delete user permanently', async () => {
      const response = await request(app)
        .delete(`/api/admin/users/${hardDeleteTargetUser.id}?hard=true`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body).toHaveProperty('message', 'User permanently deleted')
      expect(response.body).toHaveProperty('result')
      expect(response.body.result.deletionType).toBe('hard')
      expect(response.body).toHaveProperty('auditLogId')

      const userCheck = await db('users').where('id', hardDeleteTargetUser.id).first()
      expect(userCheck).toBeUndefined()
    })

    test('should return 404 for non-existent user on hard delete', async () => {
      const response = await request(app)
        .delete('/api/admin/users/non-existent-id?hard=true')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404)

      expect(response.body).toHaveProperty('error', 'User not found')
    })

    test('should create audit log for hard delete', async () => {
      await request(app)
        .delete(`/api/admin/users/${hardDeleteTargetUser.id}?hard=true`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      const auditResponse = await request(app)
        .get('/api/admin/audit-logs?action=user.hard_delete')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      const hardDeleteLog = auditResponse.body.audit_logs.find((log: any) =>
        log.action === 'user.hard_delete' &&
        log.target_id === hardDeleteTargetUser.id
      )

      expect(hardDeleteLog).toBeDefined()
      expect(hardDeleteLog.metadata).toHaveProperty('deletion_type', 'hard')
    })
  })
})

describe('Admin Override Endpoints', () => {
  let adminToken: string
  let userToken: string
  let testAdminId: string
  let testVaultId: string

  beforeAll(async () => {
    // Clean up and create test data
    await db('users').where('email', 'like', '%override-test%').del()

    const adminUser = {
      id: 'admin-override-test-id',
      email: 'admin-override-test@example.com',
      passwordHash: 'hashed-password',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    const regularUser = {
      id: 'user-override-test-id',
      email: 'user-override-test@example.com',
      passwordHash: 'hashed-password',
      role: UserRole.USER,
      status: UserStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    await db('users').insert([adminUser, regularUser])
    testAdminId = adminUser.id

    adminToken = generateAccessToken({ userId: adminUser.id, role: UserRole.ADMIN })
    userToken = generateAccessToken({ userId: regularUser.id, role: UserRole.USER })
  })

  beforeEach(async () => {
    // Clear idempotency cache and audit logs before each test
    clearProcessedOverrides()
    clearAuditLogs()

    // Create a test vault for each test
    testVaultId = `test-vault-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    await db('vaults').insert({
      id: testVaultId,
      amount: '1000',
      start_date: new Date().toISOString(),
      end_date: new Date(Date.now() + 86400000).toISOString(),
      verifier: 'test-verifier',
      success_destination: 'success-addr',
      failure_destination: 'failure-addr',
      creator: testAdminId,
      status: 'active',
      created_at: new Date().toISOString()
    })
  })

  afterEach(async () => {
    // Clean up test vaults
    await db('vaults').where('id', 'like', 'test-vault%').del()
  })

  afterAll(async () => {
    // Clean up test users
    await db('users').where('email', 'like', '%override-test%').del()
    await db.destroy()
  })

  describe('POST /api/admin/overrides/vaults/:id/cancel', () => {
    test('should require reasonCode field', async () => {
      const response = await request(app)
        .post(`/api/admin/overrides/vaults/${testVaultId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Some reason' })
        .expect(400)

      expect(response.body).toHaveProperty('error', 'Missing required field: reasonCode')
      expect(response.body).toHaveProperty('validReasonCodes', ValidOverrideReasonCodes)
    })

    test('should reject invalid reasonCode', async () => {
      const response = await request(app)
        .post(`/api/admin/overrides/vaults/${testVaultId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reasonCode: 'INVALID_REASON' })
        .expect(400)

      expect(response.body.error).toContain('Invalid reasonCode')
      expect(response.body).toHaveProperty('validReasonCodes', ValidOverrideReasonCodes)
    })

    test('should accept all valid reason codes', async () => {
      for (const reasonCode of ValidOverrideReasonCodes) {
        // Create a fresh vault for each iteration
        const freshVaultId = `test-vault-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        await db('vaults').insert({
          id: freshVaultId,
          amount: '1000',
          start_date: new Date().toISOString(),
          end_date: new Date(Date.now() + 86400000).toISOString(),
          verifier: 'test-verifier',
          success_destination: 'success-addr',
          failure_destination: 'failure-addr',
          creator: testAdminId,
          status: 'active',
          created_at: new Date().toISOString()
        })

        const response = await request(app)
          .post(`/api/admin/overrides/vaults/${freshVaultId}/cancel`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ reasonCode, reason: `Test cancel with ${reasonCode}` })

        expect(response.status).toBe(200)
        expect(response.body.vault.status).toBe('cancelled')

        // Clean up
        await db('vaults').where('id', freshVaultId).del()
      }
    })

    test('should be idempotent with explicit idempotencyKey', async () => {
      const idempotencyKey = `test-key-${Date.now()}`

      // First request should succeed
      const firstResponse = await request(app)
        .post(`/api/admin/overrides/vaults/${testVaultId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          reasonCode: 'USER_REQUEST',
          reason: 'User requested cancellation',
          idempotencyKey
        })
        .expect(200)

      expect(firstResponse.body).toHaveProperty('auditLogId')
      expect(firstResponse.body).toHaveProperty('idempotencyKey', idempotencyKey)

      // Second request should return 409 with idempotent replay info
      const secondResponse = await request(app)
        .post(`/api/admin/overrides/vaults/${testVaultId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          reasonCode: 'USER_REQUEST',
          reason: 'User requested cancellation',
          idempotencyKey
        })
        .expect(409)

      expect(secondResponse.body.error).toContain('Override already processed')
      expect(secondResponse.body).toHaveProperty('auditLogId', firstResponse.body.auditLogId)
      expect(secondResponse.body).toHaveProperty('processedAt')
    })

    test('should be idempotent without explicit idempotencyKey (auto-generated)', async () => {
      // First request should succeed
      const firstResponse = await request(app)
        .post(`/api/admin/overrides/vaults/${testVaultId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          reasonCode: 'SYSTEM_ERROR',
          reason: 'System error cancellation'
        })
        .expect(200)

      expect(firstResponse.body).toHaveProperty('idempotencyKey')
      const autoKey = firstResponse.body.idempotencyKey

      // Second request should return 409
      const secondResponse = await request(app)
        .post(`/api/admin/overrides/vaults/${testVaultId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          reasonCode: 'SYSTEM_ERROR',
          reason: 'System error cancellation'
        })
        .expect(409)

      expect(secondResponse.body.error).toContain('Override already processed')
      expect(secondResponse.body).toHaveProperty('idempotencyKey', autoKey)
    })

    test('should create audit log with before/after diff', async () => {
      const response = await request(app)
        .post(`/api/admin/overrides/vaults/${testVaultId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('User-Agent', 'test-agent')
        .send({
          reasonCode: 'FRAUD_DETECTED',
          reason: 'Fraud detected in vault',
          details: 'Suspicious activity detected'
        })
        .expect(200)

      // Fetch the audit log
      const auditLogId = response.body.auditLogId
      const auditResponse = await request(app)
        .get(`/api/admin/audit-logs/${auditLogId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      const auditLog = auditResponse.body
      expect(auditLog.action).toBe('admin.override')
      expect(auditLog.target_type).toBe('vault')
      expect(auditLog.target_id).toBe(testVaultId)

      // Check metadata structure
      expect(auditLog.metadata).toHaveProperty('override_type', 'vault.cancel')
      expect(auditLog.metadata).toHaveProperty('reason_code', 'FRAUD_DETECTED')
      expect(auditLog.metadata).toHaveProperty('reason_text')
      expect(auditLog.metadata).toHaveProperty('details')
      expect(auditLog.metadata).toHaveProperty('idempotency_key')
      expect(auditLog.metadata).toHaveProperty('admin_id', testAdminId)

      // Check diff structure
      expect(auditLog.metadata).toHaveProperty('diff')
      expect(auditLog.metadata.diff).toHaveProperty('status')
      expect(auditLog.metadata.diff.status.before).toBe('active')
      expect(auditLog.metadata.diff.status.after).toBe('cancelled')
      expect(auditLog.metadata.diff).toHaveProperty('changed_at')

      // Check request context
      expect(auditLog.metadata).toHaveProperty('request_context')
      expect(auditLog.metadata.request_context).toHaveProperty('user_agent', 'test-agent')
      expect(auditLog.metadata.request_context).toHaveProperty('method', 'POST')
      expect(auditLog.metadata.request_context).toHaveProperty('path')
    })

    test('should sanitize PII in reason and details fields', async () => {
      const response = await request(app)
        .post(`/api/admin/overrides/vaults/${testVaultId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          reasonCode: 'POLICY_VIOLATION',
          reason: 'Contact user at john.doe@example.com for more info',
          details: 'User IP was 192.168.1.1 and SSN 123-45-6789. Secret token: abcdef12345678901234567890abcdef'
        })
        .expect(200)

      const auditLogId = response.body.auditLogId
      const auditResponse = await request(app)
        .get(`/api/admin/audit-logs/${auditLogId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      const auditLog = auditResponse.body

      // Check that PII was redacted
      expect(auditLog.metadata.reason_text).toContain('[REDACTED_EMAIL]')
      expect(auditLog.metadata.reason_text).not.toContain('john.doe@example.com')
      expect(auditLog.metadata.reason_text).not.toContain('@example.com')
    })

    test('should return 409 when vault is already cancelled with audit log', async () => {
      // First cancel the vault
      await request(app)
        .post(`/api/admin/overrides/vaults/${testVaultId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reasonCode: 'USER_REQUEST' })
        .expect(200)

      clearProcessedOverrides() // Clear idempotency to test the actual vault state check

      // Second cancel should return 409 with audit log
      const response = await request(app)
        .post(`/api/admin/overrides/vaults/${testVaultId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reasonCode: 'EMERGENCY_ADMIN_ACTION' })
        .expect(409)

      expect(response.body.error).toContain('Vault is already cancelled')
      expect(response.body).toHaveProperty('auditLogId')
    })

    test('should return 409 for non-cancellable vault status', async () => {
      // Update vault to completed status (non-cancellable)
      await db('vaults').where('id', testVaultId).update({ status: 'completed' })

      const response = await request(app)
        .post(`/api/admin/overrides/vaults/${testVaultId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reasonCode: 'COMPLIANCE_REQUIREMENT' })
        .expect(409)

      expect(response.body.error).toContain('cannot be cancelled')
      expect(response.body).toHaveProperty('currentStatus', 'completed')
    })

    test('should return 404 for non-existent vault', async () => {
      const response = await request(app)
        .post('/api/admin/overrides/vaults/non-existent-vault-id/cancel')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reasonCode: 'TESTING_CLEANUP' })
        .expect(404)

      expect(response.body).toHaveProperty('error', 'Vault not found')
    })

    test('should deny access to non-admin users', async () => {
      const response = await request(app)
        .post(`/api/admin/overrides/vaults/${testVaultId}/cancel`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({ reasonCode: 'USER_REQUEST' })
        .expect(403)

      expect(response.body).toHaveProperty('error')
    })

    test('should deny unauthenticated requests', async () => {
      const response = await request(app)
        .post(`/api/admin/overrides/vaults/${testVaultId}/cancel`)
        .send({ reasonCode: 'USER_REQUEST' })
        .expect(401)

      expect(response.body).toHaveProperty('error')
    })

    test('should include response with previous and new status', async () => {
      const response = await request(app)
        .post(`/api/admin/overrides/vaults/${testVaultId}/cancel`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reasonCode: 'USER_REQUEST' })
        .expect(200)

      expect(response.body).toHaveProperty('previousStatus', 'active')
      expect(response.body).toHaveProperty('newStatus', 'cancelled')
      expect(response.body.vault.status).toBe('cancelled')
    })
  })
})
