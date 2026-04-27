import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { validateEnv, envSchema } from '../config/env.js'
import { initEnv, getEnv, _resetEnvForTesting, parseCorsOrigins } from '../config/index.js'
import {
  loadHorizonListenerConfig,
  validateHorizonListenerConfig,
  getValidatedConfig,
} from '../config/horizonListener.js'

/** Minimal valid env record — every required field present. */
const validEnv: Record<string, string> = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/disciplr',
}

describe('envSchema', () => {
  it('should accept a minimal valid env with only DATABASE_URL', () => {
    const result = envSchema.safeParse(validEnv)
    expect(result.success).toBe(true)
  })

  it('should apply correct defaults for optional fields', () => {
    const result = envSchema.safeParse(validEnv)
    expect(result.success).toBe(true)
    if (!result.success) return

    const env = result.data
    expect(env.NODE_ENV).toBe('development')
    expect(env.PORT).toBe(3000)
    expect(env.SERVICE_NAME).toBe('disciplr-backend')
    expect(env.JWT_SECRET).toBe('change-me-in-production-long-secret')
    expect(env.JWT_ACCESS_SECRET).toBe('fallback-access-secret-long')
    expect(env.JWT_REFRESH_SECRET).toBe('fallback-refresh-secret-long')
    expect(env.JWT_ACCESS_EXPIRES_IN).toBe('15m')
    expect(env.JWT_REFRESH_EXPIRES_IN).toBe('7d')
    expect(env.DOWNLOAD_SECRET).toBe('change-me-in-production-long-secret')
    expect(env.RETRY_MAX_ATTEMPTS).toBe(3)
    expect(env.RETRY_BACKOFF_MS).toBe(100)
    expect(env.HORIZON_SHUTDOWN_TIMEOUT_MS).toBe(30_000)
    expect(env.HORIZON_LAG_THRESHOLD).toBe(10)
    expect(env.JOB_WORKER_CONCURRENCY).toBe(2)
    expect(env.JOB_QUEUE_POLL_INTERVAL_MS).toBe(250)
    expect(env.JOB_HISTORY_LIMIT).toBe(50)
    expect(env.ETL_INTERVAL_MINUTES).toBe(5)
  })

  it('should reject when DATABASE_URL is missing', () => {
    const result = envSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('should reject when DATABASE_URL is an empty string', () => {
    const result = envSchema.safeParse({ DATABASE_URL: '' })
    expect(result.success).toBe(false)
  })

  it('should reject an invalid NODE_ENV value', () => {
    const result = envSchema.safeParse({ ...validEnv, NODE_ENV: 'staging' })
    expect(result.success).toBe(false)
  })

  it('should accept valid NODE_ENV values', () => {
    for (const env of ['development', 'production', 'test']) {
      const result = envSchema.safeParse({ ...validEnv, NODE_ENV: env })
      expect(result.success).toBe(true)
    }
  })

  it('should coerce PORT from string to number', () => {
    const result = envSchema.safeParse({ ...validEnv, PORT: '8080' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.PORT).toBe(8080)
    }
  })

  it('should fall back to default when PORT is not a valid number', () => {
    const result = envSchema.safeParse({ ...validEnv, PORT: 'abc' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.PORT).toBe(3000)
    }
  })

  it('should fall back to default when PORT is zero or negative', () => {
    for (const val of ['0', '-1']) {
      const result = envSchema.safeParse({ ...validEnv, PORT: val })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.PORT).toBe(3000)
      }
    }
  })

  it('should fall back to default when PORT is empty string', () => {
    const result = envSchema.safeParse({ ...validEnv, PORT: '' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.PORT).toBe(3000)
    }
  })

  it('should coerce JOB_WORKER_CONCURRENCY from string', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      JOB_WORKER_CONCURRENCY: '4',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.JOB_WORKER_CONCURRENCY).toBe(4)
    }
  })

  it('should fall back to default for non-numeric JOB_WORKER_CONCURRENCY', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      JOB_WORKER_CONCURRENCY: 'not-a-number',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.JOB_WORKER_CONCURRENCY).toBe(2)
    }
  })

  it('should coerce RETRY_MAX_ATTEMPTS as non-negative int', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      RETRY_MAX_ATTEMPTS: '0',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.RETRY_MAX_ATTEMPTS).toBe(0)
    }
  })

  it('should fall back for negative RETRY_MAX_ATTEMPTS', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      RETRY_MAX_ATTEMPTS: '-5',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.RETRY_MAX_ATTEMPTS).toBe(3)
    }
  })

  it('should leave optional string fields as undefined when absent', () => {
    const result = envSchema.safeParse(validEnv)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.CORS_ORIGINS).toBeUndefined()
      expect(result.data.HORIZON_URL).toBeUndefined()
      expect(result.data.CONTRACT_ADDRESS).toBeUndefined()
      expect(result.data.SOROBAN_CONTRACT_ID).toBeUndefined()
    }
  })

  it('should preserve explicit string values for optional fields', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      CORS_ORIGINS: 'https://app.example.com',
      HORIZON_URL: 'https://horizon.stellar.org',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.CORS_ORIGINS).toBe('https://app.example.com')
      expect(result.data.HORIZON_URL).toBe('https://horizon.stellar.org')
    }
  })

  it('should reject empty string CORS_ORIGINS', () => {
    const result = envSchema.safeParse({ ...validEnv, CORS_ORIGINS: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('cannot be empty')
    }
  })
})

