import Database, { Database as DatabaseType } from 'better-sqlite3'
import type { Pool } from 'pg'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { subDays, subYears } from 'date-fns'
import { utcStartOfDay, utcEndOfDay } from '../utils/timestamps.js'
import { getPgPool } from './pool.js'

let _filename: string
let _dirname: string

try {
  // @ts-ignore test runtime shim
  _filename = fileURLToPath(import.meta.url)
  _dirname = path.dirname(_filename)
} catch {
  _filename = __filename
  _dirname = __dirname
}

const dbPath = path.join(_dirname, '../../data/disciplr.db')
const dataDir = path.dirname(dbPath)
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

const createFallbackDb = (): DatabaseType =>
  ({
    pragma: () => undefined,
    exec: () => undefined,
    prepare: () => ({
      get: () => null,
      run: () => undefined,
      all: () => [],
    }),
    close: () => undefined,
  }) as unknown as DatabaseType

export const db: DatabaseType = (() => {
  try {
    const database = new Database(dbPath)
    database.pragma('journal_mode = WAL')
    return database
  } catch {
    console.warn('better-sqlite3 unavailable, using no-op analytics database fallback')
    return createFallbackDb()
  }
})()

type AnalyticsStatsRow = {
  total_vaults: number
  active_vaults: number
  completed_vaults: number
  failed_vaults: number
  total_locked_capital: number | null
  active_capital: number | null
}

export type AnalyticsSummaryRow = {
  total_vaults: number
  active_vaults: number
  completed_vaults: number
  failed_vaults: number
  total_locked_capital: string
  active_capital: string
  success_rate: number
  last_updated: string
}

const analyticsStorage = (process.env.ANALYTICS_STORAGE ?? '').toLowerCase()
const dualWriteEnabled = process.env.ANALYTICS_DUAL_WRITE === 'true'
const shouldUsePostgres = analyticsStorage === 'postgres'

const getPoolIfEnabled = (): Pool | null => {
  if (!shouldUsePostgres && !dualWriteEnabled) {
    return null
  }
  return getPgPool()
}

const initializeSqliteSchema = (): void => {
  const sqliteDb = getDb()
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS vaults (
      id TEXT PRIMARY KEY,
      creator TEXT NOT NULL,
      amount TEXT NOT NULL,
      start_timestamp TEXT NOT NULL,
      end_timestamp TEXT NOT NULL,
      success_destination TEXT NOT NULL,
      failure_destination TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_vaults_status ON vaults(status);
    CREATE INDEX IF NOT EXISTS idx_vaults_created_at ON vaults(created_at);
    CREATE INDEX IF NOT EXISTS idx_vaults_start_timestamp ON vaults(start_timestamp);
    CREATE INDEX IF NOT EXISTS idx_vaults_status_created_at ON vaults(status, created_at);

    CREATE TABLE IF NOT EXISTS vault_analytics_summary (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_vaults INTEGER NOT NULL DEFAULT 0,
      active_vaults INTEGER NOT NULL DEFAULT 0,
      completed_vaults INTEGER NOT NULL DEFAULT 0,
      failed_vaults INTEGER NOT NULL DEFAULT 0,
      total_locked_capital TEXT NOT NULL DEFAULT '0',
      active_capital TEXT NOT NULL DEFAULT '0',
      success_rate REAL NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL
    );
  `)

  const summary = sqliteDb.prepare('SELECT id FROM vault_analytics_summary WHERE id = 1').get()
  if (!summary) {
    sqliteDb
      .prepare(`
        INSERT INTO vault_analytics_summary (
          id, total_vaults, active_vaults, completed_vaults, failed_vaults,
          total_locked_capital, active_capital, success_rate, last_updated
        )
        VALUES (1, 0, 0, 0, 0, '0', '0', 0, datetime('now'))
      `)
      .run()
  }
}

const initializePostgresSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_vault_summary (
      id SMALLINT PRIMARY KEY,
      total_vaults INTEGER NOT NULL DEFAULT 0,
      active_vaults INTEGER NOT NULL DEFAULT 0,
      completed_vaults INTEGER NOT NULL DEFAULT 0,
      failed_vaults INTEGER NOT NULL DEFAULT 0,
      total_locked_capital NUMERIC(20,7) NOT NULL DEFAULT 0,
      active_capital NUMERIC(20,7) NOT NULL DEFAULT 0,
      success_rate NUMERIC(10,4) NOT NULL DEFAULT 0,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS analytics_vault_daily_rollups (
      bucket_date DATE PRIMARY KEY,
      total_vaults INTEGER NOT NULL DEFAULT 0,
      active_vaults INTEGER NOT NULL DEFAULT 0,
      completed_vaults INTEGER NOT NULL DEFAULT 0,
      failed_vaults INTEGER NOT NULL DEFAULT 0,
      total_locked_capital NUMERIC(20,7) NOT NULL DEFAULT 0,
      active_capital NUMERIC(20,7) NOT NULL DEFAULT 0,
      success_rate NUMERIC(10,4) NOT NULL DEFAULT 0,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_analytics_rollups_last_updated
    ON analytics_vault_daily_rollups(last_updated);
  `)
}

