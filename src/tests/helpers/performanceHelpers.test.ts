import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { db } from '../../db/index.js'
import {
  measurePerformance,
  trackQueries,
  seedLargeDataset,
  generateTestUser,
  generateTestVault,
  generateTestTransaction,
  cleanupPerfTestData,
  assertPerformance,
  logPerformanceMetrics,
  type PerformanceThresholds
} from './performanceHelpers.js'

/**
 * Tests for performance helper utilities
 * Ensures 95%+ coverage as required by the performance testing spec
 */

describe('Performance Helpers', () => {
  beforeAll(async () => {
    await cleanupPerfTestData(db)
  })

  afterAll(async () => {
    await cleanupPerfTestData(db)
    await db.destroy()
  })

  describe('measurePerformance', () => {
    it('should measure response time for an operation', async () => {
      const thresholds: PerformanceThresholds = {
        maxResponseTime: 1000
      }

      const result = await measurePerformance(
        async () => {
          await new Promise(resolve => setTimeout(resolve, 50))
        },
        thresholds
      )

      expect(result.responseTime).toBeGreaterThanOrEqual(50)
      expect(result.responseTime).toBeLessThan(1000)
      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })

    it('should detect threshold violations', async () => {
      const thresholds: PerformanceThresholds = {
        maxResponseTime: 10
      }

      const result = await measurePerformance(
        async () => {
          await new Promise(resolve => setTimeout(resolve, 50))
        },
        thresholds
      )

      expect(result.passed).toBe(false)
      expect(result.violations.length).toBeGreaterThan(0)
      expect(result.violations[0]).toContain('exceeded threshold')
    })

    it('should propagate errors from the operation', async () => {
      const thresholds: PerformanceThresholds = {
        maxResponseTime: 1000
      }

      await expect(
        measurePerformance(
          async () => {
            throw new Error('Test error')
          },
          thresholds
        )
      ).rejects.toThrow('Test error')
    })
  })

  describe('trackQueries', () => {
    it('should track database queries', async () => {
      const queryCount = await trackQueries(db, async () => {
        await db('users').select('*').limit(1)
        await db('vaults').select('*').limit(1)
      })

      expect(queryCount).toBeGreaterThanOrEqual(2)
    })

    it('should handle errors and cleanup event listeners', async () => {
      await expect(
        trackQueries(db, async () => {
          await db('users').select('*').limit(1)
          throw new Error('Query error')
        })
      ).rejects.toThrow('Query error')

      // Verify event listeners were cleaned up by running another query
      const count = await trackQueries(db, async () => {
        await db('users').select('*').limit(1)
      })
      expect(count).toBe(1)
    })
  })

  describe('seedLargeDataset', () => {
    it('should seed records in batches', async () => {
      const testUsers = await db('users')
        .insert(generateTestUser(9999))
        .returning('*')
      const testUserId = testUsers[0].id

      await seedLargeDataset(
        db,
        'vaults',
        50,
        (index) => generateTestVault(index, testUserId)
      )

      const count = await db('vaults')
        .where('id', 'like', 'vault-perf-%')
        .count('* as total')
        .first()

      expect(parseInt(count?.total as string || '0')).toBe(50)

      // Cleanup
      await db('vaults').where('id', 'like', 'vault-perf-%').del()
      await db('users').where('id', testUserId).del()
    })

    it('should handle non-round batch sizes', async () => {
      const testUsers = await db('users')
        .insert(generateTestUser(9998))
        .returning('*')
      const testUserId = testUsers[0].id

      // 1500 records = 1 full batch (1000) + 1 partial batch (500)
      await seedLargeDataset(
        db,
        'vaults',
        1500,
        (index) => generateTestVault(index + 1000, testUserId)
      )

      const count = await db('vaults')
        .where('id', 'like', 'vault-perf-%')
        .count('* as total')
        .first()

      expect(parseInt(count?.total as string || '0')).toBe(1500)

      // Cleanup
      await db('vaults').where('id', 'like', 'vault-perf-%').del()
      await db('users').where('id', testUserId).del()
    })
  })

  describe('generateTestUser', () => {
    it('should generate unique users', () => {
      const user1 = generateTestUser(1)
      const user2 = generateTestUser(2)

      expect(user1.email).not.toBe(user2.email)
      expect(user1.email).toContain('perf-test-user-1')
      expect(user2.email).toContain('perf-test-user-2')
      expect(user1.password_hash).toBe('hash_1')
      expect(user2.password_hash).toBe('hash_2')
    })

    it('should generate users with correct structure', () => {
      const user = generateTestUser(0)

      expect(user).toHaveProperty('email')
      expect(user).toHaveProperty('password_hash')
      expect(user).toHaveProperty('role')
      expect(user).toHaveProperty('status')
      expect(user).toHaveProperty('created_at')
      expect(user).toHaveProperty('updated_at')
      expect(user.role).toBe('USER')
      expect(user.status).toBe('ACTIVE')
    })
  })

  describe('generateTestVault', () => {
    it('should generate unique vaults', () => {
      const vault1 = generateTestVault(1, 'user-123')
      const vault2 = generateTestVault(2, 'user-123')

      expect(vault1.id).not.toBe(vault2.id)
      expect(vault1.id).toContain('vault-perf-')
      expect(vault1.amount).not.toBe(vault2.amount)
    })

    it('should generate vaults with correct structure', () => {
      const vault = generateTestVault(0, 'user-123')

      expect(vault).toHaveProperty('id')
      expect(vault).toHaveProperty('creator_id')
      expect(vault).toHaveProperty('amount')
      expect(vault).toHaveProperty('start_date')
      expect(vault).toHaveProperty('end_date')
      expect(vault).toHaveProperty('verifier')
      expect(vault).toHaveProperty('success_destination')
      expect(vault).toHaveProperty('failure_destination')
      expect(vault).toHaveProperty('status')
      expect(vault.creator_id).toBe('user-123')
    })

    it('should cycle through different statuses', () => {
      const statuses = new Set()
      for (let i = 0; i < 10; i++) {
        const vault = generateTestVault(i, 'user-123')
        statuses.add(vault.status)
      }

      expect(statuses.size).toBeGreaterThan(1)
    })
  })

  describe('generateTestTransaction', () => {
    it('should generate unique transactions', () => {
      const tx1 = generateTestTransaction(1, 'user-123', 'vault-123')
      const tx2 = generateTestTransaction(2, 'user-123', 'vault-123')

      expect(tx1.tx_hash).not.toBe(tx2.tx_hash)
      expect(tx1.tx_hash).toContain('hash_perf_')
      expect(tx1.amount).not.toBe(tx2.amount)
    })

    it('should generate transactions with correct structure', () => {
      const tx = generateTestTransaction(0, 'user-123', 'vault-123')

      expect(tx).toHaveProperty('user_id')
      expect(tx).toHaveProperty('vault_id')
      expect(tx).toHaveProperty('tx_hash')
      expect(tx).toHaveProperty('type')
      expect(tx).toHaveProperty('amount')
      expect(tx).toHaveProperty('asset_code')
      expect(tx).toHaveProperty('from_account')
      expect(tx).toHaveProperty('to_account')
      expect(tx).toHaveProperty('memo')
      expect(tx).toHaveProperty('stellar_ledger')
      expect(tx).toHaveProperty('stellar_timestamp')
      expect(tx).toHaveProperty('explorer_url')
      expect(tx.user_id).toBe('user-123')
      expect(tx.vault_id).toBe('vault-123')
    })

    it('should cycle through different transaction types', () => {
      const types = new Set()
      for (let i = 0; i < 10; i++) {
        const tx = generateTestTransaction(i, 'user-123', 'vault-123')
        types.add(tx.type)
      }

      expect(types.size).toBeGreaterThan(1)
    })
  })

  describe('cleanupPerfTestData', () => {
    it('should remove all performance test data', async () => {
      // Create test data
      const user = await db('users')
        .insert(generateTestUser(8888))
        .returning('*')
      const userId = user[0].id

      const vault = await db('vaults')
        .insert(generateTestVault(8888, userId))
        .returning('*')
      const vaultId = vault[0].id

      await db('transactions')
        .insert(generateTestTransaction(8888, userId, vaultId))

      // Verify data exists
      let txCount = await db('transactions')
        .where('tx_hash', 'like', 'hash_perf_%')
        .count('* as total')
        .first()
      expect(parseInt(txCount?.total as string || '0')).toBeGreaterThan(0)

      // Cleanup
      await cleanupPerfTestData(db)

      // Verify data is removed
      txCount = await db('transactions')
        .where('tx_hash', 'like', 'hash_perf_%')
        .count('* as total')
        .first()
      expect(parseInt(txCount?.total as string || '0')).toBe(0)

      const vaultCount = await db('vaults')
        .where('id', 'like', 'vault-perf-%')
        .count('* as total')
        .first()
      expect(parseInt(vaultCount?.total as string || '0')).toBe(0)

      const userCount = await db('users')
        .where('email', 'like', 'perf-test-%')
        .count('* as total')
        .first()
      expect(parseInt(userCount?.total as string || '0')).toBe(0)
    })
  })

  describe('assertPerformance', () => {
    it('should not throw for passing results', () => {
      const result = {
        responseTime: 100,
        passed: true,
        violations: []
      }

      expect(() => {
        assertPerformance(result, 'test')
      }).not.toThrow()
    })

    it('should throw for failing results', () => {
      const result = {
        responseTime: 2000,
        passed: false,
        violations: ['Response time 2000ms exceeded threshold 1000ms']
      }

      expect(() => {
        assertPerformance(result, 'test_name')
      }).toThrow('Performance test "test_name" failed')
      expect(() => {
        assertPerformance(result, 'test_name')
      }).toThrow('Response time 2000ms exceeded threshold 1000ms')
    })
  })

  describe('logPerformanceMetrics', () => {
    it('should log structured metrics', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation()

      const result = {
        responseTime: 150,
        queryCount: 5,
        passed: true,
        violations: []
      }

      logPerformanceMetrics('test_endpoint', result)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('performance.smoke_test')
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('test_endpoint')
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"responseTime":150')
      )

      consoleSpy.mockRestore()
    })

    it('should include violations in logs', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation()

      const result = {
        responseTime: 2000,
        passed: false,
        violations: ['Threshold exceeded']
      }

      logPerformanceMetrics('slow_endpoint', result)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"passed":false')
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Threshold exceeded')
      )

      consoleSpy.mockRestore()
    })
  })
})