// ── DATABASE_URL format validation ───────────────────────────────────────────

describe('DATABASE_URL format validation', () => {
  it('should accept postgres:// URLs', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgres://user:pass@localhost:5432/mydb',
    })
    expect(result.success).toBe(true)
  })

  it('should accept postgresql:// URLs', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/mydb',
    })
    expect(result.success).toBe(true)
  })

  it('should reject DATABASE_URL with an http:// scheme', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'http://localhost:5432/mydb',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('PostgreSQL connection URL')
    }
  })

  it('should reject DATABASE_URL with a mysql:// scheme', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'mysql://user:pass@localhost:3306/mydb',
    })
    expect(result.success).toBe(false)
  })

  it('should reject a bare hostname without a scheme', () => {
    const result = envSchema.safeParse({ DATABASE_URL: 'localhost:5432/mydb' })
    expect(result.success).toBe(false)
  })
})

// ── HORIZON_URL format validation ────────────────────────────────────────────

describe('HORIZON_URL format validation', () => {
  it('should accept https:// URLs', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
    })
    expect(result.success).toBe(true)
  })

  it('should accept http:// URLs', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      HORIZON_URL: 'http://localhost:8000',
    })
    expect(result.success).toBe(true)
  })

  it('should reject a non-HTTP URL when HORIZON_URL is provided', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      HORIZON_URL: 'ftp://horizon.example.com',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('HTTP or HTTPS URL')
    }
  })

  it('should reject a bare hostname for HORIZON_URL', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      HORIZON_URL: 'horizon.stellar.org',
    })
    expect(result.success).toBe(false)
  })

  it('should accept undefined HORIZON_URL (optional)', () => {
    const result = envSchema.safeParse(validEnv)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.HORIZON_URL).toBeUndefined()
    }
  })
})

// ── CORS_ORIGINS format validation ───────────────────────────────────────────