const getSQLiteStats = (startDate?: string, endDate?: string): AnalyticsStatsRow => {
  const sqliteDb = getDb()
  const where = startDate && endDate ? 'WHERE created_at >= ? AND created_at <= ?' : ''
  const stmt = sqliteDb.prepare(`
    SELECT
      COUNT(*) as total_vaults,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_vaults,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_vaults,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_vaults,
      SUM(CAST(amount AS REAL)) as total_locked_capital,
      SUM(CASE WHEN status = 'active' THEN CAST(amount AS REAL) ELSE 0 END) as active_capital
    FROM vaults
    ${where}
  `)
  const stats = (startDate && endDate ? stmt.get(startDate, endDate) : stmt.get()) as AnalyticsStatsRow | null
  return {
    total_vaults: stats?.total_vaults ?? 0,
    active_vaults: stats?.active_vaults ?? 0,
    completed_vaults: stats?.completed_vaults ?? 0,
    failed_vaults: stats?.failed_vaults ?? 0,
    total_locked_capital: stats?.total_locked_capital ?? 0,
    active_capital: stats?.active_capital ?? 0,
  }
}

const writeSQLiteSummary = (): void => {
  const sqliteDb = getDb()
  const stats = getSQLiteStats()
  const totalCompleted = stats.completed_vaults
  const totalFailed = stats.failed_vaults
  const successRate = totalCompleted + totalFailed > 0 ? (totalCompleted / (totalCompleted + totalFailed)) * 100 : 0

  sqliteDb
    .prepare(`
      UPDATE vault_analytics_summary SET
        total_vaults = ?,
        active_vaults = ?,
        completed_vaults = ?,
        failed_vaults = ?,
        total_locked_capital = ?,
        active_capital = ?,
        success_rate = ?,
        last_updated = datetime('now')
      WHERE id = 1
    `)
    .run(
      stats.total_vaults,
      stats.active_vaults,
      stats.completed_vaults,
      stats.failed_vaults,
      (stats.total_locked_capital ?? 0).toString(),
      (stats.active_capital ?? 0).toString(),
      successRate,
    )
}

