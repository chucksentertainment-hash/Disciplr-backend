import { Pool } from 'pg'
import { db } from '../db/index.js'

/**
 * Slow query tracking configuration
 * Tracks queries exceeding threshold for operational insights
 */
interface SlowQuerySample {
  queryHash: string
  duration: number
  queryPattern: string
  count: number
  lastOccurred: Date
}

interface PoolMetrics {
  availableConnections: number
  waitingClients: number
  totalConnections: number
  poolSize: {
    min: number
    max: number
  }
  timestamp: Date
}

interface DBHealthMetrics {
  pool: PoolMetrics
  slowQueries: SlowQuerySample[]
  isHealthy: boolean
  warnings: string[]
}

/**
 * In-memory slow query tracker
 * Stores aggregated query performance data without storing raw SQL
 */
class SlowQueryTracker {
  private queries: Map<string, SlowQuerySample> = new Map()
  private readonly maxSamples = 50
  private readonly thresholdMs = 100 // Log queries exceeding 100ms

  /**
   * Hash a query pattern to aggregate similar queries
   * Removes specific values to normalize queries
   */
  private hashQueryPattern(query: string): { hash: string; pattern: string } {
    // Sanitize query: remove values, parameters, and PII patterns
    let normalized = query
      // Remove quoted strings and string values
      .replace(/'[^']*'/g, "'{value}'")
      // Remove numeric values
      .replace(/\d+/g, '{num}')
      // Remove email patterns (PII protection)
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '{email}')
      // Remove UUIDs
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '{uuid}')
      // Normalize whitespace
      .replace(/\s+/g, ' ')
      .trim()

    // Simple hash via character sum (not cryptographic, just for aggregation)
    const hash = Array.from(normalized).reduce(
      (h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0,
      0
    ).toString(16)

    return { hash, pattern: normalized.substring(0, 150) } // Limit pattern length
  }

  /**
   * Record a query execution time
   */
  recordQuery(query: string, durationMs: number): void {
    if (durationMs < this.thresholdMs) return

    const { hash, pattern } = this.hashQueryPattern(query)
    const existing = this.queries.get(hash)

    if (existing) {
      existing.count += 1
      existing.duration = Math.max(existing.duration, durationMs)
      existing.lastOccurred = new Date()
    } else {
      if (this.queries.size >= this.maxSamples) {
        // Remove oldest entry when at capacity
        const oldest = Array.from(this.queries.values()).sort(
          (a, b) => a.lastOccurred.getTime() - b.lastOccurred.getTime()
        )[0]
        if (oldest) {
          this.queries.delete(oldest.queryHash)
        }
      }

      this.queries.set(hash, {
        queryHash: hash,
        duration: durationMs,
        queryPattern: pattern,
        count: 1,
        lastOccurred: new Date(),
      })
    }
  }

  /**
   * Get aggregated slow queries, sorted by total impact
   */
  getSamples(limit: number = 20): SlowQuerySample[] {
    return Array.from(this.queries.values())
      .sort((a, b) => b.duration * b.count - a.duration * a.count)
      .slice(0, limit)
  }

  /**
   * Clear tracker (useful for tests)
   */
  clear(): void {
    this.queries.clear()
  }
}

// Global tracker instance
const slowQueryTracker = new SlowQueryTracker()

/**
 * Extract pool statistics from pg.Pool
 * Safely accesses pool internals without exposing sensitive data
 */
function getPoolStats(pool: any): PoolMetrics {
  // pg.Pool stores client information in private properties
  const idleClients = pool._idle?.length ?? 0
  const waitingClients = pool._waitingClients?.length ?? 0
  const allClients = pool._clients?.length ?? idleClients + waitingClients

  // Get configuration (should always be available)
  const poolConfig = pool.options || pool.config || {}
  const max = poolConfig.max ?? 10
  const min = poolConfig.min ?? 2

  return {
    availableConnections: Math.max(0, idleClients),
    waitingClients: Math.max(0, waitingClients),
    totalConnections: Math.max(0, allClients ?? idleClients + waitingClients),
    poolSize: {
      min: min,
      max: max,
    },
    timestamp: new Date(),
  }
}

/**
 * Get comprehensive database health metrics
 * @param pgPool - PostgreSQL pool instance
 * @returns Health metrics including pool stats and slow queries
 */
export function getDBHealthMetrics(pgPool: Pool): DBHealthMetrics {
  const poolMetrics = getPoolStats(pgPool)
  const slowQueries = slowQueryTracker.getSamples(20)

  // Generate warnings based on pool health
  const warnings: string[] = []

  if (poolMetrics.availableConnections === 0) {
    warnings.push('No idle connections available - pool may be under stress')
  }

  if (poolMetrics.waitingClients > 0) {
    warnings.push(`${poolMetrics.waitingClients} clients waiting for connections`)
  }

  if (poolMetrics.totalConnections >= poolMetrics.poolSize.max * 0.9) {
    warnings.push('Pool is at 90% capacity - consider scaling')
  }

  if (slowQueries.length > 10) {
    warnings.push(`High number of slow queries detected (${slowQueries.length})`)
  }

  const isHealthy = warnings.length === 0 && poolMetrics.availableConnections > 0

  return {
    pool: poolMetrics,
    slowQueries,
    isHealthy,
    warnings,
  }
}

/**
 * Record slow query for monitoring
 * Call this from database query middleware
 * @param query - Query string (will be normalized)
 * @param durationMs - Query duration in milliseconds
 */
export function recordSlowQuery(query: string, durationMs: number): void {
  slowQueryTracker.recordQuery(query, durationMs)
}

/**
 * Reset slow query tracker
 * Useful for testing or starting fresh monitoring
 */
export function resetSlowQueryTracker(): void {
  slowQueryTracker.clear()
}

/**
 * Get active slow queries
 * @returns Array of slow query samples
 */
export function getSlowQueries(limit: number = 20): SlowQuerySample[] {
  return slowQueryTracker.getSamples(limit)
}

export { SlowQueryTracker, PoolMetrics, DBHealthMetrics, SlowQuerySample }
