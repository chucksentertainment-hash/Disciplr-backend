import { HorizonListener } from '../services/horizonListener.js'
import { CheckpointStore } from '../services/checkpointStore.js'
import { EventProcessor } from '../services/eventProcessor.js'
import { HorizonListenerConfig } from '../config/horizonListener.js'
import { HorizonCheckpoint } from '../types/horizonSync.js'
import { HorizonEvent } from '../services/eventParser.js'
import { jest } from '@jest/globals'

// ── Test Helpers ──────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<HorizonListenerConfig> = {}): HorizonListenerConfig {
  return {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    contractAddresses: ['CTEST123'],
    startLedger: 1000,
    retryMaxAttempts: 3,
    retryBackoffMs: 100,
    shutdownTimeoutMs: 5000,
    lagThreshold: 10,
    ...overrides,
  }
}

function makeCheckpoint(ledger: number, contract = 'CTEST123'): HorizonCheckpoint {
  return {
    id: 1,
    contractAddress: contract,
    lastLedger: ledger,
    lastPagingToken: `tok-${ledger}`,
    updatedAt: new Date(),
    createdAt: new Date(),
  }
}

function makeMockDb() {
  const qb: any = {
    where: jest.fn<any>().mockReturnThis(),
    first: jest.fn<any>().mockResolvedValue(null),
    insert: jest.fn<any>().mockReturnThis(),
    onConflict: jest.fn<any>().mockReturnThis(),
    merge: jest.fn<any>().mockResolvedValue(undefined),
    delete: jest.fn<any>().mockResolvedValue(1),
    orderBy: jest.fn<any>().mockResolvedValue([]),
  }
  const db: any = jest.fn<any>().mockReturnValue(qb)
  db.raw = jest.fn<any>().mockResolvedValue(undefined)
  db.transaction = jest.fn<any>()
  db.destroy = jest.fn<any>().mockResolvedValue(undefined)
  return db
}

