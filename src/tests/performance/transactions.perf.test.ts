import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import request from 'supertest'
import { app } from '../../app.js'
import { db } from '../../db/index.js'
import {
  measurePerformance,
  seedLargeDataset,
  generateTestUser,
  generateTestVault,
  generateTestTransaction,
  cleanupPerfTestData,
  assertPerformance,
  logPerformanceMetrics,
  type PerformanceThresholds
} from '../helpers/performanceHelpers.js'

/**
 * Performance smoke tests for /api/transactions endpoint
 * 
 * These tests detect:
 * - N+1 query problems
 * - Missing indexes on foreign keys and timestamp columns
 * - Slow cursor pagination with large datasets
 * 
 * Thresholds are conservative to avoid flakiness in CI
 */

describe('GET /api/transactions - Performance Smoke Tests', () => {
  let testUserId: string
  let testVaultId: string
  const DATASET_SIZE = 5000 // 5k transactions for realistic testing
  
  // Conservative thresholds for CI stability
  const thresholds: PerformanceThresholds = {
    maxResponseTime: 2000, // 2 seconds max
    maxQueryCount: 10
  }

  beforeAll(async () => {
    // Clean any existing perf test data
    await cleanupPerfTestData(db)
    
    // Create test user
    const users = await db('users').insert(generateTestUser(0)).returning('*')
    testUserId = users[0].id
    
    // Create test vault
    const vaults = await db('vaults')
      .insert(generateTestVault(0, testUserId))
      .returning('*')
    testVaultId = vaults[0].id
    
    // Seed large dataset of transactions
    console.log(`Seeding ${DATASET_SIZE} transactions for performance testing...`)
    await seedLargeDataset(
      db,
      'transactions',
      DATASET_SIZE,
      (index) => generateTestTransaction(index, testUserId, testVaultId)
    )
    console.log('Seeding complete')
  }, 120000) // 120 second timeout for seeding

  afterAll(async () => {
    await cleanupPerfTestData(db)
    await db.destroy()
  })

  it('should list transactions within performance thresholds (first page)', async () => {
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get('/api/transactions?limit=20')
          .set('x-user-id', testUserId)
          .expect(200)
        
        expect(response.body).toBeDefined()
        expect(response.body.data).toBeDefined()
        expect(Array.isArray(response.body.data)).toBe(true)
        expect(response.body.pagination).toBeDefined()
      },
      thresholds
    )
    
    logPerformanceMetrics('transactions_list_first_page', result)
    assertPerformance(result, 'transactions_list_first_page')
    
    console.log(`✓ Transactions list (first page): ${result.responseTime}ms`)
  })

  it('should list transactions with cursor pagination within performance thresholds', async () => {
    // First, get a cursor
    const firstPage = await request(app)
      .get('/api/transactions?limit=20')
      .set('x-user-id', testUserId)
      .expect(200)
    
    const cursor = firstPage.body.pagination.next_cursor
    expect(cursor).toBeDefined()
    
    // Now test second page performance
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get(`/api/transactions?limit=20&cursor=${cursor}`)
          .set('x-user-id', testUserId)
          .expect(200)
        
        expect(response.body.data).toBeDefined()
        expect(Array.isArray(response.body.data)).toBe(true)
      },
      thresholds
    )
    
    logPerformanceMetrics('transactions_list_cursor_pagination', result)
    assertPerformance(result, 'transactions_list_cursor_pagination')
    
    console.log(`✓ Transactions list (cursor pagination): ${result.responseTime}ms`)
  })

  it('should list transactions with type filter within performance thresholds', async () => {
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get('/api/transactions?type=deposit&limit=50')
          .set('x-user-id', testUserId)
          .expect(200)
        
        expect(response.body.data).toBeDefined()
      },
      thresholds
    )
    
    logPerformanceMetrics('transactions_list_with_filter', result)
    assertPerformance(result, 'transactions_list_with_filter')
    
    console.log(`✓ Transactions list (with filter): ${result.responseTime}ms`)
  })

  it('should list transactions with date range filter within performance thresholds', async () => {
    const now = new Date()
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get(`/api/transactions?date_from=${oneMonthAgo.toISOString()}&date_to=${now.toISOString()}&limit=50`)
          .set('x-user-id', testUserId)
          .expect(200)
        
        expect(response.body.data).toBeDefined()
      },
      thresholds
    )
    
    logPerformanceMetrics('transactions_list_date_range', result)
    assertPerformance(result, 'transactions_list_date_range')
    
    console.log(`✓ Transactions list (date range filter): ${result.responseTime}ms`)
  })

  it('should list transactions for specific vault within performance thresholds', async () => {
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get(`/api/transactions/vault/${testVaultId}?limit=50`)
          .set('x-user-id', testUserId)
          .expect(200)
        
        expect(response.body.data).toBeDefined()
      },
      thresholds
    )
    
    logPerformanceMetrics('transactions_list_by_vault', result)
    assertPerformance(result, 'transactions_list_by_vault')
    
    console.log(`✓ Transactions list (by vault): ${result.responseTime}ms`)
  })

  it('should handle deep pagination efficiently', async () => {
    // Simulate paginating through multiple pages
    let cursor: string | undefined
    let pageCount = 0
    const maxPages = 10 // Test first 10 pages (200 records)
    
    const result = await measurePerformance(
      async () => {
        while (pageCount < maxPages) {
          const url = cursor 
            ? `/api/transactions?limit=20&cursor=${cursor}`
            : '/api/transactions?limit=20'
          
          const response = await request(app)
            .get(url)
            .set('x-user-id', testUserId)
            .expect(200)
          
          cursor = response.body.pagination.next_cursor
          pageCount++
          
          if (!cursor) break
        }
      },
      { maxResponseTime: 5000 } // More lenient for multiple requests
    )
    
    logPerformanceMetrics('transactions_deep_pagination', result)
    assertPerformance(result, 'transactions_deep_pagination')
    
    console.log(`✓ Transactions deep pagination (${pageCount} pages): ${result.responseTime}ms`)
  })
})
