import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import request from 'supertest'
import express from 'express'

jest.unstable_mockModule('../services/auth.service.js', () => ({
  AuthService: {
    register: jest.fn(),
    login: jest.fn(),
    refresh: jest.fn(),
  },
}))

let app: express.Express

beforeEach(async () => {
  jest.clearAllMocks()
  const { authRouter } = await import('../routes/auth.js')
  app = express()
  app.use(express.json())
  app.use('/auth', authRouter)
})

describe('Auth validation error format', () => {
  describe('POST /auth/register', () => {
    it('returns structured error for invalid email', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ email: 'not-an-email', password: 'validpass123' })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields).toBeInstanceOf(Array)
      expect(res.body.error.fields.some((f: any) => f.path === 'email')).toBe(true)
    })

    it('returns structured error for missing password', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ email: 'user@example.com' })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields.some((f: any) => f.path === 'password')).toBe(true)
    })

    it('returns structured error for short password', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ email: 'user@example.com', password: 'short' })

      expect(res.status).toBe(400)
      expect(res.body.error.fields.some((f: any) => f.path === 'password')).toBe(true)
    })
  })

  describe('POST /auth/login', () => {
    it('returns structured error for invalid email', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'bad', password: 'anything' })

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields.some((f: any) => f.path === 'email')).toBe(true)
    })

    it('returns structured error for missing email', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ password: 'anything' })

      expect(res.status).toBe(400)
      expect(res.body.error.fields.some((f: any) => f.path === 'email')).toBe(true)
    })
  })

  describe('POST /auth/refresh', () => {
    it('returns structured error for missing refreshToken', async () => {
      const res = await request(app)
        .post('/auth/refresh')
        .send({})

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.fields.some((f: any) => f.path === 'refreshToken')).toBe(true)
    })
  })
})