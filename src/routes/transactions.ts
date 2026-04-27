import { Router, Request, Response, NextFunction } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { db } from '../db/index.js'
import { requireUserAuth } from '../middleware/userAuth.js'
import { AppError } from '../middleware/errorHandler.js'
import { TransactionRepository } from '../repositories/transactionRepository.js'

export const transactionsRouter = Router()
const transactionRepo = new TransactionRepository(db)

// GET /api/transactions - Get user's transaction history
transactionsRouter.get(
  '/',
  requireUserAuth,
  queryParser({
    allowedSortFields: ['created_at', 'stellar_timestamp', 'amount', 'type', 'stellar_ledger'],
    allowedFilterFields: ['type', 'vault_id', 'date_from', 'date_to', 'amount_min', 'amount_max'],
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.authUser!.userId
      const limit = Math.min(100, req.cursorPagination?.limit || 20)
      const cursor = req.cursorPagination?.cursor
      
      const filters = {
        vaultId: (Array.isArray(req.filters?.vault_id) ? req.filters?.vault_id[0] : req.filters?.vault_id) as string,
        type: (Array.isArray(req.filters?.type) ? req.filters?.type[0] : req.filters?.type) as string,
        dateFrom: req.filters?.date_from ? new Date((Array.isArray(req.filters.date_from) ? req.filters.date_from[0] : req.filters.date_from) as string) : undefined,
        dateTo: req.filters?.date_to ? new Date((Array.isArray(req.filters.date_to) ? req.filters.date_to[0] : req.filters.date_to) as string) : undefined,
        amountMin: (Array.isArray(req.filters?.amount_min) ? req.filters?.amount_min[0] : req.filters?.amount_min) as string,
        amountMax: (Array.isArray(req.filters?.amount_max) ? req.filters?.amount_max[0] : req.filters?.amount_max) as string,
      }

      // If page is provided explicitly, use page-based pagination
      if (req.query.page) {
        const page = Math.max(1, parseInt(req.query.page as string) || 1)
        const offset = (page - 1) * limit
        
        const { data, total } = await transactionRepo.list(userId, limit, offset, filters)
        
        res.json({
          data,
          pagination: {
            page,
            limit,
            total,
            total_pages: Math.ceil(total / limit),
            has_more: offset + limit < total
          }
        })
        return
      }

      // Otherwise use cursor-based
      const result = await transactionRepo.listWithCursor(userId, limit, cursor, filters)
      res.json(result)
    } catch (error: any) {
      if (error.message === 'Invalid cursor') {
        return next(AppError.badRequest('Invalid cursor'))
      }
      console.error('Error fetching transactions:', error)
      return next(AppError.internal('Internal server error'))
    }
  }
)

// GET /api/transactions/:id - Get specific transaction
transactionsRouter.get('/:id', requireUserAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.authUser!.userId
    const transactionId = req.params.id

    const transaction = await db('transactions')
      .where('id', transactionId)
      .where('user_id', userId)
      .first()

    if (!transaction) {
      return next(AppError.notFound('Transaction not found'))
    }

    res.json(transaction)
  } catch (error) {
    console.error('Error fetching transaction:', error)
    return next(AppError.internal('Internal server error'))
  }
})

// GET /api/transactions/vault/:vaultId - Get transactions for a specific vault
transactionsRouter.get(
  '/vault/:vaultId',
  requireUserAuth,
  queryParser({
    allowedSortFields: ['created_at', 'stellar_timestamp', 'amount', 'type'],
    allowedFilterFields: ['type', 'date_from', 'date_to', 'amount_min', 'amount_max'],
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.authUser!.userId
      const vaultId = req.params.vaultId

      // Verify user owns the vault
      const vault = await db('vaults')
        .where('id', vaultId)
        .where('user_id', userId)
        .first()

      if (!vault) {
        return next(AppError.notFound('Vault not found'))
      }

      const limit = Math.min(100, req.cursorPagination?.limit || 20)
      const cursor = req.cursorPagination?.cursor
      
      const filters = {
        vaultId: vaultId,
        type: (Array.isArray(req.filters?.type) ? req.filters?.type[0] : req.filters?.type) as string,
        dateFrom: req.filters?.date_from ? new Date((Array.isArray(req.filters.date_from) ? req.filters.date_from[0] : req.filters.date_from) as string) : undefined,
        dateTo: req.filters?.date_to ? new Date((Array.isArray(req.filters.date_to) ? req.filters.date_to[0] : req.filters.date_to) as string) : undefined,
        amountMin: (Array.isArray(req.filters?.amount_min) ? req.filters?.amount_min[0] : req.filters?.amount_min) as string,
        amountMax: (Array.isArray(req.filters?.amount_max) ? req.filters?.amount_max[0] : req.filters?.amount_max) as string,
      }

      const result = await transactionRepo.listWithCursor(userId, limit, cursor, filters)
      res.json(result)
    } catch (error: any) {
      if (error.message === 'Invalid cursor') {
        return next(AppError.badRequest('Invalid cursor'))
      }
      console.error('Error fetching vault transactions:', error)
      return next(AppError.internal('Internal server error'))
    }
  }
)
