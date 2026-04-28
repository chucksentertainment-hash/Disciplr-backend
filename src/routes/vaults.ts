import { Router, type Request, type Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { UserRole } from '../types/user.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { updateAnalyticsSummary } from '../db/database.js'
import { createAuditLog } from '../lib/audit-logs.js'
import {
  IdempotencyConflictError,
  IdempotencyKeyValidationError,
  getIdempotentResponse,
  hashRequestPayload,
  saveIdempotentResponse,
  validateIdempotencyKey,
} from '../services/idempotency.js'
import { buildVaultCreationPayload } from '../services/soroban.js'
import { createVaultWithMilestones, getVaultById, listVaults, cancelVaultById } from '../services/vaultStore.js'
import { createVaultSchema } from '../services/vaultValidation.js'
import { queryParser } from '../middleware/queryParser.js'
import { utcNow } from '../utils/timestamps.js'
import { prisma } from '../lib/prisma.js'
import { requireJson } from '../middleware/requireJson.js'
import type { VaultCreateResponse } from '../types/vaults.js'
import { formatValidationError } from '../lib/validation.js'

export const vaultsRouter = Router()

// In-memory fallback (for development / legacy support)
export let vaults: any[] = []
export const setVaults = (newVaults: any[]) => { vaults = newVaults }

export interface Vault {
  id: string
  creator: string
  amount: string
  status: 'active' | 'completed' | 'failed' | 'cancelled'
  startTimestamp: string
  endTimestamp: string
  successDestination: string
  failureDestination: string
  createdAt: string
}

// GET /api/vaults

vaultsRouter.get(
  '/',
  authenticate,
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  async (req: Request, res: Response) => {
    try {
      let result = await listVaults()

      if (req.filters && applyFilters) result = applyFilters(result as any, req.filters)
      if (req.sort && applySort) result = applySort(result as any, req.sort)
      if (req.pagination && paginateArray) result = paginateArray(result as any, req.pagination) as any

      res.json(result)
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  },
)

/**
 * POST /api/vaults
 */
vaultsRouter.post('/', authenticate, requireJson, async (req: Request, res: Response) => {
  // 1. Idempotency – replay cached response if key+hash match
  const { creator, amount, endTimestamp, successDestination, failureDestination, milestoneHash, verifierAddress, contractId } = req.body
// POST /api/vaults 

vaultsRouter.post('/', authenticate, async (req: Request, res: Response) => {
  // 1. Idempotency – validate key format, then replay cached response if key+hash match
  const idempotencyKey = req.header('idempotency-key') ?? null

  if (idempotencyKey !== null) {
    try {
      validateIdempotencyKey(idempotencyKey)
    } catch (err) {
      if (err instanceof IdempotencyKeyValidationError) {
        res.status(400).json({ error: { code: err.code, message: err.message } })
        return
      }
      throw err
    }
  }

  const requestHash = hashRequestPayload(req.body)
  // Scope key to the authenticated user to prevent cross-user response leakage.
  const scopedKey = idempotencyKey !== null ? `${req.user!.userId}:${idempotencyKey}` : null

  if (scopedKey !== null) {
    try {
      const cached = await getIdempotentResponse<VaultCreateResponse>(scopedKey, requestHash)
      if (cached !== null) {
        res.status(200).json({ ...cached, idempotency: { key: idempotencyKey, replayed: true } })
        return
      }
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        res.status(409).json({ error: { code: err.code, message: err.message } })
        return
      }
      throw err
    }
  }

  // 2. Validate with Zod (Soroban-aligned bounds)
  const parseResult = createVaultSchema.safeParse(req.body)
  if (!parseResult.success) {
    res.status(400).json(formatValidationError(parseResult.error))
    return
  }

  const input = parseResult.data

  // 3. Persist and respond
  try {
    const { vault } = await createVaultWithMilestones(input)

    const responseBody: VaultCreateResponse = {
      vault,
      onChain: await buildVaultCreationPayload(input, vault),
      idempotency: { key: idempotencyKey, replayed: false },
    }

    if (idempotencyKey) {
      await saveIdempotentResponse(idempotencyKey!, requestHash, vault.id, responseBody)
    if (scopedKey !== null) {
      await saveIdempotentResponse(scopedKey, requestHash, vault.id, responseBody)
    }

    try {
      const actorUserId = (req.header('x-user-id') ?? input.creator) || req.user?.userId || 'unknown'
      createAuditLog({
        actor_user_id: actorUserId,
        action: 'vault.created',
        target_type: 'vault',
        target_id: vault.id,
        metadata: { creator: input.creator, amount: input.amount },
      })

      updateAnalyticsSummary()

      res.status(201).json(responseBody)
    } catch (error) {
      console.error('Vault creation failed', error)
      res.status(500).json({ error: 'Failed to create vault.' })
    }
  } catch (error) {
    console.error('Vault creation failed', error)
    res.status(500).json({ error: 'Failed to create vault.' })
  }
})

// ─── GET /api/vaults/:id ─────────────────────────────────────────────────────

vaultsRouter.get('/:id', authenticate, async (req: Request, res: Response) => {
  // Try DB-backed store first (falls back to in-memory automatically)
  try {
    const vault = await getVaultById(req.params.id)
    if (vault) {
      res.json(vault)
      return
    }
  } catch (_err) {
    // fall through to legacy in-memory array
  }

  // Legacy in-memory fallback
  const vault = vaults.find((v) => v.id === req.params.id)
  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }
  
  // Return the vault found in legacy in-memory storage
  res.json(vault)
})

// ─── POST /api/vaults/:id/cancel ─────────────────────────────────────────────

vaultsRouter.post('/:id/cancel', authenticate, async (req, res) => {
  const actorUserId = req.user!.userId
  const actorRole = req.user!.role

  let existingVault = await getVaultById(req.params.id)
  if (!existingVault) existingVault = vaults.find((v) => v.id === req.params.id)
  if (!existingVault) {
    existingVault = vaults.find((v) => v.id === req.params.id) ?? null
  }

  if (!existingVault) return res.status(404).json({ error: 'Vault not found' })

  if (actorUserId !== existingVault.creator && actorRole !== UserRole.ADMIN) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  // Capture previous status before cancellation
  const previousStatus = existingVault.status
  const cancellationReason = req.body.reason || 'User requested cancellation'

  try {
    const result = await cancelVaultById(req.params.id)
    if ('error' in result) {
      return res.status(400).json({ error: result.error })
      if (result.error === 'already_cancelled') {
        return res.status(409).json({ error: 'Vault is already cancelled' })
      }
      if (result.error === 'not_cancellable') {
        return res.status(409).json({ error: `Vault cannot be cancelled from status ${result.currentStatus}` })
      }
      return res.status(404).json({ error: 'Vault not found' })
    }
  } catch (_err) { /* non-fatal */ }

  const arrayIndex = vaults.findIndex((v) => v.id === req.params.id)
  if (arrayIndex !== -1) {
    vaults[arrayIndex].status = 'cancelled'
  }

  // Create audit log entry for vault cancellation
  createAuditLog({
    actor_user_id: actorUserId,
    action: 'vault.cancelled',
    target_type: 'vault',
    target_id: req.params.id,
    metadata: {
      previous_status: previousStatus,
      new_status: 'cancelled',
      reason: cancellationReason,
      cancelled_by: actorRole === UserRole.ADMIN ? 'admin' : 'creator',
      creator: existingVault.creator,
      amount: existingVault.amount,
    },
  })

  updateAnalyticsSummary()
  res.status(200).json({ message: 'Vault cancelled', id: req.params.id })
})

// GET /api/vaults/user/:address 
vaultsRouter.get('/user/:address', authenticate, async (req: Request, res: Response) => {
  try {
    const userVaults = await listVaults()
    const filteredVaults = userVaults.filter(vault => vault.creator === req.params.address)
    res.json(filteredVaults)
    const allVaults = await listVaults()
    const userVaults = allVaults.filter((vault) => vault.creator === req.params.address)
    res.json(userVaults)
  } catch (_err) {
    res.status(500).json({ error: 'Failed to fetch user vaults' })
  }
})
