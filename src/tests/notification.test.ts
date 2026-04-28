import express from 'express'
import request from 'supertest'
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals'

type MockBuilder = ReturnType<typeof createBuilder>

const dbMock = jest.fn<any>()
const validateSessionMock = jest.fn<any>().mockResolvedValue(true)
const recordSessionMock = jest.fn<any>().mockResolvedValue(undefined)

jest.unstable_mockModule('../db/index.js', () => ({
  db: dbMock,
}))

jest.unstable_mockModule('../services/session.js', () => ({
  validateSession: validateSessionMock,
  recordSession: recordSessionMock,
  revokeSession: jest.fn<any>().mockResolvedValue(undefined),
  revokeAllUserSessions: jest.fn<any>().mockResolvedValue(undefined),
  forceRevokeUserSessions: jest.fn<any>().mockResolvedValue(undefined),
}))

function createBuilder() {
  const builder: Record<string, any> = {}

  builder.insert = jest.fn<any>().mockReturnValue(builder)
  builder.returning = jest.fn<any>()
  builder.where = jest.fn<any>().mockReturnValue(builder)
  builder.whereNull = jest.fn<any>().mockReturnValue(builder)
  builder.whereNotNull = jest.fn<any>().mockReturnValue(builder)
  builder.orderBy = jest.fn<any>().mockReturnValue(builder)
  builder.limit = jest.fn<any>().mockReturnValue(builder)
  builder.offset = jest.fn<any>().mockReturnValue(builder)
  builder.select = jest.fn<any>()
  builder.update = jest.fn<any>().mockReturnValue(builder)
  builder.first = jest.fn<any>()
  builder.count = jest.fn<any>().mockReturnValue(builder)

  return builder
}

const makeNotification = (overrides: Record<string, unknown> = {}) => ({
  id: 'notif-1',
  user_id: 'user-1',
  type: 'vault_failure',
  title: 'Vault Deadline Reached',
  message: 'A vault in your account has expired and been marked as failed.',
  data: { vaultId: 'vault-1' },
  idempotency_key: null,
  read_at: null,
  archived_at: null,
  created_at: '2026-04-24T10:00:00.000Z',
  ...overrides,
})

let app: express.Express
let signToken: any
let createNotification: typeof import('../services/notification.js').createNotification
let listUserNotifications: typeof import('../services/notification.js').listUserNotifications
let markAsRead: typeof import('../services/notification.js').markAsRead
let markAllAsRead: typeof import('../services/notification.js').markAllAsRead
let archiveNotification: typeof import('../services/notification.js').archiveNotification

const authHeaderFor = async (userId: string) => {
  const token = await signToken({ userId, role: 'USER' })
  return `Bearer ${token}`
}

beforeAll(async () => {
  const { notificationsRouter } = await import('../routes/notifications.js')
  const authModule = await import('../middleware/auth.js')
  const notificationModule = await import('../services/notification.js')

  signToken = authModule.signToken
  createNotification = notificationModule.createNotification
  listUserNotifications = notificationModule.listUserNotifications
  markAsRead = notificationModule.markAsRead
  markAllAsRead = notificationModule.markAllAsRead
  archiveNotification = notificationModule.archiveNotification

  app = express()
  app.use(express.json())
  app.use('/api/notifications', notificationsRouter)
})

beforeEach(() => {
  dbMock.mockReset()
  validateSessionMock.mockClear()
  recordSessionMock.mockClear()
  jest.restoreAllMocks()
})