describe('CORS_ORIGINS format validation', () => {
  it('should accept "*"', () => {
    const result = envSchema.safeParse({ ...validEnv, CORS_ORIGINS: '*' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.CORS_ORIGINS).toBe('*')
  })

  it('should accept a single valid https origin', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      CORS_ORIGINS: 'https://app.example.com',
    })
    expect(result.success).toBe(true)
  })

  it('should accept multiple comma-separated valid origins', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      CORS_ORIGINS: 'https://app.example.com,https://admin.example.com',
    })
    expect(result.success).toBe(true)
  })

  it('should accept http:// origins', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      CORS_ORIGINS: 'http://localhost:3000',
    })
    expect(result.success).toBe(true)
  })

  it('should reject a non-URL origin', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      CORS_ORIGINS: 'not-a-url',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('CORS_ORIGINS')
    }
  })

  it('should reject an ftp:// origin', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      CORS_ORIGINS: 'ftp://files.example.com',
    })
    expect(result.success).toBe(false)
  })

  it('should reject an empty string for CORS_ORIGINS', () => {
    const result = envSchema.safeParse({ ...validEnv, CORS_ORIGINS: '' })
    expect(result.success).toBe(false)
  })

  it('should reject a list where one origin is invalid', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      CORS_ORIGINS: 'https://valid.example.com,not-valid',
    })
    expect(result.success).toBe(false)
  })
})

// ── JWT expiry format validation ──────────────────────────────────────────────

describe('JWT expiry format validation', () => {
  it('should accept valid duration strings for JWT_ACCESS_EXPIRES_IN', () => {
    for (const v of ['15m', '1h', '30s', '7d', '120m']) {
      const result = envSchema.safeParse({ ...validEnv, JWT_ACCESS_EXPIRES_IN: v })
      expect(result.success).toBe(true)
    }
  })

  it('should reject invalid JWT_ACCESS_EXPIRES_IN formats', () => {
    for (const v of ['15 min', '1hour', 'forever', '', '1w', '1y']) {
      const result = envSchema.safeParse({ ...validEnv, JWT_ACCESS_EXPIRES_IN: v })
      expect(result.success).toBe(false)
    }
  })

  it('should accept valid duration strings for JWT_REFRESH_EXPIRES_IN', () => {
    for (const v of ['7d', '30d', '1h', '60m']) {
      const result = envSchema.safeParse({ ...validEnv, JWT_REFRESH_EXPIRES_IN: v })
      expect(result.success).toBe(true)
    }
  })

  it('should reject invalid JWT_REFRESH_EXPIRES_IN formats', () => {
    for (const v of ['7 days', 'week', '1week', '']) {
      const result = envSchema.safeParse({ ...validEnv, JWT_REFRESH_EXPIRES_IN: v })
      expect(result.success).toBe(false)
    }
  })

  it('should use default 15m and 7d when expiry vars are absent', () => {
    const result = envSchema.safeParse(validEnv)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.JWT_ACCESS_EXPIRES_IN).toBe('15m')
      expect(result.data.JWT_REFRESH_EXPIRES_IN).toBe('7d')
    }
  })
})

// ── JWT secret minimum length ─────────────────────────────────────────────────

describe('JWT secret minimum length', () => {
  it('should reject JWT_SECRET shorter than 16 characters', () => {
    const result = envSchema.safeParse({ ...validEnv, JWT_SECRET: 'tooshort' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('16 characters')
    }
  })

  it('should accept JWT_SECRET of exactly 16 characters', () => {
    const result = envSchema.safeParse({ ...validEnv, JWT_SECRET: 'exactly16chars!!' })
    expect(result.success).toBe(true)
  })

  it('should reject JWT_ACCESS_SECRET shorter than 16 characters', () => {
    const result = envSchema.safeParse({ ...validEnv, JWT_ACCESS_SECRET: 'short' })
    expect(result.success).toBe(false)
  })

  it('should reject JWT_REFRESH_SECRET shorter than 16 characters', () => {
    const result = envSchema.safeParse({ ...validEnv, JWT_REFRESH_SECRET: 'short' })
    expect(result.success).toBe(false)
  })

  it('should reject DOWNLOAD_SECRET shorter than 16 characters', () => {
    const result = envSchema.safeParse({ ...validEnv, DOWNLOAD_SECRET: 'tiny' })
    expect(result.success).toBe(false)
  })

  it('should accept all secrets when they meet the minimum length', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      JWT_SECRET: 'production-secret-key-long-enough',
      JWT_ACCESS_SECRET: 'access-secret-key-long-enough',
      JWT_REFRESH_SECRET: 'refresh-secret-key-long-enough',
      DOWNLOAD_SECRET: 'download-secret-key-long-enough',
    })
    expect(result.success).toBe(true)
  })
})

