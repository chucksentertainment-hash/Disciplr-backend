import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import request from 'supertest'
import { initTestApp, cleanupTestApp } from '../helpers/app.js'
import { AuthService } from '../../services/auth.service.js'
import { type Knex } from 'knex'

describe('API Smoke Test Suite', () => {
  let app: any
  let db: Knex
  let authToken: string
  const testEmail = `smoke-${Date.now()}@example.com`
  const testPassword = 'Password123!'

  before(async () => {
    const initialized = await initTestApp()
    app = initialized.app
    db = initialized.db
    
    // Create a real user using AuthService to ensure DB consistency
    await AuthService.register({
      email: testEmail,
      password: testPassword,
      role: 'USER' as any
    })
  })

  after(async () => {
    if (db) {
      await cleanupTestApp(db)
    }
  })

  it('GET /api/health returns 200 OK', async () => {
    const start = Date.now()
    const res = await request(app).get('/api/health')
    const duration = Date.now() - start
    
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.body.status, 'ok')
    console.log(`GET /api/health took ${duration}ms`)
  })

  it('POST /api/auth/login returns 200 and a token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testEmail, password: testPassword })
    
    assert.strictEqual(res.status, 200)
    assert.ok(res.body.accessToken, 'Should have accessToken')
    authToken = res.body.accessToken
  })

  describe('Vaults', () => {
    const ADDR = 'G' + 'A'.repeat(55) // Mock Stellar address

    it('POST /api/vaults creates a new vault', async () => {
      const payload = {
        amount: '1000',
        startDate: new Date(Date.now() + 86400000).toISOString(), // Tomorrow
        endDate: new Date(Date.now() + 86400000 * 30).toISOString(), // In 30 days
        verifier: ADDR,
        destinations: { success: ADDR, failure: ADDR },
        milestones: [
          { title: 'Milestone 1', dueDate: new Date(Date.now() + 86400000 * 15).toISOString(), amount: '1000' }
        ]
      }

      const res = await request(app)
        .post('/api/vaults')
        .set('Authorization', `Bearer ${authToken}`)
        .send(payload)
      
      assert.strictEqual(res.status, 201)
      assert.ok(res.body.vault.id, 'Vault should have an ID')
      assert.strictEqual(res.body.vault.amount, '1000')
    })

    it('GET /api/vaults returns a list of vaults', async () => {
      const res = await request(app)
        .get('/api/vaults')
        .set('Authorization', `Bearer ${authToken}`)
      
      assert.strictEqual(res.status, 200)
      assert.ok(Array.isArray(res.body.data), 'Response data should be an array')
    })
  })
})
