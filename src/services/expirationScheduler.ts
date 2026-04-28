import { markVaultExpiries } from './vault.js'

const BATCH_SIZE = 50

let intervalId: ReturnType<typeof setInterval> | null = null

export const processExpiredVaultsBatch = async (): Promise<number> => {
  const expiredCount = await markVaultExpiries({ limit: BATCH_SIZE })
  if (expiredCount > 0) {
    console.log(`[ExpirationChecker] Failed ${expiredCount} expired vault(s)`)
  }
  return expiredCount
}

export const startExpirationChecker = (intervalMs = 60_000): void => {
  if (intervalId) return

  const runCheck = async () => {
    try {
      await processExpiredVaultsBatch()
    } catch (error) {
      console.error('[ExpirationChecker] Check failed:', error)
    }
  }

  runCheck()

  intervalId = setInterval(runCheck, intervalMs)
  intervalId.unref()
}

export const stopExpirationChecker = (): void => {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
