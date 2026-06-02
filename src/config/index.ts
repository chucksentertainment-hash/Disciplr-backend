import { initEnv, getEnv, type Env, type EnvWarning } from './env.js'

export { initEnv, getEnv, type Env, type EnvWarning }

/**
 * Resolves the list of allowed CORS origins from the CORS_ORIGINS env var.
 */
export function parseCorsOrigins(value: string | undefined, env: string): string[] | '*' {
  if (value !== undefined) {
    if (value.trim() === '*') return '*'
    return value
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean)
  }

  if (env === 'production') {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'security.cors_misconfiguration',
        service: 'disciplr-backend',
        message:
          'CORS_ORIGINS is not configured in production — all cross-origin requests will be blocked. Set CORS_ORIGINS to the allowed frontend origin(s).',
        timestamp: new Date().toISOString(),
      }),
    )
    return []
  }

  return ['http://localhost:3000']
}

/** Reset internal state — exposed for tests only. */
export function _resetEnvForTesting(): void {
  // We need to be able to reset this. Since _validated is in env.ts,
  // we should export a reset function there too if needed, or
  // just handle it here if possible. 
  // Given the current structure, I will add a reset function to env.ts
}

// NOTE: The 'config' object export below should be removed once all 
// usages are migrated to getEnv().X
