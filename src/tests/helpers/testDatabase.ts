import knex, { Knex } from 'knex'
import { PrismaClient } from '@prisma/client'
import { UserRole } from '../../types/user.js'

/**
 * Test database helpers for setting up, tearing down, and capturing database state
 * These utilities ensure clean test environments and enable state comparison
 */

// Database state snapshot interface
export interface DbState {
  vaults: any[]
  milestones: any[]
  validations: any[]
  processedEvents: any[]
  failedEvents: any[]
  listenerState: any[]
  users?: any[]
  sessions?: any[]
  verifiers?: any[]
}

// Test user interface for RBAC testing
export interface TestUser {
  id: string
  email: string
  role: UserRole
  status?: string
  createdAt?: Date
}

export interface TestHarness {
  knex: Knex
  prisma: PrismaClient
}

/**
 * Validates the database URL to ensure we are not accidentally connecting to production.
 * @param url Database URL to validate
 */
export function validateDatabaseUrl(url: string) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SECURITY GUARD: Test harness cannot be run in production environment!');
  }
  
  if (url) {
    const isLocalhost = url.includes('localhost') || url.includes('127.0.0.1');
    const isTestDb = url.includes('test') || url.includes('disciplr_test');
    
    if (!isLocalhost && !isTestDb) {
      throw new Error(`SECURITY GUARD: Database URL looks like a production database. Refusing to run tests. URL: ${url}`);
    }
  }
}

/**
 * Check if the database is reachable
 * Useful for skipping integration tests in environments without a live database
 * 
 * @returns true if database is reachable, false otherwise
 */
