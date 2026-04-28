import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import request from 'supertest'
import { app } from '../../app.js'
import { db } from '../../db/index.js'
import {
  measurePerformance,
  cleanupPerfTestData,
  assertPerformance,
  logPerformanceMetrics,
  type PerformanceThresholds
} from '../helpers/performanceHelpers.js'

/**
 * Performance smoke tests for /api/analytics endpoints
 * 
 * These tests detect:
 * - Slow aggregation queries
 * - Missing indexes on analytical queries
 * - Performance degradation with date range filters
 * 
 * Note: Analytics endpoints may use in-memory data or cached results,
 * so these tests focus on response time rather than query count
 */

describe('Analytics Endpoints - Performance Smoke Tests', () => {
  let testApiKey: string
  
  // Conservative thresholds for CI stability
  const thresholds: PerformanceThresholds = {
    maxResponseTime: 1000 // 1 second max for analytics queries
  }

  beforeAll(async () => {
    // Clean any existing perf test data
    await cleanupPerfTestData(db)
    
    // Create test API key for analytics endpoints
    const apiKeys = await db('api_keys').insert({
      key: 'test-analytics-key-perf',
      name: 'Performance Test Key',
      scopes: JSON.stringify(['read:analytics', 'read:vaults']),
      created_at: new Date(),
      expires_at: new Date(Date.now() + 86400000) // +1 day
    }).returning('*')
    
    testApiKey = apiKeys[0].key
  })

  afterAll(async () => {
    await db('api_keys').where('key', testApiKey).del()
    await cleanupPerfTestData(db)
    await db.destroy()
  })

  it('should return analytics summary within performance thresholds', async () => {
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get('/api/analytics/summary')
          .set('x-user-id', 'test-user')
          .set('x-user-role', 'USER')
          .expect(200)
        
        expect(response.body).toBeDefined()
        expect(response.body.total_vaults).toBeDefined()
      },
      thresholds
    )
    
    logPerformanceMetrics('analytics_summary', result)
    assertPerformance(result, 'analytics_summary')
    
    console.log(`✓ Analytics summary: ${result.responseTime}ms`)
  })

  it('should return analytics overview within performance thresholds', async () => {
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get('/api/analytics/overview')
          .set('x-api-key', testApiKey)
          .expect(200)
        
        expect(response.body).toBeDefined()
        expect(response.body.status).toBe('ok')
      },
      thresholds
    )
    
    logPerformanceMetrics('analytics_overview', result)
    assertPerformance(result, 'analytics_overview')
    
    console.log(`✓ Analytics overview: ${result.responseTime}ms`)
  })

  it('should return vaults analytics within performance thresholds', async () => {
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get('/api/analytics/vaults')
          .set('x-api-key', testApiKey)
          .expect(200)
        
        expect(response.body).toBeDefined()
        expect(response.body.vaults).toBeDefined()
      },
      thresholds
    )
    
    logPerformanceMetrics('analytics_vaults', result)
    assertPerformance(result, 'analytics_vaults')
    
    console.log(`✓ Analytics vaults: ${result.responseTime}ms`)
  })

  it('should return vault-specific analytics within performance thresholds', async () => {
    const testVaultId = 'test-vault-123'
    
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get(`/api/analytics/vaults/${testVaultId}`)
          .set('x-user-id', 'test-user')
          .set('x-user-role', 'USER')
          .expect(200)
        
        expect(response.body).toBeDefined()
        expect(response.body.vault_id).toBe(testVaultId)
      },
      thresholds
    )
    
    logPerformanceMetrics('analytics_vault_specific', result)
    assertPerformance(result, 'analytics_vault_specific')
    
    console.log(`✓ Analytics vault-specific: ${result.responseTime}ms`)
  })

  it('should return milestone trends with date range within performance thresholds', async () => {
    const now = new Date()
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get(`/api/analytics/milestones/trends?from=${oneMonthAgo.toISOString()}&to=${now.toISOString()}&groupBy=day`)
          .set('x-api-key', testApiKey)
          .expect(200)
        
        expect(response.body).toBeDefined()
        expect(response.body.buckets).toBeDefined()
      },
      thresholds
    )
    
    logPerformanceMetrics('analytics_milestone_trends', result)
    assertPerformance(result, 'analytics_milestone_trends')
    
    console.log(`✓ Analytics milestone trends: ${result.responseTime}ms`)
  })

  it('should return behavior analytics within performance thresholds', async () => {
    const now = new Date()
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get(`/api/analytics/behavior?userId=test-user&from=${oneMonthAgo.toISOString()}&to=${now.toISOString()}`)
          .set('x-api-key', testApiKey)
          .expect(200)
        
        expect(response.body).toBeDefined()
        expect(response.body.userId).toBe('test-user')
      },
      thresholds
    )
    
    logPerformanceMetrics('analytics_behavior', result)
    assertPerformance(result, 'analytics_behavior')
    
    console.log(`✓ Analytics behavior: ${result.responseTime}ms`)
  })

  it('should handle weekly grouping for milestone trends efficiently', async () => {
    const now = new Date()
    const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    
    const result = await measurePerformance(
      async () => {
        const response = await request(app)
          .get(`/api/analytics/milestones/trends?from=${threeMonthsAgo.toISOString()}&to=${now.toISOString()}&groupBy=week`)
          .set('x-api-key', testApiKey)
          .expect(200)
        
        expect(response.body).toBeDefined()
        expect(response.body.groupBy).toBe('week')
      },
      thresholds
    )
    
    logPerformanceMetrics('analytics_milestone_trends_weekly', result)
    assertPerformance(result, 'analytics_milestone_trends_weekly')
    
    console.log(`✓ Analytics milestone trends (weekly): ${result.responseTime}ms`)
  })
})