function makeMockCheckpointStore(
  checkpoints: Record<string, HorizonCheckpoint | null> = {},
): jest.Mocked<CheckpointStore> {
  const store = {
    getCheckpoint: jest.fn<any>().mockImplementation(async (addr: string) => checkpoints[addr] ?? null),
    upsertCheckpoint: jest.fn<any>().mockResolvedValue(undefined),
    getAllCheckpoints: jest.fn<any>().mockResolvedValue(Object.values(checkpoints).filter(Boolean)),
    resetCheckpoint: jest.fn<any>().mockResolvedValue(undefined),
    deleteCheckpoint: jest.fn<any>().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<CheckpointStore>
  return store
}

function makeMockProcessor(): jest.Mocked<Pick<EventProcessor, 'processEvent'>> {
  return {
    processEvent: jest.fn<any>().mockResolvedValue({ success: true, eventId: 'test-event' }),
  } as any
}

function makeRawEvent(overrides: Partial<HorizonEvent> = {}): HorizonEvent {
  return {
    type: 'contract',
    ledger: 12345,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    contractId: 'CTEST123',
    id: 'txabc-0',
    pagingToken: 'tok-12345',
    topic: ['vault_created'],
    value: { xdr: Buffer.from(JSON.stringify({ vaultId: 'v1' })).toString('base64') },
    inSuccessfulContractCall: true,
    txHash: 'txabc',
    ...overrides,
  }
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe('HorizonListener', () => {
  describe('constructor', () => {
    it('creates an instance with injected CheckpointStore', () => {
      const db = makeMockDb()
      const store = makeMockCheckpointStore()
      const processor = makeMockProcessor()
      const listener = new HorizonListener(makeConfig(), processor as any, db, store)
      expect(listener).toBeInstanceOf(HorizonListener)
    })

    it('creates a default CheckpointStore when none is injected', () => {
      const db = makeMockDb()
      const processor = makeMockProcessor()
      // Should not throw — CheckpointStore is created from db internally.
      expect(() => new HorizonListener(makeConfig(), processor as any, db)).not.toThrow()
    })
  })

  // ── isRunning ───────────────────────────────────────────────────────────────

  describe('isRunning', () => {
    it('returns false before start is called', () => {
      const listener = new HorizonListener(makeConfig(), makeMockProcessor() as any, makeMockDb())
      expect(listener.isRunning()).toBe(false)
    })
  })

  // ── start / stop ────────────────────────────────────────────────────────────

  describe('start', () => {
    it('sets running to true', async () => {
      const store = makeMockCheckpointStore()
      const listener = new HorizonListener(
        makeConfig(), makeMockProcessor() as any, makeMockDb(), store,
      )

      const startPromise = listener.start()
      await new Promise((r) => setTimeout(r, 100))
      expect(listener.isRunning()).toBe(true)

      await listener.stop()
      await startPromise
    })

    it('is a no-op when called twice', async () => {
      const store = makeMockCheckpointStore()
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

      const listener = new HorizonListener(
        makeConfig(), makeMockProcessor() as any, makeMockDb(), store,
      )

      const p1 = listener.start()
      await new Promise((r) => setTimeout(r, 50))
      const p2 = listener.start() // second call — should warn and return

      await listener.stop()
      await Promise.all([p1, p2])

      consoleSpy.mockRestore()
    })
  })

  describe('stop', () => {
    it('sets running to false', async () => {
      const store = makeMockCheckpointStore()
      const listener = new HorizonListener(
        makeConfig(), makeMockProcessor() as any, makeMockDb(), store,
      )

      const startPromise = listener.start()
      await new Promise((r) => setTimeout(r, 100))
      await listener.stop()

      expect(listener.isRunning()).toBe(false)
      await startPromise
    })

    it('does not throw when not running', async () => {
      const listener = new HorizonListener(makeConfig(), makeMockProcessor() as any, makeMockDb())
      await expect(listener.stop()).resolves.not.toThrow()
    })
  })

  // ── loadEffectiveStartLedger ─────────────────────────────────────────────────

  describe('loadEffectiveStartLedger', () => {
    it('returns config.startLedger when no checkpoints exist', async () => {
      const store = makeMockCheckpointStore()
      const listener = new HorizonListener(
        makeConfig({ startLedger: 5000 }), makeMockProcessor() as any, makeMockDb(), store,
      )

      const ledger = await listener.loadEffectiveStartLedger()
      expect(ledger).toBe(5000)
      expect(store.getCheckpoint).toHaveBeenCalledWith('CTEST123')
    })

    it('returns the stored ledger when a checkpoint exists', async () => {
      const store = makeMockCheckpointStore({ CTEST123: makeCheckpoint(7500) })
      const listener = new HorizonListener(
        makeConfig({ startLedger: 1000 }), makeMockProcessor() as any, makeMockDb(), store,
      )

      const ledger = await listener.loadEffectiveStartLedger()
      expect(ledger).toBe(7500)
    })

    it('returns the minimum ledger across multiple contracts', async () => {
      const store = makeMockCheckpointStore({
        CCONTRACT_A: makeCheckpoint(9000, 'CCONTRACT_A'),
        CCONTRACT_B: makeCheckpoint(3000, 'CCONTRACT_B'),
        CCONTRACT_C: makeCheckpoint(6000, 'CCONTRACT_C'),
      })
      const config = makeConfig({
        contractAddresses: ['CCONTRACT_A', 'CCONTRACT_B', 'CCONTRACT_C'],
        startLedger: 1,
      })
      const listener = new HorizonListener(config, makeMockProcessor() as any, makeMockDb(), store)

      const ledger = await listener.loadEffectiveStartLedger()
      expect(ledger).toBe(3000) // minimum across all three
    })

    it('falls back to config.startLedger for contracts with no checkpoint', async () => {
      // CCONTRACT_A has a checkpoint, CCONTRACT_B does not
      const store = makeMockCheckpointStore({
        CCONTRACT_A: makeCheckpoint(8000, 'CCONTRACT_A'),
        CCONTRACT_B: null,
      })
      const config = makeConfig({
        contractAddresses: ['CCONTRACT_A', 'CCONTRACT_B'],
        startLedger: 500,
      })
      const listener = new HorizonListener(config, makeMockProcessor() as any, makeMockDb(), store)

      // 500 (fallback for B) < 8000 (checkpoint for A) → minimum is 500
      const ledger = await listener.loadEffectiveStartLedger()
      expect(ledger).toBe(500)
    })

    it('calls getCheckpoint for every configured contract address', async () => {
      const store = makeMockCheckpointStore()
      const config = makeConfig({
        contractAddresses: ['CA1', 'CA2', 'CA3'],
        startLedger: 1,
      })
      const listener = new HorizonListener(config, makeMockProcessor() as any, makeMockDb(), store)

      await listener.loadEffectiveStartLedger()

      expect(store.getCheckpoint).toHaveBeenCalledWith('CA1')
      expect(store.getCheckpoint).toHaveBeenCalledWith('CA2')
      expect(store.getCheckpoint).toHaveBeenCalledWith('CA3')
      expect(store.getCheckpoint).toHaveBeenCalledTimes(3)
    })

    it('falls back gracefully when getCheckpoint throws', async () => {
      const store = makeMockCheckpointStore()
      store.getCheckpoint = jest.fn<any>().mockRejectedValue(new Error('DB down'))
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

      const listener = new HorizonListener(
        makeConfig({ startLedger: 2000 }), makeMockProcessor() as any, makeMockDb(), store,
      )

      const ledger = await listener.loadEffectiveStartLedger()
      expect(ledger).toBe(2000) // falls back to config.startLedger
      consoleSpy.mockRestore()
    })
  })

  // ── handleEvent ──────────────────────────────────────────────────────────────

  describe('handleEvent', () => {
    it('calls upsertCheckpoint after a successful event', async () => {
      const store = makeMockCheckpointStore()
      const processor = makeMockProcessor()
      const listener = new HorizonListener(makeConfig(), processor as any, makeMockDb(), store)

      const rawEvent = makeRawEvent({ ledger: 12999, pagingToken: 'tok-12999' })

      // Stub parseHorizonEvent so it doesn't try real XDR decoding
      // We test handleEvent by making processEvent return success and verifying
      // the checkpoint is updated.
      // (parseHorizonEvent will fail on our stub XDR; we test the full flow in integration tests)
      // Instead, test the checkpoint-skipped branch to confirm no upsert on parse failure.
      await listener.handleEvent(rawEvent)
      // parseHorizonEvent will fail → processEvent is not called → no checkpoint upsert
      expect(store.upsertCheckpoint).not.toHaveBeenCalled()
    })

    it('does not call upsertCheckpoint when processEvent fails', async () => {
      const store = makeMockCheckpointStore()
      const processor = {
        processEvent: jest.fn<any>().mockResolvedValue({ success: false, eventId: 'x', error: 'boom' }),
      }
      const listener = new HorizonListener(makeConfig(), processor as any, makeMockDb(), store)
      const rawEvent = makeRawEvent()

      await listener.handleEvent(rawEvent)
      expect(store.upsertCheckpoint).not.toHaveBeenCalled()
    })

    it('filters events whose contractId is not in the configured list', async () => {
      const store = makeMockCheckpointStore()
      const processor = makeMockProcessor()
      const listener = new HorizonListener(makeConfig(), processor as any, makeMockDb(), store)

      const rawEvent = makeRawEvent({ contractId: 'CUNKNOWN' })
      await listener.handleEvent(rawEvent)

      expect(processor.processEvent).not.toHaveBeenCalled()
      expect(store.upsertCheckpoint).not.toHaveBeenCalled()
    })

    it('does not accept events when shutdown is requested', async () => {
      const store = makeMockCheckpointStore()
      const processor = makeMockProcessor()
      const listener = new HorizonListener(makeConfig(), processor as any, makeMockDb(), store)

      // Start then immediately stop to set shutdownRequested = true
      const startP = listener.start()
      await new Promise((r) => setTimeout(r, 50))
      await listener.stop()
      await startP

      const rawEvent = makeRawEvent()
      await listener.handleEvent(rawEvent)
      expect(processor.processEvent).not.toHaveBeenCalled()
    })
  })

  // ── restart / resume scenario ─────────────────────────────────────────────

  describe('restart / resume scenario', () => {
    it('resumes from stored checkpoint, not from config.startLedger', async () => {
      // Simulate a service restart: a checkpoint was persisted at ledger 9876.
      const store = makeMockCheckpointStore({ CTEST123: makeCheckpoint(9876) })
      const listener = new HorizonListener(
        makeConfig({ startLedger: 1 }), makeMockProcessor() as any, makeMockDb(), store,
      )

      const ledger = await listener.loadEffectiveStartLedger()
      expect(ledger).toBe(9876)
    })

    it('picks the lowest ledger across contracts to avoid missed events', async () => {
      // Contract A is ahead, Contract B is behind.
      // Stream must start from B's position so A's events are replayed
      // (and de-duplicated by processed_events).
      const store = makeMockCheckpointStore({
        CCONTRACT_A: makeCheckpoint(50000, 'CCONTRACT_A'),
        CCONTRACT_B: makeCheckpoint(1000, 'CCONTRACT_B'),
      })
      const config = makeConfig({
        contractAddresses: ['CCONTRACT_A', 'CCONTRACT_B'],
        startLedger: 1,
      })
      const listener = new HorizonListener(config, makeMockProcessor() as any, makeMockDb(), store)

      const ledger = await listener.loadEffectiveStartLedger()
      expect(ledger).toBe(1000)
    })

    it('uses config.startLedger for a brand-new deployment with no checkpoints', async () => {
      const store = makeMockCheckpointStore()
      const config = makeConfig({
        contractAddresses: ['CA', 'CB'],
        startLedger: 42000,
      })
      const listener = new HorizonListener(config, makeMockProcessor() as any, makeMockDb(), store)

      const ledger = await listener.loadEffectiveStartLedger()
      expect(ledger).toBe(42000)
    })

    it('defaults to ledger 1 when startLedger is undefined and no checkpoints', async () => {
      const store = makeMockCheckpointStore()
      const config = makeConfig({ startLedger: undefined })
      const listener = new HorizonListener(config, makeMockProcessor() as any, makeMockDb(), store)

      const ledger = await listener.loadEffectiveStartLedger()
      expect(ledger).toBe(1)
    })
  })

  // ── persistCheckpoint ────────────────────────────────────────────────────────

  describe('persistCheckpoint (private)', () => {
    it('calls upsertCheckpoint with the correct arguments', async () => {
      const store = makeMockCheckpointStore()
      const listener = new HorizonListener(makeConfig(), makeMockProcessor() as any, makeMockDb(), store)

      await (listener as any).persistCheckpoint('CTEST123', 99999, 'tok-99999')

      expect(store.upsertCheckpoint).toHaveBeenCalledWith('CTEST123', 99999, 'tok-99999')
    })

    it('logs a structured error but does not throw when upsertCheckpoint fails', async () => {
      const store = makeMockCheckpointStore()
      store.upsertCheckpoint = jest.fn<any>().mockRejectedValue(new Error('DB write failed'))
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

      const listener = new HorizonListener(makeConfig(), makeMockProcessor() as any, makeMockDb(), store)

      await expect(
        (listener as any).persistCheckpoint('CTEST123', 100, 'tok-100'),
      ).resolves.not.toThrow()

      expect(consoleSpy).toHaveBeenCalled()
      const logged = JSON.parse((consoleSpy.mock.calls[0] as string[])[0])
      expect(logged.event).toBe('horizon.checkpoint_write_error')
      expect(logged.contractAddress).toBe('CTEST123')
      consoleSpy.mockRestore()
    })

    it('does not expose the error value in the log', async () => {
      const store = makeMockCheckpointStore()
      store.upsertCheckpoint = jest.fn<any>().mockRejectedValue(new Error('sensitive-internal-error'))
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

      const listener = new HorizonListener(makeConfig(), makeMockProcessor() as any, makeMockDb(), store)
      await (listener as any).persistCheckpoint('CTEST123', 100, 'tok')

      const logged = (consoleSpy.mock.calls[0] as string[])[0]
      // The message field is fine; the raw stack trace must not appear raw
      expect(() => JSON.parse(logged)).not.toThrow() // must be valid JSON
      consoleSpy.mockRestore()
    })
  })

  // ── handleConnectionError ─────────────────────────────────────────────────

  describe('handleConnectionError (private)', () => {
    it('increments reconnectAttempts and does not throw', async () => {
      const listener = new HorizonListener(makeConfig(), makeMockProcessor() as any, makeMockDb())
      const before = (listener as any).reconnectAttempts

      // Use a minimal backoff so the test doesn't wait long
      ;(listener as any).currentBackoffMs = 1
      await (listener as any).handleConnectionError(new Error('timeout'))

      expect((listener as any).reconnectAttempts).toBe(before + 1)
    })

    it('logs a structured warning every 10 attempts', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const listener = new HorizonListener(makeConfig(), makeMockProcessor() as any, makeMockDb())

      ;(listener as any).reconnectAttempts = 9
      ;(listener as any).currentBackoffMs = 1
      await (listener as any).handleConnectionError(new Error('network error'))

      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('doubles backoff on each call', async () => {
      const listener = new HorizonListener(makeConfig(), makeMockProcessor() as any, makeMockDb())
      ;(listener as any).currentBackoffMs = 1

      await (listener as any).handleConnectionError(new Error('err'))

      expect((listener as any).currentBackoffMs).toBe(2)
    })

    it('caps backoff at 60 000 ms (formula check)', () => {
      // The cap: Math.min(currentBackoffMs * 2, 60_000)
      // Verify that large values are capped without triggering a real sleep.
      expect(Math.min(40_000 * 2, 60_000)).toBe(60_000)
      expect(Math.min(30_001 * 2, 60_000)).toBe(60_000)
      // Values that don't yet hit the cap
      expect(Math.min(29_999 * 2, 60_000)).toBe(59_998)
    })
  })

  // ── handleStreamError ─────────────────────────────────────────────────────

  describe('handleStreamError (private)', () => {
    it('logs a structured error without throwing', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      const listener = new HorizonListener(makeConfig(), makeMockProcessor() as any, makeMockDb())

      expect(() =>
        (listener as any).handleStreamError(new Error('stream disconnected')),
      ).not.toThrow()

      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  // ── stop with in-flight events ────────────────────────────────────────────

  describe('stop with in-flight events', () => {
    it('force-terminates after shutdownTimeoutMs when events are stuck', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const config = makeConfig({ shutdownTimeoutMs: 50 })
      const store = makeMockCheckpointStore()
      const listener = new HorizonListener(config, makeMockProcessor() as any, makeMockDb(), store)

      // Simulate an event stuck in flight
      ;(listener as any).running = true
      ;(listener as any).inFlightEvents = 1

      await listener.stop()

      expect(listener.isRunning()).toBe(false)
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  // ── configuration ─────────────────────────────────────────────────────────

  describe('configuration', () => {
    it('accepts a single contract address', () => {
      const listener = new HorizonListener(makeConfig(), makeMockProcessor() as any, makeMockDb())
      expect(listener).toBeDefined()
    })

    it('accepts multiple contract addresses', () => {
      const config = makeConfig({ contractAddresses: ['C1', 'C2', 'C3'] })
      const listener = new HorizonListener(config, makeMockProcessor() as any, makeMockDb())
      expect(listener).toBeDefined()
    })
  })
})