const writePostgresSummary = async (pool: Pool): Promise<void> => {
  const { rows } = await pool.query<AnalyticsStatsRow>(`
    SELECT
      COUNT(*)::int as total_vaults,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)::int as active_vaults,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int as completed_vaults,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int as failed_vaults,
      SUM(CAST(amount AS numeric))::float as total_locked_capital,
      SUM(CASE WHEN status = 'active' THEN CAST(amount AS numeric) ELSE 0 END)::float as active_capital
    FROM vaults
  `)

  const stats = rows[0] ?? {
    total_vaults: 0,
    active_vaults: 0,
    completed_vaults: 0,
    failed_vaults: 0,
    total_locked_capital: 0,
    active_capital: 0,
  }
  const totalCompleted = stats.completed_vaults
  const totalFailed = stats.failed_vaults
  const successRate = totalCompleted + totalFailed > 0 ? (totalCompleted / (totalCompleted + totalFailed)) * 100 : 0

  await pool.query(
    `
      INSERT INTO analytics_vault_summary (
        id, total_vaults, active_vaults, completed_vaults, failed_vaults,
        total_locked_capital, active_capital, success_rate, last_updated
      )
      VALUES (1, $1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (id) DO UPDATE
      SET total_vaults = EXCLUDED.total_vaults,
          active_vaults = EXCLUDED.active_vaults,
          completed_vaults = EXCLUDED.completed_vaults,
          failed_vaults = EXCLUDED.failed_vaults,
          total_locked_capital = EXCLUDED.total_locked_capital,
          active_capital = EXCLUDED.active_capital,
          success_rate = EXCLUDED.success_rate,
          last_updated = NOW()
    `,
    [
      stats.total_vaults,
      stats.active_vaults,
      stats.completed_vaults,
      stats.failed_vaults,
      stats.total_locked_capital ?? 0,
      stats.active_capital ?? 0,
      successRate,
    ],
  )

  await pool.query(`
    INSERT INTO analytics_vault_daily_rollups (
      bucket_date, total_vaults, active_vaults, completed_vaults, failed_vaults,
      total_locked_capital, active_capital, success_rate, last_updated
    )
    SELECT
      DATE(created_at) as bucket_date,
      COUNT(*)::int as total_vaults,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)::int as active_vaults,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int as completed_vaults,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int as failed_vaults,
      SUM(CAST(amount AS numeric))::numeric(20,7) as total_locked_capital,
      SUM(CASE WHEN status = 'active' THEN CAST(amount AS numeric) ELSE 0 END)::numeric(20,7) as active_capital,
      CASE
        WHEN SUM(CASE WHEN status IN ('completed', 'failed') THEN 1 ELSE 0 END) = 0 THEN 0
        ELSE (
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::numeric
          / SUM(CASE WHEN status IN ('completed', 'failed') THEN 1 ELSE 0 END)::numeric
        ) * 100
      END as success_rate,
      NOW() as last_updated
    FROM vaults
    GROUP BY DATE(created_at)
    ON CONFLICT (bucket_date) DO UPDATE
    SET total_vaults = EXCLUDED.total_vaults,
        active_vaults = EXCLUDED.active_vaults,
        completed_vaults = EXCLUDED.completed_vaults,
        failed_vaults = EXCLUDED.failed_vaults,
        total_locked_capital = EXCLUDED.total_locked_capital,
        active_capital = EXCLUDED.active_capital,
        success_rate = EXCLUDED.success_rate,
        last_updated = NOW()
  `)
}

export function initializeDatabase(): void {
  initializeSqliteSchema()
  const pool = getPoolIfEnabled()
  if (pool) {
    void initializePostgresSchema(pool).catch((error) => {
      console.warn('PostgreSQL analytics schema initialization failed:', error)
    })
  }
}

export function closeDatabase(): void {
  db.close()
  const pool = getPoolIfEnabled()
  if (pool) {
    void pool.end().catch(() => undefined)
  }
}

export function updateAnalyticsSummary(): void {
  writeSQLiteSummary()
  const pool = getPoolIfEnabled()
  if (pool) {
    void writePostgresSummary(pool).catch((error) => {
      console.warn('PostgreSQL analytics summary update failed:', error)
    })
  }
}

const mapSummary = (row: Record<string, unknown>): AnalyticsSummaryRow => ({
  total_vaults: Number(row.total_vaults ?? 0),
  active_vaults: Number(row.active_vaults ?? 0),
  completed_vaults: Number(row.completed_vaults ?? 0),
  failed_vaults: Number(row.failed_vaults ?? 0),
  total_locked_capital: String(row.total_locked_capital ?? '0'),
  active_capital: String(row.active_capital ?? '0'),
  success_rate: Number(row.success_rate ?? 0),
  last_updated: String(row.last_updated ?? new Date().toISOString()),
})

