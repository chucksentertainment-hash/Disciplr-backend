export type NotificationData = Record<string, unknown> | null

export interface Notification {
  id: string
  user_id: string
  type: string
  title: string
  message: string
  data: NotificationData
  idempotency_key: string | null
  read_at: string | null
  archived_at: string | null
  created_at: string
}

export interface CreateNotificationInput {
  user_id: string
  type: string
  title: string
  message: string
  data?: NotificationData
  idempotency_key?: string
}

export type NotificationSortField = 'created_at' | 'read_at' | 'title' | 'type'
export type NotificationReadStatus = 'all' | 'read' | 'unread'

export interface NotificationListOptions {
  page: number
  pageSize: number
  sortBy?: NotificationSortField
  sortOrder: 'asc' | 'desc'
  includeArchived?: boolean
  readStatus?: NotificationReadStatus
}

export interface NotificationListResult {
  data: Notification[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
    hasNext: boolean
    hasPrev: boolean
  }
  sort: {
    sortBy: NotificationSortField
    sortOrder: 'asc' | 'desc'
  }
}