// ── Horizon / Stellar schema fields ──────────────────────────────────────────

describe('Horizon schema fields', () => {
  it('should apply HORIZON_SHUTDOWN_TIMEOUT_MS default of 30000', () => {
    const result = envSchema.safeParse(validEnv)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.HORIZON_SHUTDOWN_TIMEOUT_MS).toBe(30_000)
    }
  })

  it('should coerce HORIZON_SHUTDOWN_TIMEOUT_MS from string', () => {
    const result = envSchema.safeParse({ ...validEnv, HORIZON_SHUTDOWN_TIMEOUT_MS: '60000' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.HORIZON_SHUTDOWN_TIMEOUT_MS).toBe(60_000)
    }
  })

  it('should apply HORIZON_LAG_THRESHOLD default of 10', () => {
    const result = envSchema.safeParse(validEnv)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.HORIZON_LAG_THRESHOLD).toBe(10)
    }
  })

  it('should coerce HORIZON_LAG_THRESHOLD from string', () => {
    const result = envSchema.safeParse({ ...validEnv, HORIZON_LAG_THRESHOLD: '25' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.HORIZON_LAG_THRESHOLD).toBe(25)
    }
  })

  it('should accept zero for HORIZON_LAG_THRESHOLD', () => {
    const result = envSchema.safeParse({ ...validEnv, HORIZON_LAG_THRESHOLD: '0' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.HORIZON_LAG_THRESHOLD).toBe(0)
    }
  })
})

// ── validateEnv ───────────────────────────────────────────────────────────────

