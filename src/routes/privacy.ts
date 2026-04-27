import { Router, Request, Response, NextFunction } from 'express'
import { utcNow } from '../utils/timestamps.js'
import { prisma } from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
import { AppError } from '../middleware/errorHandler.js'

export const privacyRouter = Router()

/**
 * GET /api/privacy/export?creator=<USER_ID>
 * Exports all data related to a specific creator.
 */
privacyRouter.get('/export', authenticate, async (req: Request, res: Response, next: NextFunction) => {
    const creator = req.query.creator as string

    if (!creator) {
        return next(AppError.badRequest('Missing required query parameter: creator'))
    }

    try {
        const userData = await prisma.vault.findMany({
            where: { creatorId: creator },
            include: {
                creator: {
                    select: { id: true}
                }
            }
        })

        res.json({
            creator,
            exportDate: utcNow(),
            data: {
                vaults: userData,
            },
        })
    } catch (error: any) {
        return next(AppError.internal(error.message))
    }
})

/**
 * DELETE /api/privacy/account?creator=<USER_ID>
 * Deletes all records associated with a specific creator.
 */
privacyRouter.delete('/account', authenticate, async (req: Request, res: Response, next: NextFunction) => {
    const creator = creatorIdFromQuery(req)

    if (!creator) {
        return next(AppError.badRequest('Missing required query parameter: creator'))
    }

    try {
        const deleteResult = await prisma.vault.deleteMany({
            where: { creatorId: creator }
        })

        if (deleteResult.count === 0) {
            return next(AppError.notFound('No data found for this creator'))
        }

        res.json({
            message: 'Account data has been deleted.',
            deletedCount: deleteResult.count,
            status: 'success'
        })
    } catch (error: any) {
        return next(AppError.internal(error.message))
    }
})

function creatorIdFromQuery(req: Request): string | undefined {
    return req.query.creator as string
}
