import type { Server } from 'node:http'
import { BackgroundJobSystem } from '../jobs/system.js'
import { ETLWorker } from '../services/etlWorker.js'

export interface ShutdownOptions {
  server: Server
  jobSystem: BackgroundJobSystem
  etlWorker: ETLWorker
  closeDb: () => void
}

/**
 * Creates a graceful shutdown handler with all necessary dependencies.
 *
 * Execution order:
 * 1. Stop ETL worker (prevents new syncs).
 * 2. Stop Job System (prevents new jobs, waits for active ones).
 * 3. Close HTTP server (prevents new requests).
 * 4. Close Database connection.
 */
export function createShutdownHandler(options: ShutdownOptions) {
  const { server, jobSystem, etlWorker, closeDb } = options
  let shuttingDown = false

  return async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return
    }

    shuttingDown = true
    console.log(`[Shutdown] Received ${signal}. Starting graceful shutdown...`)

    try {
      // 1. Stop ETL Worker
      console.log('[Shutdown] Stopping ETL worker...')
      await etlWorker.stop()

      // 2. Stop Job System
      console.log('[Shutdown] Stopping background job system...')
      await jobSystem.stop()

      // 3. Close HTTP Server
      console.log('[Shutdown] Closing HTTP server...')
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
      console.log('[Shutdown] HTTP server closed')

      // 4. Close Database
      console.log('[Shutdown] Closing database connection...')
      closeDb()

      console.log('[Shutdown] Graceful shutdown completed successfully')
      process.exit(0)
    } catch (error) {
      console.error('[Shutdown] Failed during graceful shutdown:', error)
      process.exit(1)
    }
  }
}