describe('Notifications API authz', () => {
  it('requires authentication for inbox access', async () => {
    const response = await request(app).get('/api/notifications')

    expect(response.status).toBe(401)
    expect(response.body.error).toMatch(/Authorization/i)
  })

  it('lists only the authenticated user inbox with pagination and sorting metadata', async () => {
    const countBuilder = createBuilder()
    const dataBuilder = createBuilder()
    dbMock.mockReturnValueOnce(countBuilder).mockReturnValueOnce(dataBuilder)
    countBuilder.first.mockResolvedValueOnce({ total: '2' })
    dataBuilder.select.mockResolvedValueOnce([
      makeNotification({ id: 'notif-b', title: 'B notice', user_id: 'user-1' }),
    ])

    const response = await request(app)
      .get('/api/notifications?page=2&pageSize=1&sortBy=title&sortOrder=asc&status=unread')
      .set('Authorization', await authHeaderFor('user-1'))

    expect(response.status).toBe(200)
    expect(response.body.pagination).toEqual({
      page: 2,
      pageSize: 1,
      total: 2,
      totalPages: 2,
      hasNext: false,
      hasPrev: true,
    })
    expect(response.body.sort).toEqual({ sortBy: 'title', sortOrder: 'asc' })
    expect(response.body.data).toHaveLength(1)
    expect(countBuilder.where).toHaveBeenCalledWith({ user_id: 'user-1' })
    expect(dataBuilder.where).toHaveBeenCalledWith({ user_id: 'user-1' })
    expect(countBuilder.whereNull).toHaveBeenCalledWith('archived_at')
    expect(dataBuilder.whereNull).toHaveBeenCalledWith('archived_at')
    expect(countBuilder.whereNull).toHaveBeenCalledWith('read_at')
    expect(dataBuilder.whereNull).toHaveBeenCalledWith('read_at')
    expect(dataBuilder.orderBy).toHaveBeenNthCalledWith(1, 'title', 'asc')
    expect(dataBuilder.orderBy).toHaveBeenNthCalledWith(2, 'id', 'asc')
    expect(dataBuilder.limit).toHaveBeenCalledWith(1)
    expect(dataBuilder.offset).toHaveBeenCalledWith(1)
  })

  it('rejects invalid sort fields', async () => {
    const response = await request(app)
      .get('/api/notifications?sortBy=user_id')
      .set('Authorization', await authHeaderFor('user-1'))

    expect(response.status).toBe(400)
    expect(response.body.error).toMatch(/Invalid sort field/i)
  })

  it('marks only the authenticated user notification as read', async () => {
    const builder = createBuilder()
    dbMock.mockReturnValueOnce(builder)
    builder.returning.mockResolvedValueOnce([
      makeNotification({ id: 'notif-read', user_id: 'user-1', read_at: '2026-04-24T10:05:00.000Z' }),
    ])

    const response = await request(app)
      .patch('/api/notifications/notif-read/read')
      .set('Authorization', await authHeaderFor('user-1'))

    expect(response.status).toBe(200)
    expect(response.body.id).toBe('notif-read')
    expect(builder.where).toHaveBeenCalledWith({ id: 'notif-read', user_id: 'user-1' })
    expect(builder.whereNull).toHaveBeenCalledWith('archived_at')
  })

  it('does not allow a user to mark another user notification as read', async () => {
    const builder = createBuilder()
    dbMock.mockReturnValueOnce(builder)
    builder.returning.mockResolvedValueOnce([])

    const response = await request(app)
      .patch('/api/notifications/notif-other/read')
      .set('Authorization', await authHeaderFor('user-1'))

    expect(response.status).toBe(404)
    expect(response.body.error).toBe('Notification not found')
    expect(builder.where).toHaveBeenCalledWith({ id: 'notif-other', user_id: 'user-1' })
  })

  it('marks all unread notifications as read for the authenticated user only', async () => {
    const builder = createBuilder()
    dbMock.mockReturnValueOnce(builder)
    builder.update.mockResolvedValueOnce(3)

    const response = await request(app)
      .post('/api/notifications/read-all')
      .set('Authorization', await authHeaderFor('user-7'))

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ updated: 3 })
    expect(builder.where).toHaveBeenCalledWith({ user_id: 'user-7' })
    expect(builder.whereNull).toHaveBeenNthCalledWith(1, 'archived_at')
    expect(builder.whereNull).toHaveBeenNthCalledWith(2, 'read_at')
  })

  it('archives only the authenticated user notification', async () => {
    const builder = createBuilder()
    dbMock.mockReturnValueOnce(builder)
    builder.returning.mockResolvedValueOnce([
      makeNotification({ id: 'notif-archive', user_id: 'user-1', archived_at: '2026-04-24T10:06:00.000Z' }),
    ])

    const response = await request(app)
      .delete('/api/notifications/notif-archive')
      .set('Authorization', await authHeaderFor('user-1'))

    expect(response.status).toBe(200)
    expect(response.body.message).toBe('Notification archived')
    expect(response.body.notification.archived_at).toBe('2026-04-24T10:06:00.000Z')
    expect(builder.where).toHaveBeenCalledWith({ id: 'notif-archive', user_id: 'user-1' })
    expect(builder.whereNull).toHaveBeenCalledWith('archived_at')
  })

  it('does not allow a user to archive another user notification', async () => {
    const builder = createBuilder()
    dbMock.mockReturnValueOnce(builder)
    builder.returning.mockResolvedValueOnce([])

    const response = await request(app)
      .delete('/api/notifications/notif-other')
      .set('Authorization', await authHeaderFor('user-1'))

    expect(response.status).toBe(404)
    expect(builder.where).toHaveBeenCalledWith({ id: 'notif-other', user_id: 'user-1' })
  })
})

