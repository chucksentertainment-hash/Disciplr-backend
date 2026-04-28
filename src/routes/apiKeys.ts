import { Router } from 'express'
import { z } from 'zod'
import { requireUserAuth } from '../middleware/userAuth.js'
import { apiKeyRateLimiter } from '../middleware/rateLimiter.js'
import { createApiKey, listApiKeysForUser, revokeApiKey } from '../services/apiKeys.js'
import { formatValidationError } from '../lib/validation.js'

export const apiKeysRouter = Router()

apiKeysRouter.use(requireUserAuth)

const createApiKeySchema = z.object({
  label: z.string().trim().min(1, 'label is required.'),
  scopes: z.array(z.string().trim().min(1, 'scope must be a non-empty string.')),
  orgId: z.string().trim().optional(),
})

apiKeysRouter.get('/', (req, res) => {
  const userId = req.authUser!.userId
  const apiKeys = listApiKeysForUser(userId).map(({ keyHash: _keyHash, ...publicRecord }) => publicRecord)

  res.json({ apiKeys })
})

apiKeysRouter.post('/', apiKeyRateLimiter, (req, res) => {
  const userId = req.authUser!.userId
  const parseResult = createApiKeySchema.safeParse(req.body)
  if (!parseResult.success) {
    res.status(400).json(formatValidationError(parseResult.error))
    return
  }

  const { label, scopes, orgId } = parseResult.data

  const { apiKey, record } = createApiKey({
    userId,
    orgId: orgId?.trim() || undefined,
    label,
    scopes,
  })

  const { keyHash: _keyHash, ...publicRecord } = record
  res.status(201).json({
    apiKey,
    apiKeyMeta: publicRecord,
  })
})

apiKeysRouter.post('/:id/revoke', (req, res) => {
  const userId = req.authUser!.userId
  const record = revokeApiKey(req.params.id, userId)

  if (!record) {
    res.status(404).json({ error: 'API key not found.' })
    return
  }

  const { keyHash: _keyHash, ...publicRecord } = record
  res.json({ apiKeyMeta: publicRecord })
})