export async function readAnalyticsSummary(): Promise<AnalyticsSummaryRow> {
  const pool = shouldUsePostgres ? getPoolIfEnabled() : null
  if (pool) {
    const { rows } = await pool.query<Record<string, unknown>>(`
      SELECT
        total_vaults,
        active_vaults,
        completed_vaults,
        failed_vaults,
        total_locked_capital::text,
        active_capital::text,
        success_rate::float,
        last_updated::text
      FROM analytics_vault_summary
      WHERE id = 1
    `)
    if (rows[0]) {
      return mapSummary(rows[0])
    }
  }

  const sqliteDb = getDb()
  const summary = sqliteDb.prepare(`
    SELECT
      total_vaults,
      active_vaults,
      completed_vaults,
      failed_vaults,
      total_locked_capital,
      active_capital,
      success_rate,
      last_updated
    FROM vault_analytics_summary
    WHERE id = 1
  `).get() as Record<string, unknown> | undefined

  return mapSummary(summary ?? {})
}

export async function queryVaultStatsByPeriod(startDate: string, endDate: string): Promise<AnalyticsStatsRow> {
  const pool = shouldUsePostgres ? getPoolIfEnabled() : null
  if (pool) {
    const { rows } = await pool.query<AnalyticsStatsRow>(
      `
        SELECT
          COUNT(*)::int as total_vaults,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)::int as active_vaults,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int as completed_vaults,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int as failed_vaults,
          SUM(CAST(amount AS numeric))::float as total_locked_capital,
          SUM(CASE WHEN status = 'active' THEN CAST(amount AS numeric) ELSE 0 END)::float as active_capital
        FROM vaults
        WHERE created_at >= $1 AND created_at <= $2
      `,
      [startDate, endDate],
    )
    return rows[0] ?? getSQLiteStats(startDate, endDate)
  }
  return getSQLiteStats(startDate, endDate)
}

export async function queryVaultStatusBreakdownByPeriod(
  startDate: string,
  endDate: string,
): Promise<Array<{ status: string; count: number }>> {
  const pool = shouldUsePostgres ? getPoolIfEnabled() : null
  if (pool) {
    const { rows } = await pool.query<{ status: string; count: string }>(
      `
        SELECT status, COUNT(*)::text as count
        FROM vaults
        WHERE created_at >= $1 AND created_at <= $2
        GROUP BY status
      `,
      [startDate, endDate],
    )
    return rows.map((row) => ({ status: row.status, count: Number(row.count) }))
  }

  const rows = getDb()
    .prepare(
      `
        SELECT status, COUNT(*) as count
        FROM vaults
        WHERE created_at >= ? AND created_at <= ?
        GROUP BY status
      `,
    )
    .all(startDate, endDate) as Array<{ status: string; count: number }>
  return rows
}

export async function queryVaultStatusBreakdownAllTime(): Promise<Array<{ status: string; count: number }>> {
  const pool = shouldUsePostgres ? getPoolIfEnabled() : null
  if (pool) {
    const { rows } = await pool.query<{ status: string; count: string }>(`
      SELECT status, COUNT(*)::text as count
      FROM vaults
      GROUP BY status
    `)
    return rows.map((row) => ({ status: row.status, count: Number(row.count) }))
  }

  return getDb().prepare('SELECT status, COUNT(*) as count FROM vaults GROUP BY status').all() as Array<{
    status: string
    count: number
  }>
}

export async function backfillAnalyticsStorage(): Promise<void> {
  const pool = getPoolIfEnabled()
  if (!pool) {
    return
  }
  await initializePostgresSchema(pool)
  await writePostgresSummary(pool)
}

export function getTimeRangeFilter(period: string): { startDate: string; endDate: string } {
  const now = new Date()
  const endDate = utcEndOfDay(now)
  let startDate: string

  switch (period) {
    case '7d':
      startDate = utcStartOfDay(subDays(now, 7))
      break
    case '30d':
      startDate = utcStartOfDay(subDays(now, 30))
      break
    case '90d':
      startDate = utcStartOfDay(subDays(now, 90))
      break
    case '1y':
      startDate = utcStartOfDay(subYears(now, 1))
      break
    default:
      return { startDate: new Date(0).toISOString(), endDate }
  }

  return { startDate, endDate }
}

function getDb(): DatabaseType {
  return db
}