describe('Notification service', () => {
  it('sanitizes notification messages and metadata before insert', async () => {
    const insertBuilder = createBuilder()
    dbMock.mockReturnValueOnce(insertBuilder)
    insertBuilder.returning.mockResolvedValueOnce([
      makeNotification({
        title: 'Vault Deadline Reached',
        message: 'Contact success_destination=GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ23 immediately.',
        data: { vaultId: 'vault-1', successDestination: 'GSECRETVALUE', amount: '1000' },
      }),
    ])

    await createNotification({
      user_id: 'user-1',
      type: 'vault_failure',
      title: 'Vault Deadline Reached',
      message: 'Contact success_destination=GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ23 immediately.',
      data: {
        vaultId: 'vault-1',
        successDestination: 'GSECRETVALUE',
        amount: '1000',
      },
    })

    expect(insertBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        data: { vaultId: 'vault-1' },
      }),
    )
    const insertedRow = insertBuilder.insert.mock.calls[0][0]
    expect(insertedRow.message).toContain('success_destination=[redacted]')
    expect(insertedRow.message).not.toContain('GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ23')
  })

  it('deduplicates idempotent notification creation without leaking user ownership', async () => {
    const insertBuilder = createBuilder()
    const lookupBuilder = createBuilder()
    dbMock.mockReturnValueOnce(insertBuilder).mockReturnValueOnce(lookupBuilder)
    insertBuilder.returning.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }))
    lookupBuilder.first.mockResolvedValueOnce(
      makeNotification({ id: 'notif-existing', idempotency_key: 'evt-1', user_id: 'user-99' }),
    )

    const result = await createNotification({
      user_id: 'user-99',
      type: 'vault_failure',
      title: 'Vault Deadline Reached',
      message: 'A vault in your account has expired and been marked as failed.',
      data: { vaultId: 'vault-99' },
      idempotency_key: 'evt-1',
    })

    expect(result.id).toBe('notif-existing')
    expect(lookupBuilder.where).toHaveBeenCalledWith({
      user_id: 'user-99',
      idempotency_key: 'evt-1',
    })
  })

  it('lists notifications with includeArchived support and read filters', async () => {
    const countBuilder = createBuilder()
    const dataBuilder = createBuilder()
    dbMock.mockReturnValueOnce(countBuilder).mockReturnValueOnce(dataBuilder)
    countBuilder.first.mockResolvedValueOnce({ total: '1' })
    dataBuilder.select.mockResolvedValueOnce([
      makeNotification({ id: 'notif-archived', archived_at: '2026-04-24T10:06:00.000Z', read_at: '2026-04-24T10:07:00.000Z' }),
    ])

    const result = await listUserNotifications('user-1', {
      page: 1,
      pageSize: 10,
      sortBy: 'created_at',
      sortOrder: 'desc',
      includeArchived: true,
      readStatus: 'read',
    })

    expect(result.pagination.total).toBe(1)
    expect(result.data[0].archived_at).toBe('2026-04-24T10:06:00.000Z')
    expect(countBuilder.whereNull).not.toHaveBeenCalledWith('archived_at')
    expect(dataBuilder.whereNull).not.toHaveBeenCalledWith('archived_at')
    expect(countBuilder.whereNotNull).toHaveBeenCalledWith('read_at')
    expect(dataBuilder.whereNotNull).toHaveBeenCalledWith('read_at')
  })

  it('returns null when markAsRead cannot find a notification owned by the user', async () => {
    const builder = createBuilder()
    dbMock.mockReturnValueOnce(builder)
    builder.returning.mockResolvedValueOnce([])

    const result = await markAsRead('notif-missing', 'user-1')

    expect(result).toBeNull()
    expect(builder.where).toHaveBeenCalledWith({ id: 'notif-missing', user_id: 'user-1' })
  })

  it('returns the number of owned unread notifications updated by markAllAsRead', async () => {
    const builder = createBuilder()
    dbMock.mockReturnValueOnce(builder)
    builder.update.mockResolvedValueOnce(2)

    const result = await markAllAsRead('user-1')

    expect(result).toBe(2)
    expect(builder.where).toHaveBeenCalledWith({ user_id: 'user-1' })
    expect(builder.whereNull).toHaveBeenNthCalledWith(1, 'archived_at')
    expect(builder.whereNull).toHaveBeenNthCalledWith(2, 'read_at')
  })

  it('returns null when archiveNotification targets another user record', async () => {
    const builder = createBuilder()
    dbMock.mockReturnValueOnce(builder)
    builder.returning.mockResolvedValueOnce([])

    const result = await archiveNotification('notif-2', 'user-1')

    expect(result).toBeNull()
    expect(builder.where).toHaveBeenCalledWith({ id: 'notif-2', user_id: 'user-1' })
    expect(builder.whereNull).toHaveBeenCalledWith('archived_at')
  })
})
