import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import {
  validateDatabaseUrl,
  compareDbStates,
  waitForCondition,
  setupTestDatabase,
  teardownTestDatabase,
  truncateTables,
  seedMinimalFixtures,
  migrateUp,
  migrateDown,
  DbState,
  TestHarness,
} from './testDatabase.js'

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests — no database connection required
// Tests the pure logic (security guards, URL validation, state comparison, etc.)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateDatabaseUrl (unit)', () => {
  const originalEnv = process.env.NODE_ENV
  const originalUrl = process.env.DATABASE_URL

  afterAll(() => {
    process.env.NODE_ENV = originalEnv
    if (originalUrl !== undefined) {
      process.env.DATABASE_URL = originalUrl
    } else {
      delete process.env.DATABASE_URL
    }
  })

  it('accepts a localhost URL', () => {
    expect(() =>
      validateDatabaseUrl('postgresql://postgres:postgres@localhost:5432/disciplr_test')
    ).not.toThrow()
  })

  it('accepts a 127.0.0.1 URL', () => {
    expect(() =>
      validateDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:5432/some_db')
    ).not.toThrow()
  })

  it('accepts a URL containing the word "test"', () => {
    expect(() =>
      validateDatabaseUrl('postgresql://user:pass@db.internal:5432/myapp_test')
    ).not.toThrow()
  })

  it('accepts a URL containing "disciplr_test"', () => {
    expect(() =>
      validateDatabaseUrl('postgresql://user:pass@ci-db:5432/disciplr_test')
    ).not.toThrow()
  })

  it('throws SECURITY GUARD if NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production'
    expect(() =>
      validateDatabaseUrl('postgresql://user:pass@localhost:5432/disciplr_test')
    ).toThrow(/SECURITY GUARD/)
    process.env.NODE_ENV = originalEnv
  })

  it('throws SECURITY GUARD when URL looks like production (no localhost, no "test")', () => {
    expect(() =>
      validateDatabaseUrl('postgresql://user:pass@prod-db.example.com:5432/disciplr')
    ).toThrow(/SECURITY GUARD/)
  })

  it('error message includes the URL so it is easy to identify', () => {
    expect(() =>
      validateDatabaseUrl('postgresql://user:pass@prod-db.example.com:5432/disciplr')
    ).toThrow('prod-db.example.com')
  })

  it('does not throw when URL is empty string (will fail at connection time)', () => {
    expect(() => validateDatabaseUrl('')).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// compareDbStates (unit) — pure JSON comparison, no DB needed
// ─────────────────────────────────────────────────────────────────────────────

describe('compareDbStates (unit)', () => {
  const emptyState: DbState = {
    vaults: [],
    milestones: [],
    validations: [],
    processedEvents: [],
    failedEvents: [],
    listenerState: [],
  }

  it('returns true for two identical empty states', () => {
    expect(compareDbStates(emptyState, { ...emptyState })).toBe(true)
  })

  it('returns true for two identical non-empty states', () => {
    const state: DbState = {
      vaults: [{ id: 'v1', amount: '100' }],
      milestones: [],
      validations: [],
      processedEvents: [],
      failedEvents: [],
      listenerState: [],
    }
    expect(compareDbStates(state, { ...state, vaults: [{ id: 'v1', amount: '100' }] })).toBe(true)
  })

  it('returns false when vaults differ', () => {
    const s1: DbState = { ...emptyState, vaults: [{ id: 'v1' }] }
    const s2: DbState = { ...emptyState, vaults: [{ id: 'v2' }] }
    expect(compareDbStates(s1, s2)).toBe(false)
  })

  it('returns false when milestones differ', () => {
    const s1: DbState = { ...emptyState, milestones: [{ id: 'm1' }] }
    const s2: DbState = { ...emptyState, milestones: [] }
    expect(compareDbStates(s1, s2)).toBe(false)
  })

  it('returns false when processedEvents differ', () => {
    const s1: DbState = { ...emptyState, processedEvents: [{ event_id: 'e1' }] }
    const s2: DbState = { ...emptyState }
    expect(compareDbStates(s1, s2)).toBe(false)
  })

  it('returns false when failedEvents differ', () => {
    const s1: DbState = { ...emptyState, failedEvents: [{ id: 1 }] }
    const s2: DbState = { ...emptyState }
    expect(compareDbStates(s1, s2)).toBe(false)
  })

  it('returns false when listenerState differs', () => {
    const s1: DbState = { ...emptyState, listenerState: [{ id: 1 }] }
    const s2: DbState = { ...emptyState }
    expect(compareDbStates(s1, s2)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// waitForCondition (unit) — pure async timing utility
// ─────────────────────────────────────────────────────────────────────────────

describe('waitForCondition (unit)', () => {
  it('resolves true immediately when condition is already true', async () => {
    const result = await waitForCondition(async () => true, 500, 50)
    expect(result).toBe(true)
  })

  it('resolves false when condition never becomes true within timeout', async () => {
    const result = await waitForCondition(async () => false, 150, 50)
    expect(result).toBe(false)
  })

  it('resolves true when condition becomes true on the Nth check', async () => {
    let callCount = 0
    const result = await waitForCondition(
      async () => {
        callCount++
        return callCount >= 3
      },
      1000,
      50
    )
    expect(result).toBe(true)
    expect(callCount).toBeGreaterThanOrEqual(3)
  })

  it('respects the timeout boundary accurately', async () => {
    const start = Date.now()
    await waitForCondition(async () => false, 200, 50)
    const elapsed = Date.now() - start
    // Should have waited ~200ms, allowing some scheduling slack
    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(500)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Integration Tests — requires a live PostgreSQL database
// These tests skip automatically when the database is not reachable.
// Set DATABASE_URL=postgresql://postgres:postgres@localhost:5432/disciplr_test
// to run them locally.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper that returns true when a DB is reachable. Used to skip integration
 * tests gracefully when no live DB is present (e.g. unit-only CI jobs).
 */
async function isDatabaseReachable(): Promise<boolean> {
  const { default: knex } = await import('knex')
  const db = knex({
    client: 'pg',
    connection:
      process.env.DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/disciplr_test',
    acquireConnectionTimeout: 2000,
  })
  try {
    await db.raw('SELECT 1')
    await db.destroy()
    return true
  } catch {
    await db.destroy().catch(() => {})
    return false
  }
}

describe('Database Test Harness (integration)', () => {
  let harness: TestHarness
  let dbAvailable = false

  beforeAll(async () => {
    dbAvailable = await isDatabaseReachable()
    if (!dbAvailable) return

    harness = await setupTestDatabase()
  })

  afterAll(async () => {
    if (harness) {
      await teardownTestDatabase(harness)
    }
  })

  it('should return Knex and Prisma clients', () => {
    if (!dbAvailable) {
      console.log('SKIP: no database available')
      return
    }
    expect(harness.knex).toBeDefined()
    expect(harness.prisma).toBeDefined()
  })

  it('should truncate tables successfully', async () => {
    if (!dbAvailable) {
      console.log('SKIP: no database available')
      return
    }

    await harness.knex.raw(`
      INSERT INTO users (id, email, password_hash, role, status, created_at, updated_at)
      VALUES ('trunc-test-id', 'trunc@test.com', 'hash', 'USER', 'ACTIVE', NOW(), NOW())
      ON CONFLICT DO NOTHING
    `)

    await truncateTables(harness.knex)

    const countAfter = await harness.knex('users').count('* as count').first()
    expect(Number(countAfter?.count)).toBe(0)
  })

  it('should seed minimal fixtures (3 role users)', async () => {
    if (!dbAvailable) {
      console.log('SKIP: no database available')
      return
    }

    await truncateTables(harness.knex)
    await seedMinimalFixtures(harness)

    const users = await harness.knex('users').select('*')
    expect(users).toHaveLength(3)
    const roles = users.map((u: any) => u.role).sort()
    expect(roles).toEqual(['ADMIN', 'USER', 'VERIFIER'])
  })

  it('should run migrateDown and migrateUp safely', async () => {
    if (!dbAvailable) {
      console.log('SKIP: no database available')
      return
    }

    await migrateDown(harness.knex)
    await migrateUp(harness.knex)

    const result = await harness.knex.raw('SELECT 1')
    expect(result.rows).toBeDefined()
  })
})