export async function isDatabaseReachable(): Promise<boolean> {
  const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/disciplr_test'
  
  const db = knex({
    client: 'pg',
    connection: dbUrl,
    acquireConnectionTimeout: 2000
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

/**
 * Setup a test database connection and prepare it for testing
 * - Connects to the test database
 * - Runs all migrations
 * - Cleans all tables
 * 
 * @returns Object with Knex and Prisma database instances
 */
export async function setupTestDatabase(): Promise<TestHarness> {
  const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/disciplr_test'
  
  validateDatabaseUrl(dbUrl)

  const db = knex({
    client: 'pg',
    connection: dbUrl,
    migrations: {
      directory: './db/migrations',
      extension: 'cjs'
    }
  })

  const prisma = new PrismaClient({
    datasources: {
      db: { url: dbUrl }
    }
  })

  // Run migrations to ensure schema is up to date
  await migrateUp(db)

  // Clean all tables to ensure a fresh state
  await truncateTables(db)

  return { knex: db, prisma }
}

/**
 * Teardown the test database connection
 * - Destroys the database connection pool
 * 
 * @param harness - TestHarness or Knex database instance
 */
export async function teardownTestDatabase(harness: TestHarness | Knex | undefined | null): Promise<void> {
  if (!harness) return
  if ('knex' in harness) {
    await harness.knex.destroy()
    await harness.prisma.$disconnect()
  } else {
    await (harness as Knex).destroy()
  }
}

/**
 * Apply database migrations (up)
 */
export async function migrateUp(db: Knex): Promise<void> {
  await db.migrate.latest()
}

/**
 * Rollback database migrations (down)
 */
export async function migrateDown(db: Knex): Promise<void> {
  await db.migrate.rollback()
}

/**
 * Truncate all tables in the database safely using CASCADE
 * This is faster and less error-prone than deleting rows in order
 * 
 * @param db - Knex database instance
 */
export async function truncateTables(db: Knex): Promise<void> {
  await db.raw(`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename != 'knex_migrations' AND tablename != 'knex_migrations_lock') LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
}

/**
 * Seed minimal test fixtures useful for general DB tests
 */
export async function seedMinimalFixtures(harness: TestHarness): Promise<void> {
  await createAllRoleTestUsers(harness.knex)
}

/**
 * Clean all tables in the database
 * Deletes all records from all tables in the correct order to respect foreign key constraints
 * 
 * @param db - Knex database instance
 */
export async function cleanAllTables(db: Knex): Promise<void> {
  // Delete in order to respect foreign key constraints
  await db('validations').delete()
  await db('milestones').delete()
  await db('vaults').delete()
  await db('processed_events').delete()
  await db('failed_events').delete()
  await db('listener_state').delete()
  
  // Clean RBAC-related tables if they exist
  try {
    await db('sessions').delete()
    await db('verifiers').delete()
    await db('users').delete()
  } catch (error) {
    // Tables might not exist in all test environments
    // This is acceptable for backwards compatibility
  }
}

/**
 * Capture the current state of all relevant database tables
 * Returns a snapshot of all records in all tables, sorted by ID for consistent comparison
 * 
 * @param db - Knex database instance
 * @returns DbState snapshot
 */
export async function captureDbState(db: Knex): Promise<DbState> {
  const state: DbState = {
    vaults: await db('vaults').select('*').orderBy('id'),
    milestones: await db('milestones').select('*').orderBy('id'),
    validations: await db('validations').select('*').orderBy('id'),
    processedEvents: await db('processed_events').select('*').orderBy('event_id'),
    failedEvents: await db('failed_events').select('*').orderBy('id'),
    listenerState: await db('listener_state').select('*').orderBy('id')
  }
  
  // Capture RBAC-related tables if they exist
  try {
    state.users = await db('users').select('*').orderBy('id')
    state.sessions = await db('sessions').select('*').orderBy('id')
    state.verifiers = await db('verifiers').select('*').orderBy('user_id')
  } catch (error) {
    // Tables might not exist in all test environments
  }
  
  return state
}

/**
 * Compare two database states for equality
 * Useful for testing idempotency and transaction atomicity
 * 
 * @param state1 - First database state
 * @param state2 - Second database state
 * @returns true if states are equal, false otherwise
 */
export function compareDbStates(state1: DbState, state2: DbState): boolean {
  return (
    JSON.stringify(state1.vaults) === JSON.stringify(state2.vaults) &&
    JSON.stringify(state1.milestones) === JSON.stringify(state2.milestones) &&
    JSON.stringify(state1.validations) === JSON.stringify(state2.validations) &&
    JSON.stringify(state1.processedEvents) === JSON.stringify(state2.processedEvents) &&
    JSON.stringify(state1.failedEvents) === JSON.stringify(state2.failedEvents) &&
    JSON.stringify(state1.listenerState) === JSON.stringify(state2.listenerState)
  )
}

/**
 * Insert a test vault into the database
 * Helper function to quickly create a vault for testing milestone and validation events
 * 
 * @param db - Knex database instance
 * @param vaultId - Vault ID
 * @param overrides - Optional field overrides
 */
export async function insertTestVault(
  db: Knex,
  vaultId: string,
  overrides: Partial<{
    creator: string
    amount: string
    startTimestamp: Date
    endTimestamp: Date
    successDestination: string
    failureDestination: string
    status: string
  }> = {}
): Promise<void> {
  await db('vaults').insert({
    id: vaultId,
    creator: overrides.creator || 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    amount: overrides.amount || '1000.0000000',
    start_timestamp: overrides.startTimestamp || new Date('2024-01-01'),
    end_date: overrides.endTimestamp || new Date('2024-12-31'),
    success_destination: overrides.successDestination || 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    failure_destination: overrides.failureDestination || 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    status: overrides.status || 'active',
    created_at: new Date()
  })
}

/**
 * Insert a test milestone into the database
 * Helper function to quickly create a milestone for testing validation events
 * 
 * @param db - Knex database instance
 * @param milestoneId - Milestone ID
 * @param vaultId - Vault ID (must exist)
 * @param overrides - Optional field overrides
 */
export async function insertTestMilestone(
  db: Knex,
  milestoneId: string,
  vaultId: string,
  overrides: Partial<{
    title: string
    description: string
    targetAmount: string
    currentAmount: string
    deadline: Date
    status: string
  }> = {}
): Promise<void> {
  await db('milestones').insert({
    id: milestoneId,
    vault_id: vaultId,
    title: overrides.title || 'Test Milestone',
    description: overrides.description || 'Test milestone description',
    target_amount: overrides.targetAmount || '500.0000000',
    current_amount: overrides.currentAmount || '0',
    deadline: overrides.deadline || new Date('2024-06-30'),
    status: overrides.status || 'pending',
    created_at: new Date(),
    updated_at: new Date()
  })
}

/**
 * Get the count of records in a table
 * Useful for quick assertions about table state
 * 
 * @param db - Knex database instance
 * @param tableName - Name of the table
 * @returns Number of records in the table
 */
export async function getTableCount(db: Knex, tableName: string): Promise<number> {
  const result = await db(tableName).count('* as count').first()
  return parseInt(result?.count as string || '0', 10)
}

/**
 * Check if an event has been processed
 * Queries the processed_events table for the given event ID
 * 
 * @param db - Knex database instance
 * @param eventId - Event ID to check
 * @returns true if event has been processed, false otherwise
 */
export async function isEventProcessed(db: Knex, eventId: string): Promise<boolean> {
  const result = await db('processed_events').where({ event_id: eventId }).first()
  return !!result
}

/**
 * Check if an event is in the dead letter queue
 * Queries the failed_events table for the given event ID
 * 
 * @param db - Knex database instance
 * @param eventId - Event ID to check
 * @returns true if event is in DLQ, false otherwise
 */
export async function isEventInDLQ(db: Knex, eventId: string): Promise<boolean> {
  const result = await db('failed_events').where({ event_id: eventId }).first()
  return !!result
}

/**
 * Wait for a condition to be true (with timeout)
 * Useful for testing asynchronous operations
 * 
 * @param condition - Function that returns true when condition is met
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param intervalMs - Interval between checks in milliseconds
 * @returns true if condition was met, false if timeout
 */
export async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<boolean> {
  const startTime = Date.now()
  
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  
  return false
}

/**
 * RBAC-Specific Test Utilities
 * These functions help create and manage test users, sessions, and verifiers
 * for comprehensive RBAC testing.
 * 
 * **Validates: Requirement 12.5**
 */

/**
 * Create a test user with specified role
 * 
 * @param db - Knex database instance
 * @param userId - User ID
 * @param role - User role (USER, VERIFIER, ADMIN)
 * @param overrides - Optional field overrides
 * @returns Created user object
 */
export async function createTestUser(
  db: Knex,
  userId: string,
  role: UserRole,
  overrides: Partial<{
    email: string
    status: string
    deletedAt: Date | null
  }> = {}
): Promise<TestUser> {
  const user = {
    id: userId,
    email: overrides.email || `${userId}@test.example.com`,
    role: role,
    status: overrides.status || 'ACTIVE',
    deleted_at: overrides.deletedAt || null,
    created_at: new Date(),
    updated_at: new Date(),
  }

  await db('users').insert(user)

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
  }
}

/**
 * Create test users for all three roles
 * Convenience function to quickly set up a complete test environment
 * 
 * @param db - Knex database instance
 * @returns Object with user, verifier, and admin test users
 */
export async function createAllRoleTestUsers(db: Knex): Promise<{
  user: TestUser
  verifier: TestUser
  admin: TestUser
}> {
  const user = await createTestUser(db, 'test-user-id', UserRole.USER)
  const verifier = await createTestUser(db, 'test-verifier-id', UserRole.VERIFIER)
  const admin = await createTestUser(db, 'test-admin-id', UserRole.ADMIN)

  return { user, verifier, admin }
}

/**
 * Create a test session for a user
 * 
 * @param db - Knex database instance
 * @param sessionId - Session ID (jti)
 * @param userId - User ID
 * @param overrides - Optional field overrides
 */
export async function createTestSession(
  db: Knex,
  sessionId: string,
  userId: string,
  overrides: Partial<{
    expiresAt: Date
    revokedAt: Date | null
  }> = {}
): Promise<void> {
  await db('sessions').insert({
    id: sessionId,
    user_id: userId,
    expires_at: overrides.expiresAt || new Date(Date.now() + 3600000), // 1 hour from now
    revoked_at: overrides.revokedAt || null,
    created_at: new Date(),
  })
}

/**
 * Revoke a test session
 * 
 * @param db - Knex database instance
 * @param sessionId - Session ID to revoke
 */
export async function revokeTestSession(db: Knex, sessionId: string): Promise<void> {
  await db('sessions')
    .where({ id: sessionId })
    .update({ revoked_at: new Date() })
}

/**
 * Create a test verifier profile
 * 
 * @param db - Knex database instance
 * @param userId - User ID (must have VERIFIER or ADMIN role)
 * @param overrides - Optional field overrides
 */
export async function createTestVerifier(
  db: Knex,
  userId: string,
  overrides: Partial<{
    specialization: string
    status: string
    approvedAt: Date | null
    suspendedAt: Date | null
  }> = {}
): Promise<void> {
  await db('verifiers').insert({
    user_id: userId,
    specialization: overrides.specialization || 'milestone-verification',
    status: overrides.status || 'ACTIVE',
    approved_at: overrides.approvedAt || new Date(),
    suspended_at: overrides.suspendedAt || null,
    created_at: new Date(),
    updated_at: new Date(),
  })
}

/**
 * Get a user by ID
 * 
 * @param db - Knex database instance
 * @param userId - User ID
 * @returns User object or null if not found
 */
export async function getTestUser(db: Knex, userId: string): Promise<TestUser | null> {
  const user = await db('users').where({ id: userId }).first()
  
  if (!user) {
    return null
  }

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
  }
}

/**
 * Check if a session is valid (not revoked and not expired)
 * 
 * @param db - Knex database instance
 * @param sessionId - Session ID
 * @returns true if session is valid, false otherwise
 */
export async function isSessionValid(db: Knex, sessionId: string): Promise<boolean> {
  const session = await db('sessions').where({ id: sessionId }).first()
  
  if (!session) {
    return false
  }

  const now = new Date()
  const isNotRevoked = !session.revoked_at
  const isNotExpired = new Date(session.expires_at) > now

  return isNotRevoked && isNotExpired
}

/**
 * Delete a test user (soft delete)
 * 
 * @param db - Knex database instance
 * @param userId - User ID
 */
export async function deleteTestUser(db: Knex, userId: string): Promise<void> {
  await db('users')
    .where({ id: userId })
    .update({ deleted_at: new Date() })
}

/**
 * Restore a soft-deleted test user
 * 
 * @param db - Knex database instance
 * @param userId - User ID
 */
export async function restoreTestUser(db: Knex, userId: string): Promise<void> {
  await db('users')
    .where({ id: userId })
    .update({ deleted_at: null })
}

/**
 * Update a test user's role
 * 
 * @param db - Knex database instance
 * @param userId - User ID
 * @param newRole - New role to assign
 */
export async function updateTestUserRole(
  db: Knex,
  userId: string,
  newRole: UserRole
): Promise<void> {
  await db('users')
    .where({ id: userId })
    .update({ role: newRole, updated_at: new Date() })
}

/**
 * Update a test user's status
 * 
 * @param db - Knex database instance
 * @param userId - User ID
 * @param newStatus - New status to assign
 */
export async function updateTestUserStatus(
  db: Knex,
  userId: string,
  newStatus: string
): Promise<void> {
  await db('users')
    .where({ id: userId })
    .update({ status: newStatus, updated_at: new Date() })
}
