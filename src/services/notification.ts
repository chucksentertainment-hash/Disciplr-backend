import { db } from '../db/index.js'
import type {
  Notification,
  CreateNotificationInput,
  NotificationData,
  NotificationListOptions,
  NotificationListResult,
  NotificationSortField,
} from '../types/notification.js'

const DEFAULT_SORT_BY: NotificationSortField = 'created_at'
const SAFE_DATA_KEYS = new Set([
  'vaultId',
  'milestoneId',
  'transactionId',
  'organizationId',
  'verificationId',
  'eventId',
  'actionUrl',
  'resourceId',
  'resourceType',
  'category',
])

const log = {
  debug: (event: string, fields: { idempotency_key: string; id: string }) => {
    try {
      console.debug(JSON.stringify({ level: 'debug', event, ...fields }))
    } catch {
      // swallow logger errors
    }
  },
  info: (event: string, fields: { idempotency_key: string; id: string }) => {
    try {
      console.info(JSON.stringify({ level: 'info', event, ...fields }))
    } catch {
      // swallow logger errors
    }
  },
}

const redactSensitiveText = (value: string): string => {
  return value
    .replace(/\b[GS][A-Z2-7]{55}\b/g, '[redacted-account]')
    .replace(
      /\b(success_destination|failure_destination|privateKey|secretKey|seed|mnemonic|password|password_hash)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]',
    )
}

const sanitizeNotificationData = (value: NotificationData | undefined): NotificationData => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const sanitized = Object.entries(value).reduce<Record<string, unknown>>((acc, [key, entry]) => {
    if (SAFE_DATA_KEYS.has(key)) {
      acc[key] = entry
    }
    return acc
  }, {})

  return Object.keys(sanitized).length > 0 ? sanitized : null
}

const normalizeNotification = (row: any): Notification => {
  let parsedData: NotificationData = null

  if (row?.data && typeof row.data === 'string') {
    try {
      parsedData = sanitizeNotificationData(JSON.parse(row.data))
    } catch {
      parsedData = null
    }
  } else {
    parsedData = sanitizeNotificationData(row?.data)
  }

  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    title: row.title,
    message: row.message,
    data: parsedData,
    idempotency_key: row.idempotency_key ?? null,
    read_at: row.read_at ?? null,
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
  }
}

export const createNotification = async (input: CreateNotificationInput): Promise<Notification> => {
  const row: Record<string, unknown> = {
    user_id: input.user_id,
    type: input.type,
    title: redactSensitiveText(input.title),
    message: redactSensitiveText(input.message),
    data: sanitizeNotificationData(input.data),
  }

  if (input.idempotency_key !== undefined) {
    row.idempotency_key = input.idempotency_key
  }

  try {
    const [notification] = await db('notifications').insert(row).returning('*')

    if (input.idempotency_key) {
      log.debug('notification_created_with_key', {
        idempotency_key: input.idempotency_key,
        id: notification.id,
      })
    }

    return normalizeNotification(notification)
  } catch (err: any) {
    if (err.code === '23505' && input.idempotency_key) {
      const existing = await db('notifications')
        .where({ user_id: input.user_id, idempotency_key: input.idempotency_key })
        .first()

      if (!existing) {
        throw err
      }

      log.info('notification_dedupe_suppressed', {
        idempotency_key: input.idempotency_key,
        id: existing.id,
      })

      return normalizeNotification(existing)
    }

    throw err
  }
}

export const listUserNotifications = async (
  userId: string,
  options: NotificationListOptions,
): Promise<NotificationListResult> => {
  const sortBy = options.sortBy ?? DEFAULT_SORT_BY

  const countQuery = db('notifications').where({ user_id: userId })
  const dataQuery = db('notifications').where({ user_id: userId })

  if (!options.includeArchived) {
    countQuery.whereNull('archived_at')
    dataQuery.whereNull('archived_at')
  }

  if (options.readStatus === 'read') {
    countQuery.whereNotNull('read_at')
    dataQuery.whereNotNull('read_at')
  }

  if (options.readStatus === 'unread') {
    countQuery.whereNull('read_at')
    dataQuery.whereNull('read_at')
  }

  const totalRow = await countQuery.count('* as total').first()
  const total = parseInt(String(totalRow?.total ?? '0'), 10)

  const offset = (options.page - 1) * options.pageSize
  const rows = await dataQuery
    .orderBy(sortBy, options.sortOrder)
    .orderBy('id', options.sortOrder)
    .limit(options.pageSize)
    .offset(offset)
    .select('*')

  const totalPages = total === 0 ? 0 : Math.ceil(total / options.pageSize)

  return {
    data: rows.map(normalizeNotification),
    pagination: {
      page: options.page,
      pageSize: options.pageSize,
      total,
      totalPages,
      hasNext: options.page < totalPages,
      hasPrev: options.page > 1 && total > 0,
    },
    sort: {
      sortBy,
      sortOrder: options.sortOrder,
    },
  }
}

export const markAsRead = async (id: string, userId: string): Promise<Notification | null> => {
  const [notification] = await db('notifications')
    .where({ id, user_id: userId })
    .whereNull('archived_at')
    .update({ read_at: new Date().toISOString() })
    .returning('*')

  return notification ? normalizeNotification(notification) : null
}

export const markAllAsRead = async (userId: string): Promise<number> => {
  return db('notifications')
    .where({ user_id: userId })
    .whereNull('archived_at')
    .whereNull('read_at')
    .update({ read_at: new Date().toISOString() })
}

export const archiveNotification = async (
  id: string,
  userId: string,
): Promise<Notification | null> => {
  const [notification] = await db('notifications')
    .where({ id, user_id: userId })
    .whereNull('archived_at')
    .update({ archived_at: new Date().toISOString() })
    .returning('*')

  return notification ? normalizeNotification(notification) : null
}
