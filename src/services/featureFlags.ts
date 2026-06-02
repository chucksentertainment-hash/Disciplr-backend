import { db } from '../db/knex.js'

/**
 * Feature flag names that can be toggled at runtime
 * Add new flags here and seed them in the migration
 */
export enum FeatureFlag {
  ENTERPRISE_ANALYTICS = 'ENTERPRISE_ANALYTICS',
  MULTI_VERIFIER_ENABLED = 'MULTI_VERIFIER_ENABLED',
  ORGANIZATION_QUOTAS = 'ORGANIZATION_QUOTAS',
  ADVANCED_ANALYTICS = 'ADVANCED_ANALYTICS',
}

/**
 * LRU cache for feature flags to avoid excessive database queries
 * Cache entries expire after 5 minutes to balance freshness vs performance
 */
class FeatureFlagCache {
  private cache: Map<string, { value: boolean; timestamp: number }> = new Map()
  private readonly maxSize: number = 1000
  private readonly ttlMs: number = 5 * 60 * 1000 // 5 minutes

  set(key: string, value: boolean): void {
    // Evict oldest entry if cache is full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        this.cache.delete(firstKey)
      }
    }

    this.cache.set(key, { value, timestamp: Date.now() })
  }

  get(key: string): boolean | null {
    const entry = this.cache.get(key)

    if (!entry) {
      return null
    }

    // Check if entry has expired
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key)
      return null
    }

    return entry.value
  }

  invalidate(key: string): void {
    this.cache.delete(key)
  }

  invalidateAll(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }
}

const cache = new FeatureFlagCache()

/**
 * Generate cache key from flag name and organization ID
 * Format: "flag_name:org_id" or "flag_name:global" for org_id null
 */
function getCacheKey(name: string, orgId: string | null): string {
  return `${name}:${orgId || 'global'}`
}

/**
 * Get feature flag value for an organization with fallback to global setting
 *
 * Lookup order:
 * 1. Organization-specific override (if orgId provided and exists)
 * 2. Global default (org_id = null)
 * 3. Return false if flag doesn't exist
 *
 * Results are cached per-process with 5-minute TTL to balance
 * freshness vs performance.
 *
 * @param name - Feature flag name (from FeatureFlag enum)
 * @param orgId - Organization ID, or null for global lookup
 * @returns Promise<boolean> - Whether flag is enabled
 * @example
 *   // Check if enterprise analytics is enabled for org-123
 *   const enabled = await getFlag(FeatureFlag.ENTERPRISE_ANALYTICS, 'org-123')
 *
 *   // Check global default for a flag
 *   const globalEnabled = await getFlag(FeatureFlag.MULTI_VERIFIER_ENABLED, null)
 */
export async function getFlag(name: string, orgId: string | null): Promise<boolean> {
  // Try organization-specific flag first (if orgId provided)
  if (orgId) {
    const cacheKey = getCacheKey(name, orgId)
    const cached = cache.get(cacheKey)
    if (cached !== null) {
      return cached
    }

    try {
      const row = await db('feature_flags').where({ name, org_id: orgId }).first()
      if (row) {
        cache.set(cacheKey, row.enabled)
        return row.enabled
      }
    } catch (error) {
      console.error(`Error fetching org-specific flag ${name} for org ${orgId}:`, error)
    }
  }

  // Fall back to global default (org_id = null)
  const globalCacheKey = getCacheKey(name, null)
  const globalCached = cache.get(globalCacheKey)
  if (globalCached !== null) {
    return globalCached
  }

  try {
    const row = await db('feature_flags').where({ name, org_id: null }).first()
    const value = row?.enabled ?? false
    cache.set(globalCacheKey, value)
    return value
  } catch (error) {
    console.error(`Error fetching global flag ${name}:`, error)
    return false
  }
}

/**
 * Set feature flag value for an organization
 * If orgId is null, sets the global default
 * Updates cache immediately to reflect change
 *
 * @param name - Feature flag name
 * @param orgId - Organization ID, or null for global
 * @param enabled - Whether to enable the flag
 * @returns Promise<boolean> - The new value
 * @throws Error if database operation fails
 */
export async function setFlag(
  name: string,
  orgId: string | null,
  enabled: boolean,
): Promise<boolean> {
  try {
    // Use upsert pattern: try update first, then insert if no rows affected
    const updated = await db('feature_flags')
      .where({ name, org_id: orgId })
      .update({ enabled, updated_at: db.fn.now() })

    if (updated === 0) {
      // Row doesn't exist, insert it
      await db('feature_flags').insert({
        name,
        org_id: orgId,
        enabled,
        updated_at: db.fn.now(),
      })
    }

    // Invalidate cache for this flag to ensure freshness
    const cacheKey = getCacheKey(name, orgId)
    cache.invalidate(cacheKey)

    return enabled
  } catch (error) {
    console.error(`Error setting flag ${name} for org ${orgId}:`, error)
    throw error
  }
}

/**
 * Get all feature flags for an organization
 * Includes org-specific overrides and global defaults merged
 *
 * @param orgId - Organization ID
 * @returns Promise<Record<string, boolean>> - Map of flag names to enabled status
 */
export async function getAllFlags(orgId: string | null): Promise<Record<string, boolean>> {
  const flags: Record<string, boolean> = {}

  try {
    // Fetch global defaults
    const globalRows = await db('feature_flags').where({ org_id: null })
    for (const row of globalRows) {
      flags[row.name] = row.enabled
    }

    // If orgId provided, fetch and merge org-specific overrides
    if (orgId) {
      const orgRows = await db('feature_flags').where({ org_id: orgId })
      for (const row of orgRows) {
        flags[row.name] = row.enabled // Override global with org-specific
      }
    }

    return flags
  } catch (error) {
    console.error(`Error fetching all flags for org ${orgId}:`, error)
    return {}
  }
}

/**
 * Clear all cache entries (useful for testing or cache invalidation)
 * In production, consider using a more sophisticated cache invalidation strategy
 */
export function clearCache(): void {
  cache.invalidateAll()
}

/**
 * Get cache statistics for monitoring/debugging
 */
export function getCacheStats(): { size: number; maxSize: number } {
  return { size: cache.size(), maxSize: 1000 }
}

/**
 * Type guard for FeatureFlag enum
 */
export function isValidFeatureFlag(value: string): value is FeatureFlag {
  return Object.values(FeatureFlag).includes(value as FeatureFlag)
}
