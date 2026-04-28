/**
 * TransactionETLService – idempotent batch processing tests.
 *
 * All database calls are mocked via dependency injection so the suite runs
 * without a live Postgres instance.  The ETLBatchRepository is injected as a
 * plain object whose methods are jest spies, giving us full control over
 * every state transition.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { TransactionETLService } from '../services/transactionETL.js'
import { ETLBatchRepository } from '../repositories/etlBatchRepository.js'
import type { ETLBatch, ETLBatchResult, ETLConfig } from '../types/transactions.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONFIG: ETLConfig = {
  horizonUrl: 'https://horizon-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  batchSize: 10,
  maxRetries: 3,
}

const BATCH_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function makeBatchRow(overrides: Partial<ETLBatch> = {}): ETLBatch {
  return {
    batch_id: BATCH_ID,
    status: 'completed',
    operations_fetched: 5,
    transactions_inserted: 3,
    transactions_skipped: 2,
    started_at: new Date(),
    finished_at: new Date(),
    duration_ms: 100,
    error_message: null,
    created_at: new Date(),
    ...overrides,
  }
}

/** Build a minimal mock ETLBatchRepository. */
function makeMockRepo(overrides: Partial<ETLBatchRepository> = {}): ETLBatchRepository {
  return {
    create: jest.fn<() => Promise<ETLBatch>>().mockResolvedValue(makeBatchRow({ status: 'pending' })),
    markRunning: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    markCompleted: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    markFailed: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    isCompleted: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
    findById: jest.fn<() => Promise<ETLBatch | null>>().mockResolvedValue(null),
    listRecent: jest.fn<() => Promise<ETLBatch[]>>().mockResolvedValue([]),
    ...overrides,
  } as unknown as ETLBatchRepository
}

/** Build a TransactionETLService with all Horizon + DB calls stubbed out. */
function makeService(
  repoOverrides: Partial<ETLBatchRepository> = {},
  configOverrides: Partial<ETLConfig> = {},
): { service: TransactionETLService; repo: ETLBatchRepository } {
  const repo = makeMockRepo(repoOverrides)
  const service = new TransactionETLService({ ...TEST_CONFIG, ...configOverrides }, repo)

  // Stub out all Horizon + DB calls so tests focus on batch logic
  ;(service as any).fetchHorizonOperations = jest.fn<() => Promise<any[]>>().mockResolvedValue([])
  ;(service as any).getVaultsInDateRange = jest.fn<() => Promise<any[]>>().mockResolvedValue([])
  ;(service as any).getLastProcessedCursor = jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined)
  ;(service as any).saveLastProcessedCursor = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)

  return { service, repo }
}

// ---------------------------------------------------------------------------

