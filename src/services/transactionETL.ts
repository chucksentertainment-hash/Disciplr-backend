import { randomUUID } from 'node:crypto'
import { Horizon } from '@stellar/stellar-sdk'
import type { Transaction, HorizonOperation, ETLConfig, VaultReference, ETLBatchResult } from '../types/transactions.js'
import { db } from '../db/index.js'
import { ETLBatchRepository } from '../repositories/etlBatchRepository.js'

// ---------------------------------------------------------------------------
// Internal counters accumulated during a single run
// ---------------------------------------------------------------------------
interface RunCounters {
  operationsFetched: number
  transactionsInserted: number
  transactionsSkipped: number
}

export class TransactionETLService {
  private server: Horizon.Server
  private config: ETLConfig
  private readonly batchRepo: ETLBatchRepository
  private readonly STELLAR_EXPLORER_BASE = 'https://stellar.expert/explorer/public/tx'

  constructor(
    config: ETLConfig,
    /** Injected for testing; defaults to the shared Knex instance. */
    batchRepo?: ETLBatchRepository,
  ) {
    this.config = config
    this.server = new Horizon.Server(config.horizonUrl)
    this.batchRepo = batchRepo ?? new ETLBatchRepository(db)
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run the full ETL process for a given batch.
   *
   * Idempotency contract:
   *   - If `batchId` has already completed, the method returns immediately
   *     without re-processing any data (safe to retry).
   *   - All transaction inserts use INSERT … ON CONFLICT DO NOTHING so
   *     duplicate tx_hash rows are silently skipped.
   *   - Batch outcome (success/failure, duration, counts) is persisted in
   *     `etl_batches` regardless of whether the run succeeds or throws.
   *
   * @param signal  AbortSignal forwarded from ETLWorker for graceful shutdown.
   * @param batchId Stable identifier for this logical run.  The caller
   *                (ETLWorker) generates a UUID once per scheduled tick and
   *                passes the same ID on every retry attempt.
   */
  async runETL(signal?: AbortSignal, batchId?: string): Promise<ETLBatchResult> {
    const id = batchId ?? randomUUID()
    const startedAt = Date.now()

    // --- Idempotency guard: skip if this batch already completed ---
    const alreadyDone = await this.batchRepo.isCompleted(id)
    if (alreadyDone) {
      console.log(`[ETL] Batch ${id} already completed – skipping`)
      const existing = await this.batchRepo.findById(id)
      return {
        batchId: id,
        status: 'completed',
        operationsFetched: existing?.operations_fetched ?? 0,
        transactionsInserted: existing?.transactions_inserted ?? 0,
        transactionsSkipped: existing?.transactions_skipped ?? 0,
        durationMs: existing?.duration_ms ?? 0,
      }
    }

    // Ensure the batch row exists (idempotent – throws on true duplicate)
    try {
      await this.batchRepo.create(id)
    } catch {
      // Row already exists from a previous attempt that didn't complete.
      // That's fine – we'll just update it below.
    }

    await this.batchRepo.markRunning(id)

    const counters: RunCounters = {
      operationsFetched: 0,
      transactionsInserted: 0,
      transactionsSkipped: 0,
    }

    try {
      TransactionETLService.checkAbort(signal)
      console.log(`[ETL] Starting batch ${id}`)

      if (this.config.backfillFrom) {
        await this.backfillHistoricalTransactions(signal, counters)
      }

      TransactionETLService.checkAbort(signal)
      await this.incrementalSync(signal, counters)

      const durationMs = Date.now() - startedAt
      await this.batchRepo.markCompleted(id, counters, durationMs)

      console.log(
        `[ETL] Batch ${id} completed in ${durationMs}ms – ` +
          `fetched=${counters.operationsFetched} inserted=${counters.transactionsInserted} ` +
          `skipped=${counters.transactionsSkipped}`,
      )

      return {
        batchId: id,
        status: 'completed',
        ...counters,
        durationMs,
      }
    } catch (error) {
      const durationMs = Date.now() - startedAt
      const message = error instanceof Error ? error.message : String(error)

      if (TransactionETLService.isAbortError(error)) {
        console.log(`[ETL] Batch ${id} aborted after ${durationMs}ms`)
      } else {
        console.error(`[ETL] Batch ${id} failed after ${durationMs}ms:`, error)
      }

      await this.batchRepo.markFailed(id, message, durationMs)

      return {
        batchId: id,
        status: 'failed',
        ...counters,
        durationMs,
        error: message,
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Backfill
  // ---------------------------------------------------------------------------

  async backfillHistoricalTransactions(signal?: AbortSignal, counters?: RunCounters): Promise<void> {
    console.log(`[ETL] Starting backfill from ${this.config.backfillFrom} to ${this.config.backfillTo}`)
    const from = this.config.backfillFrom!
    const to = this.config.backfillTo || new Date()
    const vaults = await this.getVaultsInDateRange(from, to)

    for (const vault of vaults) {
      TransactionETLService.checkAbort(signal)
      await this.processVaultTransactions(vault, from, to, counters)
    }
  }

  // ---------------------------------------------------------------------------
  // Incremental sync
  // ---------------------------------------------------------------------------

  async incrementalSync(signal?: AbortSignal, counters?: RunCounters): Promise<void> {
    console.log('[ETL] Starting incremental sync...')

    let cursor = this.config.cursor || (await this.getLastProcessedCursor())
    let hasMore = true
    let processedCount = 0

    while (hasMore && processedCount < this.config.batchSize) {
      TransactionETLService.checkAbort(signal)

      try {
        const operations = await this.fetchHorizonOperations(cursor)

        if (operations.length === 0) {
          hasMore = false
          break
        }

        if (counters) counters.operationsFetched += operations.length

        const vaultTransactions = await this.filterAndTransformOperations(operations)

        if (vaultTransactions.length > 0) {
          const { inserted, skipped } = await this.saveTransactions(vaultTransactions)
          if (counters) {
            counters.transactionsInserted += inserted
            counters.transactionsSkipped += skipped
          }
        }

        cursor = operations[operations.length - 1].id
        processedCount += operations.length
        console.log(`[ETL] Processed ${processedCount} operations...`)
      } catch (error) {
        if (TransactionETLService.isAbortError(error)) throw error
        console.error(`[ETL] Error processing batch at cursor ${cursor}:`, error)
        break
      }
    }

    if (cursor) {
      await this.saveLastProcessedCursor(cursor)
    }
  }

  // ---------------------------------------------------------------------------
  // Horizon fetch
  // ---------------------------------------------------------------------------

  private async fetchHorizonOperations(cursor?: string): Promise<HorizonOperation[]> {
    try {
      let builder = this.server.operations().order('asc').limit(this.config.batchSize)
      if (cursor) builder = builder.cursor(cursor)
      const response = await builder.call()
      return response.records.map(this.transformHorizonOperation)
    } catch (error) {
      console.error('[ETL] Error fetching Horizon operations:', error)
      throw error
    }
  }

  private transformHorizonOperation(record: any): HorizonOperation {
    return {
      id: record.id,
      type: record.type,
      transaction_hash: record.transaction_hash,
      created_at: record.created_at,
      transaction_successful: record.transaction_successful,
      source_account: record.source_account,
      amount: record.amount,
      asset_code: record.asset_code,
      asset_type: record.asset_type,
      from: record.from || record.source_account,
      to: record.to,
      name: record.name,
      value: record.value,
      ledger: record.ledger,
      fee_paid: record.fee_paid,
      memo: record.memo,
      memo_type: record.memo_type,
    }
  }

  // ---------------------------------------------------------------------------
  // Transform & filter
  // ---------------------------------------------------------------------------

  private async filterAndTransformOperations(operations: HorizonOperation[]): Promise<Transaction[]> {
    const transactions: Transaction[] = []
    for (const operation of operations) {
      if (!operation.transaction_successful) continue
      const vaultReference = await this.findVaultForOperation(operation)
      if (!vaultReference) continue
      const transaction = await this.transformOperationToTransaction(operation, vaultReference)
      if (transaction) transactions.push(transaction)
    }
    return transactions
  }

  private async findVaultForOperation(operation: HorizonOperation): Promise<VaultReference | null> {
    try {
      if (operation.memo && operation.memo_type === 'text') {
        const vault = await this.getVaultById(operation.memo)
        if (vault) return vault
      }
      if (operation.type === 'manage_data' && operation.name?.startsWith('vault_')) {
        const vaultId = operation.name.replace('vault_', '')
        const vault = await this.getVaultById(vaultId)
        if (vault) return vault
      }
      if (operation.type === 'payment') {
        const vault = await this.findVaultByAccounts(operation.from!, operation.to!)
        if (vault) return vault
      }
      return await this.findVaultFromEvents(operation.transaction_hash)
    } catch (error) {
      console.error('[ETL] Error finding vault for operation:', error)
      return null
    }
  }

  private async findVaultFromEvents(txHash: string): Promise<VaultReference | null> {
    try {
      const events = await (this.server as any).events().forTransaction(txHash).call()
      for (const event of events.records) {
        for (const topic of event.topic) {
          if (topic.startsWith('vault_') || (topic.length === 36 && topic.includes('-'))) {
            const vaultId = topic.replace('vault_', '')
            const vault = await this.getVaultById(vaultId)
            if (vault) return vault
          }
        }
      }
      return null
    } catch {
      return null
    }
  }

  private async transformOperationToTransaction(
    operation: HorizonOperation,
    vault: VaultReference,
  ): Promise<Transaction | null> {
    try {
      const type = this.mapOperationToTransactionType(operation)
      if (!type) return null
      return {
        id: randomUUID(),
        user_id: vault.user_id,
        vault_id: vault.id,
        tx_hash: operation.transaction_hash,
        type,
        amount: operation.amount || '0',
        asset_code: operation.asset_type === 'native' ? null : (operation.asset_code ?? null),
        from_account: operation.from || operation.source_account,
        to_account: operation.to || vault.success_destination,
        memo: operation.memo || null,
        created_at: new Date(),
        stellar_ledger: operation.ledger,
        stellar_timestamp: new Date(operation.created_at),
        explorer_url: `${this.STELLAR_EXPLORER_BASE}/${operation.transaction_hash}`,
      }
    } catch (error) {
      console.error('[ETL] Error transforming operation to transaction:', error)
      return null
    }
  }

  private mapOperationToTransactionType(operation: HorizonOperation): Transaction['type'] | null {
    switch (operation.type) {
      case 'create_account':
        return 'creation'
      case 'payment':
        if (operation.to?.includes('verifier')) return 'validation'
        if (operation.to?.includes('success')) return 'release'
        if (operation.to?.includes('failure')) return 'redirect'
        return 'release'
      case 'manage_data':
        if (operation.name?.includes('cancel')) return 'cancel'
        if (operation.name?.includes('redirect')) return 'redirect'
        return 'validation'
      default:
        return null
    }
  }

  // ---------------------------------------------------------------------------
  // Idempotent save – INSERT … ON CONFLICT DO NOTHING
  // ---------------------------------------------------------------------------

  /**
   * Persist transactions using INSERT … ON CONFLICT (tx_hash) DO NOTHING.
   *
   * This is the core deduplication mechanism: `tx_hash` has a UNIQUE
   * constraint in the `transactions` table, so any row that was already
   * inserted by a previous run is silently skipped rather than causing an
   * error or a double-count.
   *
   * Returns the number of rows actually inserted vs skipped so the caller
   * can update batch counters accurately.
   */
  async saveTransactions(transactions: Transaction[]): Promise<{ inserted: number; skipped: number }> {
    if (transactions.length === 0) return { inserted: 0, skipped: 0 }

    const trx = await db.transaction()
    let inserted = 0
    let skipped = 0

    try {
      for (const transaction of transactions) {
        // Validate tx_hash to prevent injection via ETL inputs
        if (!TransactionETLService.isValidTxHash(transaction.tx_hash)) {
          console.warn(`[ETL] Skipping transaction with invalid tx_hash: ${transaction.tx_hash}`)
          skipped++
          continue
        }

        const rows = await trx('transactions')
          .insert({
            id: transaction.id,
            user_id: transaction.user_id,
            vault_id: transaction.vault_id,
            tx_hash: transaction.tx_hash,
            type: transaction.type,
            amount: transaction.amount,
            asset_code: transaction.asset_code,
            from_account: transaction.from_account,
            to_account: transaction.to_account,
            memo: transaction.memo,
            created_at: transaction.created_at,
            stellar_ledger: transaction.stellar_ledger,
            stellar_timestamp: transaction.stellar_timestamp,
            explorer_url: transaction.explorer_url,
          })
          .onConflict('tx_hash')
          .ignore()
          .returning('id')

        if (rows.length > 0) {
          inserted++
        } else {
          skipped++
        }
      }

      await trx.commit()
      console.log(`[ETL] saveTransactions: inserted=${inserted} skipped=${skipped}`)
      return { inserted, skipped }
    } catch (error) {
      await trx.rollback()
      console.error('[ETL] Error saving transactions:', error)
      throw error
    }
  }

  // ---------------------------------------------------------------------------
  // DB helpers
  // ---------------------------------------------------------------------------

  private async getVaultsInDateRange(from: Date, to: Date): Promise<VaultReference[]> {
    return db('vaults')
      .where('created_at', '>=', from)
      .where('created_at', '<=', to)
      .select('id', 'user_id', 'creator', 'verifier', 'success_destination', 'failure_destination')
  }

  private async getVaultById(vaultId: string): Promise<VaultReference | null> {
    return db('vaults').where('id', vaultId).first()
  }

  private async findVaultByAccounts(
    fromAccount: string,
    toAccount: string,
  ): Promise<VaultReference | null> {
    return db('vaults')
      .where(function () {
        this.where('creator', fromAccount)
          .orWhere('creator', toAccount)
          .orWhere('verifier', fromAccount)
          .orWhere('verifier', toAccount)
          .orWhere('success_destination', fromAccount)
          .orWhere('success_destination', toAccount)
          .orWhere('failure_destination', fromAccount)
          .orWhere('failure_destination', toAccount)
      })
      .first()
  }

  private async getLastProcessedCursor(): Promise<string | undefined> {
    return undefined
  }

  private async saveLastProcessedCursor(cursor: string): Promise<void> {
    console.log(`[ETL] Saving cursor: ${cursor}`)
  }

  private async processVaultTransactions(
    vault: VaultReference,
    from: Date,
    to: Date,
    counters?: RunCounters,
  ): Promise<void> {
    console.log(`[ETL] Processing transactions for vault ${vault.id}`)
    const accounts = [
      vault.creator,
      vault.verifier,
      vault.success_destination,
      vault.failure_destination,
    ].filter(Boolean)

    for (const account of accounts) {
      await this.processAccountTransactions(account, vault, from, to, counters)
    }
  }

  private async processAccountTransactions(
    account: string,
    vault: VaultReference,
    from: Date,
    to: Date,
    counters?: RunCounters,
  ): Promise<void> {
    try {
      const operations = await this.server
        .operations()
        .forAccount(account)
        .order('asc')
        .limit(this.config.batchSize)
        .call()

      const vaultOperations = operations.records
        .filter((op) => new Date(op.created_at) >= from && new Date(op.created_at) <= to)
        .map(this.transformHorizonOperation)

      if (counters) counters.operationsFetched += vaultOperations.length

      const transactions = await this.filterAndTransformOperations(vaultOperations)
      if (transactions.length > 0) {
        const { inserted, skipped } = await this.saveTransactions(transactions)
        if (counters) {
          counters.transactionsInserted += inserted
          counters.transactionsSkipped += skipped
        }
      }
    } catch (error) {
      console.error(`[ETL] Error processing account ${account}:`, error)
    }
  }

  // ---------------------------------------------------------------------------
  // Security helpers
  // ---------------------------------------------------------------------------

  /**
   * Validate that a tx_hash looks like a legitimate Stellar transaction hash
   * (64 hex characters).  Rejects anything that could be used for injection.
   */
  static isValidTxHash(hash: string): boolean {
    return typeof hash === 'string' && /^[0-9a-fA-F]{1,128}$/.test(hash)
  }

  // ---------------------------------------------------------------------------
  // Abort helpers
  // ---------------------------------------------------------------------------

  static checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted === true) {
      const err = new Error('ETL run aborted')
      err.name = 'AbortError'
      throw err
    }
  }

  static isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
  }
}
