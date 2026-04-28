import { initializeDatabase, readAnalyticsSummary, updateAnalyticsSummary } from '../db/database.js'

describe('analytics storage compatibility', () => {
  beforeAll(() => {
    initializeDatabase()
  })

  it('returns a stable summary payload shape for /api/analytics consumers', async () => {
    updateAnalyticsSummary()
    const summary = await readAnalyticsSummary()

    expect(summary).toEqual({
      total_vaults: expect.any(Number),
      active_vaults: expect.any(Number),
      completed_vaults: expect.any(Number),
      failed_vaults: expect.any(Number),
      total_locked_capital: expect.any(String),
      active_capital: expect.any(String),
      success_rate: expect.any(Number),
      last_updated: expect.any(String),
    })
  })
})