describe('validateEnv', () => {
  let mockExit: ReturnType<typeof jest.spyOn>
  let mockConsoleError: ReturnType<typeof jest.spyOn>
  let mockConsoleWarn: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    mockExit = jest.spyOn(process, 'exit').mockImplementation(
      (code?: string | number | null | undefined) => {
        throw new Error(`process.exit: ${code}`)
      },
    )
    mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    mockExit.mockRestore()
    mockConsoleError.mockRestore()
    mockConsoleWarn.mockRestore()
  })

  it('should return validated env on valid input', () => {
    const { env, warnings } = validateEnv(validEnv)

    expect(env.DATABASE_URL).toBe('postgres://user:pass@localhost:5432/disciplr')
    expect(env.NODE_ENV).toBe('development')
    expect(warnings).toHaveLength(0)
  })

  it('should exit with code 1 when DATABASE_URL is missing', () => {
    expect(() => validateEnv({})).toThrow('process.exit: 1')
    expect(mockConsoleError).toHaveBeenCalledTimes(1)

    const loggedArg = (mockConsoleError.mock.calls[0] as string[])[0]
    const parsed = JSON.parse(loggedArg)
    expect(parsed.level).toBe('fatal')
    expect(parsed.event).toBe('config.env_validation_failed')
  })

  it('should not leak sensitive env values in error output', () => {
    expect(() => validateEnv({})).toThrow('process.exit: 1')
    const loggedArg = (mockConsoleError.mock.calls[0] as string[])[0]
    expect(loggedArg).not.toContain('postgres://')
    expect(loggedArg).not.toContain('secret')
  })

  it('should exit with code 1 when DATABASE_URL is empty', () => {
    expect(() => validateEnv({ DATABASE_URL: '' })).toThrow('process.exit: 1')
  })

  it('should exit with code 1 when DATABASE_URL has wrong scheme', () => {
    expect(() =>
      validateEnv({ DATABASE_URL: 'mysql://user:pass@localhost:3306/db' }),
    ).toThrow('process.exit: 1')
  })

  it('should exit with code 1 for invalid NODE_ENV', () => {
    expect(() =>
      validateEnv({ ...validEnv, NODE_ENV: 'invalid' }),
    ).toThrow('process.exit: 1')
  })

  it('should exit with code 1 for invalid CORS_ORIGINS', () => {
    expect(() =>
      validateEnv({ ...validEnv, CORS_ORIGINS: 'not-a-valid-origin' }),
    ).toThrow('process.exit: 1')
  })

  it('should exit with code 1 for invalid HORIZON_URL', () => {
    expect(() =>
      validateEnv({ ...validEnv, HORIZON_URL: 'ftp://invalid' }),
    ).toThrow('process.exit: 1')
  })

  it('should exit with code 1 for too-short JWT_SECRET', () => {
    expect(() =>
      validateEnv({ ...validEnv, JWT_SECRET: 'tooshort' }),
    ).toThrow('process.exit: 1')
  })

  it('should exit with code 1 for invalid JWT_ACCESS_EXPIRES_IN', () => {
    expect(() =>
      validateEnv({ ...validEnv, JWT_ACCESS_EXPIRES_IN: '15 minutes' }),
    ).toThrow('process.exit: 1')
  })

  it('should emit structured JSON error log on failure', () => {
    expect(() => validateEnv({})).toThrow('process.exit: 1')

    expect(mockConsoleError).toHaveBeenCalledTimes(1)
    const loggedArg = (mockConsoleError.mock.calls[0] as string[])[0]
    const parsed = JSON.parse(loggedArg)

    expect(parsed).toMatchObject({
      level: 'fatal',
      event: 'config.env_validation_failed',
      service: 'disciplr-backend',
    })
    expect(parsed.errors).toBeInstanceOf(Array)
    expect(parsed.errors.length).toBeGreaterThan(0)
    expect(parsed.timestamp).toBeDefined()
  })

  describe('production secret warnings', () => {
    const prodEnv: Record<string, string> = {
      ...validEnv,
      NODE_ENV: 'production',
    }

    it('should warn about insecure JWT_SECRET default in production', () => {
      const { warnings } = validateEnv(prodEnv)

      const jwtWarning = warnings.find((w) => w.variable === 'JWT_SECRET')
      expect(jwtWarning).toBeDefined()
      expect(jwtWarning!.message).toContain('insecure default')
      expect(mockConsoleWarn).toHaveBeenCalled()
    })

    it('should warn about all insecure defaults in production', () => {
      const { warnings } = validateEnv(prodEnv)

      const warnedVars = warnings.map((w) => w.variable)
      expect(warnedVars).toContain('JWT_SECRET')
      expect(warnedVars).toContain('JWT_ACCESS_SECRET')
      expect(warnedVars).toContain('JWT_REFRESH_SECRET')
      expect(warnedVars).toContain('DOWNLOAD_SECRET')
    })

    it('should not warn when secrets are explicitly set in production', () => {
      const { warnings } = validateEnv({
        ...prodEnv,
        JWT_SECRET: 'super-secret-production-key',
        JWT_ACCESS_SECRET: 'prod-access-secret-long',
        JWT_REFRESH_SECRET: 'prod-refresh-secret-long',
        DOWNLOAD_SECRET: 'prod-download-secret-long',
      })

      expect(warnings).toHaveLength(0)
      expect(mockConsoleWarn).not.toHaveBeenCalled()
    })

    it('should not warn about secrets in development mode', () => {
      const { warnings } = validateEnv(validEnv)
      expect(warnings).toHaveLength(0)
    })

    it('should emit structured JSON warn log per insecure secret', () => {
      validateEnv(prodEnv)

      const warnCalls = mockConsoleWarn.mock.calls
      expect(warnCalls.length).toBe(4)

      for (const call of warnCalls) {
        const parsed = JSON.parse(call[0] as string)
        expect(parsed.level).toBe('warn')
        expect(parsed.event).toBe('config.insecure_default')
        expect(parsed.service).toBe('disciplr-backend')
        expect(parsed.variable).toBeDefined()
      }
    })
  })
})

