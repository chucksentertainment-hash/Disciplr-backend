import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import request from 'supertest'
import { app } from '../app.js'
import { parseCorsOrigins } from '../config/index.js'

// ---------------------------------------------------------------------------
// parseCorsOrigins — pure-function unit tests
// ---------------------------------------------------------------------------

describe('parseCorsOrigins()', () => {
  let warnSpy: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  describe('explicit CORS_ORIGINS value', () => {
    it('returns the wildcard sentinel when value is "*"', () => {
      expect(parseCorsOrigins('*', 'production')).toBe('*')
    })

    it('parses a single origin correctly', () => {
      expect(parseCorsOrigins('https://app.example.com', 'development')).toEqual([
        'https://app.example.com',
      ])
    })

    it('parses a comma-separated list and trims surrounding whitespace', () => {
      const result = parseCorsOrigins(
        'https://app.example.com , https://admin.example.com',
        'development',
      )
      expect(result).toEqual(['https://app.example.com', 'https://admin.example.com'])
    })

    it('filters out empty entries from a sparse value', () => {
      expect(parseCorsOrigins('https://a.com,,https://b.com', 'development')).toEqual([
        'https://a.com',
        'https://b.com',
      ])
    })

    it('explicit "*" in production is allowed and does not warn', () => {
      const result = parseCorsOrigins('*', 'production')
      expect(result).toBe('*')
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })

  describe('production — CORS_ORIGINS not set', () => {
    it('returns an empty array to block all cross-origin requests', () => {
      expect(parseCorsOrigins(undefined, 'production')).toEqual([])
    })

    it('emits exactly one structured warning to console.warn', () => {
      parseCorsOrigins(undefined, 'production')
      expect(warnSpy).toHaveBeenCalledTimes(1)
    })

    it('warning payload contains the expected event and level fields', () => {
      parseCorsOrigins(undefined, 'production')
      const payload = JSON.parse(warnSpy.mock.calls[0][0] as string) as Record<string, string>
      expect(payload.event).toBe('security.cors_misconfiguration')
      expect(payload.level).toBe('warn')
      expect(payload.service).toBe('disciplr-backend')
    })
  })

  describe('development / test — CORS_ORIGINS not set', () => {
    it('defaults to localhost:3000 in development', () => {
      expect(parseCorsOrigins(undefined, 'development')).toEqual(['http://localhost:3000'])
    })

    it('defaults to localhost:3000 in test', () => {
      expect(parseCorsOrigins(undefined, 'test')).toEqual(['http://localhost:3000'])
    })

    it('defaults to localhost:3000 for any unrecognised env value', () => {
      expect(parseCorsOrigins(undefined, 'staging')).toEqual(['http://localhost:3000'])
    })

    it('does not emit a warning for non-production defaults', () => {
      parseCorsOrigins(undefined, 'development')
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// CORS middleware — integration tests via supertest
//
// The app module is loaded with NODE_ENV=test and CORS_ORIGINS unset, so
// config.corsOrigins resolves to ['http://localhost:3000'].
// ---------------------------------------------------------------------------

describe('CORS middleware (integration)', () => {
  it('sets Access-Control-Allow-Origin for a trusted origin', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:3000')

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
  })

  it('does not set Access-Control-Allow-Origin for an untrusted origin', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'https://evil.example.com')

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('does not block server-to-server requests that carry no Origin header', async () => {
    // Routes are mounted in index.ts; the CORS middleware still runs and should
    // pass through requests without an Origin header regardless of the route.
    const res = await request(app).get('/api/health')
    // The cors middleware does not set an Allow-Origin header when no Origin is
    // present — that is expected and correct behaviour.
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('responds to a preflight OPTIONS with CORS headers for a trusted origin', async () => {
    const res = await request(app)
      .options('/api/vaults')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST')

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
    expect(res.headers['access-control-allow-methods']).toBeDefined()
  })

  it('does not set CORS headers on a preflight from an untrusted origin', async () => {
    const res = await request(app)
      .options('/api/vaults')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST')

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('includes credentials support header for trusted origins', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:3000')

    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('emits a structured security.cors_rejected log for blocked origins', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation((() => {}) as () => void)
    try {
      await request(app)
        .get('/api/health')
        .set('Origin', 'https://unauthorized.example.com')

      const rejection = logSpy.mock.calls
        .flatMap((args) => args)
        .map((arg) => {
          try {
            return JSON.parse(arg as string) as Record<string, string>
          } catch {
            return null
          }
        })
        .find((entry) => entry?.event === 'security.cors_rejected')

      expect(rejection).toBeDefined()
      expect(rejection?.origin).toBe('https://unauthorized.example.com')
      expect(rejection?.level).toBe('warn')
    } finally {
      logSpy.mockRestore()
    }
  })

  it('does not log a cors_rejected event for trusted origins', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation((() => {}) as () => void)
    try {
      await request(app)
        .get('/api/health')
        .set('Origin', 'http://localhost:3000')

      const rejectionLog = logSpy.mock.calls
        .flatMap((args) => args)
        .map((arg) => {
          try {
            return JSON.parse(arg as string) as Record<string, string>
          } catch {
            return null
          }
        })
        .find((entry) => entry?.event === 'security.cors_rejected')

      expect(rejectionLog).toBeUndefined()
    } finally {
      logSpy.mockRestore()
    }
  })

  it('blocks requests with Origin: null', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'null')

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('blocks preflight requests with Origin: null', async () => {
    const res = await request(app)
      .options('/api/health')
      .set('Origin', 'null')
      .set('Access-Control-Request-Method', 'GET')

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('includes allowed headers in preflight response for trusted origin', async () => {
    const res = await request(app)
      .options('/api/vaults')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST')

    const allowedHeaders = res.headers['access-control-allow-headers'] as string
    expect(allowedHeaders).toContain('Content-Type')
    expect(allowedHeaders).toContain('Authorization')
  })

  it('allows origin with trailing slash matching normalized allowlist entry', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:3000/')

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000/')
  })
})
