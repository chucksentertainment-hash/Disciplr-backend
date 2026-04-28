import request from 'supertest'
import { app } from '../app.js'
import { bootstrapApp } from '../app-bootstrap.js'
import { generateAccessToken } from '../lib/auth-utils.js'
import { UserRole } from '../types/user.js'

type HeaderMap = Record<string, string | string[] | undefined>

interface HeaderContractOptions {
  expectFrameOptionsAbsent?: boolean
  expectPoweredByAbsent?: boolean
}

interface EndpointCase {
  label: string
  path: string
  token?: string
}

const DEFAULT_HEADER_CONTRACT_OPTIONS: Required<HeaderContractOptions> = {
  expectFrameOptionsAbsent: true,
  expectPoweredByAbsent: true,
}

let bootstrapped = false

function toHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value.join('; ')
  }
  return value ?? ''
}

function parseDirectives(csp: string): string[] {
  return csp
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0)
}

function assertHelmetHeaderContract(
  headers: HeaderMap,
  options: HeaderContractOptions = {},
) {
  const resolvedOptions = {
    ...DEFAULT_HEADER_CONTRACT_OPTIONS,
    ...options,
  }

  const csp = toHeaderValue(headers['content-security-policy'])
  expect(csp).toBeTruthy()
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("frame-ancestors 'none'")

  const hsts = toHeaderValue(headers['strict-transport-security']).toLowerCase()
  expect(hsts).toContain('max-age=31536000')
  expect(hsts).toContain('includesubdomains')
  expect(hsts).not.toContain('preload')

  expect(toHeaderValue(headers['referrer-policy'])).toBe('no-referrer')
  expect(toHeaderValue(headers['x-content-type-options'])).toBe('nosniff')
  expect(toHeaderValue(headers['cross-origin-resource-policy'])).toBe('same-site')
  expect(toHeaderValue(headers['cross-origin-opener-policy'])).toBe('same-origin')
  expect(toHeaderValue(headers['x-dns-prefetch-control'])).toBe('off')
  expect(toHeaderValue(headers['x-permitted-cross-domain-policies'])).toBe('none')

  if (resolvedOptions.expectFrameOptionsAbsent) {
    expect(headers['x-frame-options']).toBeUndefined()
  }

  if (resolvedOptions.expectPoweredByAbsent) {
    expect(headers['x-powered-by']).toBeUndefined()
  }
}

describe('helmet security headers contract', () => {
  beforeAll(() => {
    if (!bootstrapped) {
      bootstrapApp()
      bootstrapped = true
    }
  })

  describe('helper contract behavior', () => {
    it('normalizes single and array header values', () => {
      expect(toHeaderValue('abc')).toBe('abc')
      expect(toHeaderValue(['abc', 'def'])).toBe('abc; def')
      expect(toHeaderValue(undefined)).toBe('')
    })

    it('parses CSP directives without relying on order', () => {
      const parsed = parseDirectives("default-src 'none'; frame-ancestors 'none'; ")
      expect(parsed).toEqual(["default-src 'none'", "frame-ancestors 'none'"])
    })

    it('supports optional absence checks', () => {
      const headers: HeaderMap = {
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-site',
        'cross-origin-opener-policy': 'same-origin',
        'x-dns-prefetch-control': 'off',
        'x-permitted-cross-domain-policies': 'none',
        'x-frame-options': 'SAMEORIGIN',
        'x-powered-by': 'Express',
      }

      assertHelmetHeaderContract(headers, {
        expectFrameOptionsAbsent: false,
        expectPoweredByAbsent: false,
      })
    })
  })

  describe('representative endpoint matrix', () => {
    const endpointCases: EndpointCase[] = [
      {
        label: 'root endpoint (unauthenticated)',
        path: '/',
      },
      {
        label: 'health endpoint (unauthenticated)',
        path: '/api/health',
      },
      {
        label: 'authenticated endpoint',
        path: '/api/vaults',
        token: generateAccessToken({
          userId: 'helmet-user-1',
          role: UserRole.USER,
        }),
      },
      {
        label: 'admin endpoint',
        path: '/api/admin/audit-logs',
        token: generateAccessToken({
          userId: 'helmet-admin-1',
          role: UserRole.ADMIN,
        }),
      },
    ]

    it.each(endpointCases)('enforces helmet header contract for $label', async ({ path, token }) => {
      let req = request(app).get(path)
      if (token) {
        req = req.set('Authorization', `Bearer ${token}`)
      }

      const res = await req
      assertHelmetHeaderContract(res.headers as HeaderMap)
      expect(res.headers['x-timezone']).toBe('UTC')
    })
  })
})