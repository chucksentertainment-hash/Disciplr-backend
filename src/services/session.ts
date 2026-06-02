import db from '../db/index.js'
import { randomUUID } from 'node:crypto'

export interface SessionRecord {
  id: string
  user_id: string
  jti: string
  revoked_at: string | null
  expires_at: string
  created_at: string
}

export const recordSession = async (userId: string, jti: string, expiresAt: Date): Promise<void> => {
  await db('sessions').insert({
    user_id: userId,
    jti,
    expires_at: expiresAt.toISOString(),
  })
}

export const validateSession = async (jti: string): Promise<boolean> => {
  const session = await db('sessions')
    .where({ jti })
    .whereNull('revoked_at')
    .andWhere('expires_at', '>', new Date().toISOString())
    .first()

  return !!session
}

export const revokeSession = async (jti: string): Promise<void> => {
  await db('sessions')
    .where({ jti })
    .update({ revoked_at: new Date().toISOString() })
}

export const revokeAllUserSessions = async (userId: string): Promise<void> => {
  await db('sessions')
    .where({ user_id: userId })
    .whereNull('revoked_at')
    .update({ revoked_at: new Date().toISOString() })
}

export const forceRevokeUserSessions = async (userId: string): Promise<void> => {
  // Same as revokeAllUserSessions, but named for admin clarity
  await revokeAllUserSessions(userId)
}

/**
 * Delete expired sessions older than 30 days in batches.
 * Returns the total number of rows deleted.
 * Accepts an optional knex instance for testing.
 */
export const cleanupExpiredSessions = async (
  batchSize = 1000,
  knex: typeof db = db,
): Promise<number> => {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  let total = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const deleted: number = await knex('sessions')
      .whereRaw('expires_at < ?', [cutoff])
      .andWhereRaw('id IN (SELECT id FROM sessions WHERE expires_at < ? LIMIT ?)', [cutoff, batchSize])
      .delete()

    total += deleted
    if (deleted < batchSize) break
  }

  return total
}
