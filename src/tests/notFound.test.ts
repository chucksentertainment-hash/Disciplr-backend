import { describe, it, expect } from '@jest/globals'
import request from 'supertest'
import express from 'express'
import { notFound } from '../middleware/notFound.js'
import { errorHandler } from '../middleware/errorHandler.js'

describe('notFound middleware contract', () => {
  const buildApp = () => {
    const app = express()
    app.get('/api/existing', (_req, res) => res.status(200).json({ ok: true }))
    app.use(notFound)
    app.use(errorHandler)
    return app
  }

  it('returns 404 for non-existent route', async () => {
    const app = buildApp()
    const res = await request(app).get('/api/non-existent')
    
    expect(res.status).toBe(404)
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: expect.stringContaining('/api/non-existent')
      }
    })
  })

  it('returns 404 for method mismatch on existing route', async () => {
    const app = buildApp()
    const res = await request(app).post('/api/existing')
    
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect(res.body.error.message).toContain('POST /api/existing')
  })

  it('includes requestId when x-request-id header is present', async () => {
    const app = buildApp()
    const requestId = 'test-request-id-123'
    const res = await request(app)
      .get('/api/missing')
      .set('x-request-id', requestId)
    
    expect(res.status).toBe(404)
    expect(res.body.error.requestId).toBe(requestId)
  })

  it('verifies missing /api prefix scenario', async () => {
    const app = buildApp()
    const res = await request(app).get('/existing') // Should have been /api/existing
    
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('does not leak internal route lists in 404 response', async () => {
    const app = buildApp()
    const res = await request(app).get('/api/some-random-route')
    
    const bodyString = JSON.stringify(res.body)
    // Should NOT contain other route names like 'existing'
    expect(bodyString).not.toContain('existing')
    // Should NOT contain internal stack traces or middleware names
    expect(bodyString).not.toContain('notFound')
    expect(bodyString).not.toContain('errorHandler')
  })
})