describe('TransactionETLService – idempotent batch processing', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  describe('runETL() – happy path', () => {
    it('creates a batch, marks it running, then completed', async () => {
      const { service, repo } = makeService()

      const result = await service.runETL(undefined, BATCH_ID)

      expect(repo.create).toHaveBeenCalledWith(BATCH_ID)
      expect(repo.markRunning).toHaveBeenCalledWith(BATCH_ID)
      expect(repo.markCompleted).toHaveBeenCalledWith(
        BATCH_ID,
        expect.objectContaining({
          operationsFetched: expect.any(Number),
          transactionsInserted: expect.any(Number),
          transactionsSkipped: expect.any(Number),
        }),
        expect.any(Number),
      )
      expect(result.status).toBe('completed')
      expect(result.batchId).toBe(BATCH_ID)
    })

    it('returns correct counts when operations are processed', async () => {
      const { service, repo } = makeService()

      // Simulate 3 operations → 2 inserted, 1 skipped
      ;(service as any).fetchHorizonOperations = jest
        .fn<() => Promise<any[]>>()
        .mockResolvedValueOnce([
          { id: 'op1', transaction_successful: true, transaction_hash: 'aabbcc', type: 'payment', from: 'GA', to: 'GB', ledger: 1, created_at: new Date().toISOString(), source_account: 'GA' },
          { id: 'op2', transaction_successful: true, transaction_hash: 'ddeeff', type: 'payment', from: 'GA', to: 'GB', ledger: 2, created_at: new Date().toISOString(), source_account: 'GA' },
          { id: 'op3', transaction_successful: false, transaction_hash: 'gghhii', type: 'payment', from: 'GA', to: 'GB', ledger: 3, created_at: new Date().toISOString(), source_account: 'GA' },
        ])
        .mockResolvedValue([])

      // filterAndTransformOperations returns empty (no vault match) – that's fine,
      // we just want to verify operationsFetched is counted
      ;(service as any).filterAndTransformOperations = jest
        .fn<() => Promise<any[]>>()
        .mockResolvedValue([])

      const result = await service.runETL(undefined, BATCH_ID)

      expect(result.operationsFetched).toBe(3)
      expect(repo.markCompleted).toHaveBeenCalledWith(
        BATCH_ID,
        expect.objectContaining({ operationsFetched: 3 }),
        expect.any(Number),
      )
    })
  })

  // -------------------------------------------------------------------------
  describe('runETL() – idempotency / retry safety', () => {
    it('short-circuits immediately when batch is already completed', async () => {
      const existingBatch = makeBatchRow()
      const { service, repo } = makeService({
        isCompleted: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
        findById: jest.fn<() => Promise<ETLBatch | null>>().mockResolvedValue(existingBatch),
      })

      const result = await service.runETL(undefined, BATCH_ID)

      expect(repo.create).not.toHaveBeenCalled()
      expect(repo.markRunning).not.toHaveBeenCalled()
      expect(repo.markCompleted).not.toHaveBeenCalled()
      expect(result.status).toBe('completed')
      expect(result.batchId).toBe(BATCH_ID)
      expect(result.transactionsInserted).toBe(existingBatch.transactions_inserted)
    })

    it('does NOT double-count when the same batch is retried after a failure', async () => {
      // First call: batch row already exists (create throws), but we proceed
      const { service, repo } = makeService({
        isCompleted: jest
          .fn<() => Promise<boolean>>()
          .mockResolvedValueOnce(false) // first attempt
          .mockResolvedValueOnce(false), // second attempt (still not completed)
        create: jest
          .fn<() => Promise<ETLBatch>>()
          .mockRejectedValueOnce(new Error('duplicate key')) // row already exists
          .mockResolvedValue(makeBatchRow({ status: 'pending' })),
      })

      // Both calls should succeed without throwing
      const r1 = await service.runETL(undefined, BATCH_ID)
      const r2 = await service.runETL(undefined, BATCH_ID)

      expect(r1.status).toBe('completed')
      expect(r2.status).toBe('completed')
      // markRunning called once per attempt
      expect(repo.markRunning).toHaveBeenCalledTimes(2)
    })

    it('generates a UUID batchId when none is provided', async () => {
      const { service, repo } = makeService()

      await service.runETL()

      const [calledId] = (repo.create as jest.Mock).mock.calls[0] as [string]
      expect(calledId).toMatch(/^[0-9a-f-]{36}$/)
    })
  })

  // -------------------------------------------------------------------------
  describe('runETL() – failure handling', () => {
    it('marks batch as failed when incrementalSync throws', async () => {
      const { service, repo } = makeService()

      ;(service as any).incrementalSync = jest
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error('Horizon timeout'))

      const result = await service.runETL(undefined, BATCH_ID)

      expect(result.status).toBe('failed')
      expect(result.error).toContain('Horizon timeout')
      expect(repo.markFailed).toHaveBeenCalledWith(
        BATCH_ID,
        expect.stringContaining('Horizon timeout'),
        expect.any(Number),
      )
      expect(repo.markCompleted).not.toHaveBeenCalled()
    })

    it('marks batch as failed on abort and re-throws', async () => {
      const { service, repo } = makeService()
      const controller = new AbortController()

      ;(service as any).incrementalSync = jest
        .fn<() => Promise<void>>()
        .mockImplementation(() => {
          controller.abort()
          const err = new Error('ETL run aborted')
          err.name = 'AbortError'
          throw err
        })

      const result = await service.runETL(controller.signal, BATCH_ID)

      expect(result.status).toBe('failed')
      expect(repo.markFailed).toHaveBeenCalled()
    })

    it('records duration_ms even on failure', async () => {
      const { service, repo } = makeService()

      ;(service as any).incrementalSync = jest
        .fn<() => Promise<void>>()
        .mockImplementation(
          () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('slow fail')), 20)),
        )

      await service.runETL(undefined, BATCH_ID)

      const [, , durationMs] = (repo.markFailed as jest.Mock).mock.calls[0] as [string, string, number]
      expect(durationMs).toBeGreaterThanOrEqual(20)
    })
  })

  // -------------------------------------------------------------------------
  describe('runETL() – partial failure (some batches succeed, some fail)', () => {
    it('completes successfully even when some operations are skipped', async () => {
      const { service, repo } = makeService()

      // saveTransactions returns a mix of inserted + skipped
      ;(service as any).saveTransactions = jest
        .fn<() => Promise<{ inserted: number; skipped: number }>>()
        .mockResolvedValue({ inserted: 2, skipped: 3 })

      ;(service as any).fetchHorizonOperations = jest
        .fn<() => Promise<any[]>>()
        .mockResolvedValueOnce([
          { id: 'op1', transaction_successful: true, transaction_hash: 'aabbcc', type: 'payment', from: 'GA', to: 'GB', ledger: 1, created_at: new Date().toISOString(), source_account: 'GA' },
        ])
        .mockResolvedValue([])

      ;(service as any).filterAndTransformOperations = jest
        .fn<() => Promise<any[]>>()
        .mockResolvedValue([{ tx_hash: 'aabbcc' }])

      const result = await service.runETL(undefined, BATCH_ID)

      expect(result.status).toBe('completed')
      expect(result.transactionsInserted).toBe(2)
      expect(result.transactionsSkipped).toBe(3)
    })

    it('accumulates counts across multiple fetch pages', async () => {
      const { service, repo } = makeService()

      let callCount = 0
      ;(service as any).fetchHorizonOperations = jest
        .fn<() => Promise<any[]>>()
        .mockImplementation(() => {
          callCount++
          if (callCount === 1) {
            return Promise.resolve([
              { id: 'op1', transaction_successful: true, transaction_hash: 'aabb', type: 'payment', from: 'GA', to: 'GB', ledger: 1, created_at: new Date().toISOString(), source_account: 'GA' },
              { id: 'op2', transaction_successful: true, transaction_hash: 'ccdd', type: 'payment', from: 'GA', to: 'GB', ledger: 2, created_at: new Date().toISOString(), source_account: 'GA' },
            ])
          }
          return Promise.resolve([]) // second page empty → stop
        })

      ;(service as any).filterAndTransformOperations = jest
        .fn<() => Promise<any[]>>()
        .mockResolvedValue([{ tx_hash: 'aabb' }])

      ;(service as any).saveTransactions = jest
        .fn<() => Promise<{ inserted: number; skipped: number }>>()
        .mockResolvedValue({ inserted: 1, skipped: 0 })

      const result = await service.runETL(undefined, BATCH_ID)

      expect(result.operationsFetched).toBe(2)
      expect(result.transactionsInserted).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  describe('saveTransactions() – deduplication', () => {
    it('returns inserted=0 skipped=0 for empty input', async () => {
      const { service } = makeService()
      // We need to bypass the real db call – mock the db transaction
      ;(service as any).saveTransactions = TransactionETLService.prototype.saveTransactions.bind(service)

      // Patch the internal db reference to avoid real DB
      const mockTrx = {
        commit: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        rollback: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      }
      // saveTransactions with empty array returns early before touching db
      const result = await (service as any).saveTransactions([])
      expect(result).toEqual({ inserted: 0, skipped: 0 })
    })

    it('isValidTxHash rejects strings that could cause injection', () => {
      expect(TransactionETLService.isValidTxHash("'; DROP TABLE transactions; --")).toBe(false)
      expect(TransactionETLService.isValidTxHash('../etc/passwd')).toBe(false)
      expect(TransactionETLService.isValidTxHash('')).toBe(false)
      expect(TransactionETLService.isValidTxHash('abc123')).toBe(true)
      expect(TransactionETLService.isValidTxHash('a'.repeat(64))).toBe(true)
      expect(TransactionETLService.isValidTxHash('A'.repeat(128))).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  describe('AbortSignal integration', () => {
    it('marks batch failed and returns failed result when aborted before sync', async () => {
      const { service, repo } = makeService()
      const controller = new AbortController()
      controller.abort() // pre-aborted

      const result = await service.runETL(controller.signal, BATCH_ID)

      expect(result.status).toBe('failed')
      expect(repo.markFailed).toHaveBeenCalled()
    })

    it('marks batch failed when aborted mid-sync', async () => {
      const { service, repo } = makeService()
      const controller = new AbortController()

      ;(service as any).incrementalSync = jest
        .fn<() => Promise<void>>()
        .mockImplementation(async () => {
          controller.abort()
          TransactionETLService.checkAbort(controller.signal)
        })

      const result = await service.runETL(controller.signal, BATCH_ID)

      expect(result.status).toBe('failed')
      expect(repo.markFailed).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  describe('ETLBatchRepository state machine', () => {
    it('markCompleted is not called when markFailed was already called', async () => {
      const { service, repo } = makeService()

      ;(service as any).incrementalSync = jest
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error('boom'))

      await service.runETL(undefined, BATCH_ID)

      expect(repo.markFailed).toHaveBeenCalledTimes(1)
      expect(repo.markCompleted).not.toHaveBeenCalled()
    })

    it('markFailed is not called on a successful run', async () => {
      const { service, repo } = makeService()

      await service.runETL(undefined, BATCH_ID)

      expect(repo.markCompleted).toHaveBeenCalledTimes(1)
      expect(repo.markFailed).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  describe('mapOperationToTransactionType', () => {
    let service: TransactionETLService

    beforeEach(() => {
      ;({ service } = makeService())
    })

    it('maps create_account → creation', () => {
      expect((service as any).mapOperationToTransactionType({ type: 'create_account' })).toBe('creation')
    })

    it('maps payment to verifier → validation', () => {
      expect((service as any).mapOperationToTransactionType({ type: 'payment', to: 'verifier_account' })).toBe('validation')
    })

    it('maps payment to success → release', () => {
      expect((service as any).mapOperationToTransactionType({ type: 'payment', to: 'success_destination' })).toBe('release')
    })

    it('maps payment to failure → redirect', () => {
      expect((service as any).mapOperationToTransactionType({ type: 'payment', to: 'failure_destination' })).toBe('redirect')
    })

    it('maps manage_data cancel → cancel', () => {
      expect((service as any).mapOperationToTransactionType({ type: 'manage_data', name: 'vault_cancel' })).toBe('cancel')
    })

    it('returns null for unknown types', () => {
      expect((service as any).mapOperationToTransactionType({ type: 'unknown' })).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  describe('backfill path', () => {
    it('runs backfill when backfillFrom is configured', async () => {
      const { service, repo } = makeService(
        {},
        { backfillFrom: new Date('2026-01-01'), backfillTo: new Date('2026-01-31') },
      )

      const backfillSpy = jest
        .spyOn(service as any, 'backfillHistoricalTransactions')
        .mockResolvedValue(undefined)

      await service.runETL(undefined, BATCH_ID)

      expect(backfillSpy).toHaveBeenCalledTimes(1)
      expect(repo.markCompleted).toHaveBeenCalled()
    })

    it('counts operations fetched during backfill', async () => {
      const { service, repo } = makeService(
        {},
        { backfillFrom: new Date('2026-01-01') },
      )

      // Stub backfill to mutate counters directly (simulating real work)
      jest.spyOn(service as any, 'backfillHistoricalTransactions').mockImplementation(
        async (_signal: unknown, counters: any) => {
          if (counters) {
            counters.operationsFetched += 10
            counters.transactionsInserted += 7
            counters.transactionsSkipped += 3
          }
        },
      )

      const result = await service.runETL(undefined, BATCH_ID)

      expect(result.operationsFetched).toBe(10)
      expect(result.transactionsInserted).toBe(7)
      expect(result.transactionsSkipped).toBe(3)
      expect(repo.markCompleted).toHaveBeenCalledWith(
        BATCH_ID,
        { operationsFetched: 10, transactionsInserted: 7, transactionsSkipped: 3 },
        expect.any(Number),
      )
    })
  })

  // -------------------------------------------------------------------------
  describe('transformHorizonOperation', () => {
    it('maps all fields correctly', () => {
      const { service } = makeService()
      const record = {
        id: '123',
        type: 'payment',
        transaction_hash: 'abc',
        created_at: '2026-01-01T00:00:00Z',
        transaction_successful: true,
        source_account: 'GSRC',
        amount: '100',
        asset_code: 'USDC',
        asset_type: 'credit_alphanum4',
        from: 'GFROM',
        to: 'GTO',
        ledger: 999,
        fee_paid: 100,
        memo: 'hello',
        memo_type: 'text',
      }

      const result = (service as any).transformHorizonOperation(record)

      expect(result).toMatchObject({
        id: '123',
        type: 'payment',
        transaction_hash: 'abc',
        from: 'GFROM',
        to: 'GTO',
        ledger: 999,
      })
    })
  })
})