// ── initEnv / getEnv ──────────────────────────────────────────────────────────

describe('initEnv / getEnv', () => {
  const originalEnv = process.env

  beforeEach(() => {
    _resetEnvForTesting()
    process.env = {
      ...originalEnv,
      DATABASE_URL: 'postgres://test@localhost/test',
    }
  })

  afterEach(() => {
    _resetEnvForTesting()
    process.env = originalEnv
  })

  it('should populate getEnv after initEnv is called', () => {
    initEnv()
    const env = getEnv()
    expect(env.DATABASE_URL).toBe('postgres://test@localhost/test')
  })

  it('should throw if getEnv is called before initEnv', () => {
    expect(() => getEnv()).toThrow('Environment not validated yet')
  })

  it('should be idempotent — second call returns same result', () => {
    const first = initEnv()
    const second = initEnv()
    expect(first.env).toBe(second.env)
  })

  it('should accept a custom env record override', () => {
    const { env } = initEnv({
      DATABASE_URL: 'postgres://custom@localhost/custom',
    })
    expect(env.DATABASE_URL).toBe('postgres://custom@localhost/custom')
  })
})

// ── parseCorsOrigins ──────────────────────────────────────────────────────────

describe('parseCorsOrigins', () => {
  let mockConsoleWarn: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    mockConsoleWarn.mockRestore()
  })

  it('should return "*" when value is exactly "*"', () => {
    expect(parseCorsOrigins('*', 'development')).toBe('*')
  })

  it('should return "*" when value is "* " with surrounding whitespace', () => {
    expect(parseCorsOrigins('  *  ', 'development')).toBe('*')
  })

  it('should parse a single origin', () => {
    const result = parseCorsOrigins('https://app.example.com', 'development')
    expect(result).toEqual(['https://app.example.com'])
  })

  it('should parse comma-separated origins and trim whitespace', () => {
    const result = parseCorsOrigins(
      'https://app.example.com , https://admin.example.com',
      'production',
    )
    expect(result).toEqual(['https://app.example.com', 'https://admin.example.com'])
  })

  it('should filter out empty entries from the list', () => {
    const result = parseCorsOrigins('https://app.example.com,,https://b.example.com', 'production')
    expect(result).toEqual(['https://app.example.com', 'https://b.example.com'])
  })

  it('should return [] and log a warning in production when value is undefined', () => {
    const result = parseCorsOrigins(undefined, 'production')
    expect(result).toEqual([])
    expect(mockConsoleWarn).toHaveBeenCalledTimes(1)
    const log = JSON.parse((mockConsoleWarn.mock.calls[0] as string[])[0])
    expect(log.event).toBe('security.cors_misconfiguration')
    expect(log.level).toBe('warn')
  })

  it('should return [http://localhost:3000] in development when value is undefined', () => {
    const result = parseCorsOrigins(undefined, 'development')
    expect(result).toEqual(['http://localhost:3000'])
    expect(mockConsoleWarn).not.toHaveBeenCalled()
  })

  it('should return [http://localhost:3000] in test mode when value is undefined', () => {
    const result = parseCorsOrigins(undefined, 'test')
    expect(result).toEqual(['http://localhost:3000'])
    expect(mockConsoleWarn).not.toHaveBeenCalled()
  })
})

// ── horizonListener ───────────────────────────────────────────────────────────

