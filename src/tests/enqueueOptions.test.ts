import { parseEnqueueOptions } from '../jobs/enqueueOptions.js'

describe('parseEnqueueOptions', () => {
  it('returns undefined defaults', () => {
    expect(parseEnqueueOptions({})).toEqual({
      delayMs: undefined,
      maxAttempts: undefined,
    })
  })

  it('floors decimal delay values', () => {
    expect(parseEnqueueOptions({ delayMs: 1234.99 })).toEqual({
      delayMs: 1234,
      maxAttempts: undefined,
    })
  })

  it('keeps maxAttempts value', () => {
    expect(parseEnqueueOptions({ maxAttempts: 9 })).toEqual({
      delayMs: undefined,
      maxAttempts: 9,
    })
  })
})
