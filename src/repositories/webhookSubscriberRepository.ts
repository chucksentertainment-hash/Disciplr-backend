import { Knex } from 'knex'
import type { WebhookSubscriber } from '../services/webhooks.js'

interface SubscriberRow {
  id: string
  organization_id: string
  url: string
  secret: string
  events: string[]
  active: boolean
  created_at: Date
  updated_at: Date
}

function toSubscriber(row: SubscriberRow): WebhookSubscriber {
  return {
    id: row.id,
    organizationId: row.organization_id,
    url: row.url,
    secret: row.secret,
    events: row.events ?? [],
    active: row.active,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
  }
}

export class WebhookSubscriberRepository {
  constructor(private readonly db: Knex) {}

  async findByOrg(organizationId: string): Promise<WebhookSubscriber[]> {
    const rows = await this.db<SubscriberRow>('webhook_subscribers')
      .where({ organization_id: organizationId, active: true })
      .orderBy('created_at', 'asc')
    return rows.map(toSubscriber)
  }

  async findByEvent(organizationId: string, eventType: string): Promise<WebhookSubscriber[]> {
    const rows = await this.db<SubscriberRow>('webhook_subscribers')
      .where({ organization_id: organizationId, active: true })
      .andWhere(function () {
        this.whereRaw("events = '[]'::jsonb").orWhereRaw('events @> ?', [JSON.stringify([eventType])])
      })
      .orderBy('created_at', 'asc')
    return rows.map(toSubscriber)
  }

  async create(data: {
    organizationId: string
    url: string
    secret: string
    events: string[]
  }): Promise<WebhookSubscriber> {
    const [row] = await this.db<SubscriberRow>('webhook_subscribers')
      .insert({
        organization_id: data.organizationId,
        url: data.url,
        secret: data.secret,
        events: JSON.stringify(data.events) as any,
      })
      .returning('*')
    return toSubscriber(row)
  }

  async deactivate(id: string): Promise<boolean> {
    const count = await this.db('webhook_subscribers')
      .where({ id })
      .update({ active: false, updated_at: this.db.fn.now() })
    return count > 0
  }

  async remove(id: string): Promise<boolean> {
    const count = await this.db('webhook_subscribers').where({ id }).del()
    return count > 0
  }
}
