import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import request from 'supertest'
import { app } from '../../app.js'
import { db } from '../../db/index.js'
import {
  measurePerformance,
  seedLargeDataset,
  generateTestUser,
  generateTestVault,
  cleanupPerfTestData,
  assertPerformance,
  logPerformanceMetrics,
  type PerformanceThresholds
} from '../helpers/performanceHelpers.js'

/**
 * Performance smoke tests for /api/vaults endpoint
 * 
 * These tests detect:
 * - N+1 query problems
 * - Missing indexes
 * - Slow response times with realistic data volumes
 * 
 * Thresholds are conservative to avoid flakiness in CI
 */

describe('GET /api/vaults - Performance Smoke Tests', () => {
  let testUserId: string
  const DATASET_SIZE = 1000 // 1k records for smoke testing
  
  // Conservative thresholds for CI stability
  const thresholds: PerformanceThresholds = {
    maxResponseTime: 2000, // 2 seconds max for 1k records
    maxQueryCount: 10 // Should not exceed ~10 queries regardless of dataset size
  }

  beforeAll(async () => {
    // Clean any existing perf test data
    await cleanupPerfTestData(db)
    
    // Create test user
    const users = await db('users').insert(generateTestUser(0)).returning('*')
    testUserId = users[0].id
    
    // Seed large dataset of vaults
    console.log(`Seeding ${DATASET_SIZE} vaults for performance testing...`)
    await seedLargeDataset(
      db,
      'vaults',
      DATASET_SIZE,
      (index) => generateTestVault(index, testUserId)
    )
    console.log('Seeding complete')
  }, 60000) // 60 second timeout for seeding

  afterAll(async () => {
    await cleanupPerfTestData(db)
    await db.destroy()
  })

  it('should list vaults within performance thresholds (no pagination)', async () => {
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get('/api/vaults')
          .set('x-user-id', testUserId)
          .set('x-user-role', 'USER')
          .expect(200)
        
        expect(response.body).toBeDefined()
        expect(Array.isArray(response.body) || Array.isArray(response.body.data)).toBe(true)
      },
      thresholds
    )
    
    logPerformanceMetrics('vaults_list_no_pagination', result)
    assertPerformance(result, 'vaults_list_no_pagination')
    
    // Log for CI monitoring
    console.log(`✓ Vaults list (no pagination): ${result.responseTime}ms`)
  })

  it('should list vaults with pagination within performance thresholds', async () => {
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get('/api/vaults?page=1&pageSize=50')
          .set('x-user-id', testUserId)
          .set('x-user-role', 'USER')
          .expect(200)
        
        expect(response.body).toBeDefined()
      },
      thresholds
    )
    
    logPerformanceMetrics('vaults_list_with_pagination', result)
    assertPerformance(result, 'vaults_list_with_pagination')
    
    console.log(`✓ Vaults list (with pagination): ${result.responseTime}ms`)
  })

  it('should list vaults with sorting within performance thresholds', async () => {
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get('/api/vaults?sortBy=createdAt&sortOrder=desc')
          .set('x-user-id', testUserId)
          .set('x-user-role', 'USER')
          .expect(200)
        
        expect(response.body).toBeDefined()
      },
      thresholds
    )
    
    logPerformanceMetrics('vaults_list_with_sorting', result)
    assertPerformance(result, 'vaults_list_with_sorting')
    
    console.log(`✓ Vaults list (with sorting): ${result.responseTime}ms`)
  })

  it('should list vaults with filtering within performance thresholds', async () => {
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get('/api/vaults?status=ACTIVE')
          .set('x-user-id', testUserId)
          .set('x-user-role', 'USER')
          .expect(200)
        
        expect(response.body).toBeDefined()
      },
      thresholds
    )
    
    logPerformanceMetrics('vaults_list_with_filtering', result)
    assertPerformance(result, 'vaults_list_with_filtering')
    
    console.log(`✓ Vaults list (with filtering): ${result.responseTime}ms`)
  })

  it('should list vaults with combined pagination, sorting, and filtering', async () => {
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get('/api/vaults?page=1&pageSize=20&sortBy=amount&sortOrder=desc&status=ACTIVE')
          .set('x-user-id', testUserId)
          .set('x-user-role', 'USER')
          .expect(200)
        
        expect(response.body).toBeDefined()
      },
      thresholds
    )
    
    logPerformanceMetrics('vaults_list_combined', result)
    assertPerformance(result, 'vaults_list_combined')
    
    console.log(`✓ Vaults list (combined operations): ${result.responseTime}ms`)
  })
})