describe('horizonListener', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('loadHorizonListenerConfig', () => {
    it('should load all values from environment variables', () => {
      process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org'
      process.env.CONTRACT_ADDRESS = 'CABC123,CDEF456'
      process.env.START_LEDGER = '1000000'
      process.env.RETRY_MAX_ATTEMPTS = '5'
      process.env.RETRY_BACKOFF_MS = '200'
      process.env.HORIZON_SHUTDOWN_TIMEOUT_MS = '60000'
      process.env.HORIZON_LAG_THRESHOLD = '20'

      const config = loadHorizonListenerConfig()

      expect(config.horizonUrl).toBe('https://horizon-testnet.stellar.org')
      expect(config.contractAddresses).toEqual(['CABC123', 'CDEF456'])
      expect(config.startLedger).toBe(1_000_000)
      expect(config.retryMaxAttempts).toBe(5)
      expect(config.retryBackoffMs).toBe(200)
      expect(config.shutdownTimeoutMs).toBe(60_000)
      expect(config.lagThreshold).toBe(20)
    })

    it('should use defaults for optional numeric values when absent', () => {
      process.env.HORIZON_URL = 'https://horizon.example.com'
      process.env.CONTRACT_ADDRESS = 'CABC123'
      delete process.env.RETRY_MAX_ATTEMPTS
      delete process.env.RETRY_BACKOFF_MS
      delete process.env.HORIZON_SHUTDOWN_TIMEOUT_MS
      delete process.env.HORIZON_LAG_THRESHOLD

      const config = loadHorizonListenerConfig()

      expect(config.retryMaxAttempts).toBe(3)
      expect(config.retryBackoffMs).toBe(100)
      expect(config.shutdownTimeoutMs).toBe(30_000)
      expect(config.lagThreshold).toBe(10)
    })

    it('should parse CONTRACT_ADDRESS as a trimmed comma-separated list', () => {
      process.env.CONTRACT_ADDRESS = ' CABC123 , CDEF456 , CGHI789 '

      const config = loadHorizonListenerConfig()
      expect(config.contractAddresses).toEqual(['CABC123', 'CDEF456', 'CGHI789'])
    })

    it('should return empty contractAddresses when CONTRACT_ADDRESS is unset', () => {
      delete process.env.CONTRACT_ADDRESS
      const config = loadHorizonListenerConfig()
      expect(config.contractAddresses).toEqual([])
    })

    it('should leave startLedger undefined when START_LEDGER is unset', () => {
      delete process.env.START_LEDGER
      const config = loadHorizonListenerConfig()
      expect(config.startLedger).toBeUndefined()
    })

    it('should set horizonUrl to empty string when HORIZON_URL is unset', () => {
      delete process.env.HORIZON_URL
      const config = loadHorizonListenerConfig()
      expect(config.horizonUrl).toBe('')
    })

    it('should include lagThreshold in the returned config (regression for undefined bug)', () => {
      process.env.HORIZON_LAG_THRESHOLD = '15'
      const config = loadHorizonListenerConfig()
      expect(config.lagThreshold).toBe(15)
    })

    it('should return NaN for non-numeric retry values, causing validation to fail', () => {
      process.env.HORIZON_URL = 'https://horizon.example.com'
      process.env.CONTRACT_ADDRESS = 'CABC123'
      process.env.RETRY_MAX_ATTEMPTS = 'not-a-number'

      const config = loadHorizonListenerConfig()
      expect(isNaN(config.retryMaxAttempts)).toBe(true)
    })
  })

  describe('validateHorizonListenerConfig', () => {
    let mockExit: ReturnType<typeof jest.spyOn>
    let mockConsoleError: ReturnType<typeof jest.spyOn>

    beforeEach(() => {
      mockExit = jest.spyOn(process, 'exit').mockImplementation(
        (code?: string | number | null | undefined) => {
          throw new Error(`process.exit: ${code}`)
        },
      )
      mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      mockExit.mockRestore()
      mockConsoleError.mockRestore()
    })

    const validConfig = {
      horizonUrl: 'https://horizon-testnet.stellar.org',
      contractAddresses: ['CABC123'],
      retryMaxAttempts: 3,
      retryBackoffMs: 100,
      shutdownTimeoutMs: 30_000,
      lagThreshold: 10,
    }

    it('should pass for a fully valid config', () => {
      expect(() => validateHorizonListenerConfig(validConfig)).not.toThrow()
    })

    it('should pass with an optional startLedger', () => {
      expect(() =>
        validateHorizonListenerConfig({ ...validConfig, startLedger: 1_000_000 }),
      ).not.toThrow()
    })

    it('should fail when horizonUrl is empty', () => {
      expect(() =>
        validateHorizonListenerConfig({ ...validConfig, horizonUrl: '' }),
      ).toThrow('process.exit: 1')
    })

    it('should fail when horizonUrl is not an HTTP/HTTPS URL', () => {
      expect(() =>
        validateHorizonListenerConfig({ ...validConfig, horizonUrl: 'ftp://example.com' }),
      ).toThrow('process.exit: 1')
    })

    it('should fail when contractAddresses is empty', () => {
      expect(() =>
        validateHorizonListenerConfig({ ...validConfig, contractAddresses: [] }),
      ).toThrow('process.exit: 1')
    })

    it('should fail when startLedger is negative', () => {
      expect(() =>
        validateHorizonListenerConfig({ ...validConfig, startLedger: -1 }),
      ).toThrow('process.exit: 1')
    })

    it('should fail when retryMaxAttempts is NaN', () => {
      expect(() =>
        validateHorizonListenerConfig({ ...validConfig, retryMaxAttempts: NaN }),
      ).toThrow('process.exit: 1')
    })

    it('should fail when retryBackoffMs is negative', () => {
      expect(() =>
        validateHorizonListenerConfig({ ...validConfig, retryBackoffMs: -1 }),
      ).toThrow('process.exit: 1')
    })

    it('should fail when shutdownTimeoutMs is zero', () => {
      expect(() =>
        validateHorizonListenerConfig({ ...validConfig, shutdownTimeoutMs: 0 }),
      ).toThrow('process.exit: 1')
    })

    it('should fail when lagThreshold is negative', () => {
      expect(() =>
        validateHorizonListenerConfig({ ...validConfig, lagThreshold: -5 }),
      ).toThrow('process.exit: 1')
    })

    it('should emit structured JSON error log on failure', () => {
      expect(() =>
        validateHorizonListenerConfig({ ...validConfig, horizonUrl: '' }),
      ).toThrow('process.exit: 1')

      expect(mockConsoleError).toHaveBeenCalledTimes(1)
      const log = JSON.parse((mockConsoleError.mock.calls[0] as string[])[0])
      expect(log.level).toBe('fatal')
      expect(log.event).toBe('config.horizon_validation_failed')
      expect(log.service).toBe('disciplr-backend')
      expect(log.errors).toBeInstanceOf(Array)
      expect(log.timestamp).toBeDefined()
    })

    it('should not leak sensitive values in error output', () => {
      expect(() =>
        validateHorizonListenerConfig({ ...validConfig, horizonUrl: '' }),
      ).toThrow('process.exit: 1')

      const log = (mockConsoleError.mock.calls[0] as string[])[0]
      expect(log).not.toContain('secret')
      expect(log).not.toContain('password')
    })
  })

  describe('getValidatedConfig', () => {
    let mockExit: ReturnType<typeof jest.spyOn>
    let mockConsoleError: ReturnType<typeof jest.spyOn>

    beforeEach(() => {
      mockExit = jest.spyOn(process, 'exit').mockImplementation(
        (code?: string | number | null | undefined) => {
          throw new Error(`process.exit: ${code}`)
        },
      )
      mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      mockExit.mockRestore()
      mockConsoleError.mockRestore()
    })

    it('should return a valid config when env vars are properly set', () => {
      process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org'
      process.env.CONTRACT_ADDRESS = 'CABC123'

      const config = getValidatedConfig()
      expect(config.horizonUrl).toBe('https://horizon-testnet.stellar.org')
      expect(config.contractAddresses).toEqual(['CABC123'])
    })

    it('should throw (exit) when HORIZON_URL is missing', () => {
      delete process.env.HORIZON_URL
      delete process.env.CONTRACT_ADDRESS
      expect(() => getValidatedConfig()).toThrow('process.exit: 1')
    })
  })
})
