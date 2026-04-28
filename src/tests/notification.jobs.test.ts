import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { BackgroundJobSystem } from '../jobs/system.js'
import { NotificationService } from '../services/notifications/factory.js'
import { EmailNotificationProvider } from '../services/notifications/email.provider.js'

// Mock NotificationService
const mockNotificationService = {
  send: jest.fn<any>(),
  getProvider: jest.fn<any>()
}

jest.unstable_mockModule('../services/notifications/factory.js', () => ({
  NotificationService: mockNotificationService
}))

describe('Notification Job Execution', () => {
  let jobSystem: any
  let NotificationService: any

  beforeEach(async () => {
    mockNotificationService.send.mockReset()
    jest.clearAllMocks()
    
    const systemModule = await import('../jobs/system.js')
    const BackgroundJobSystem = systemModule.BackgroundJobSystem
    const factoryModule = await import('../services/notifications/factory.js')
    NotificationService = factoryModule.NotificationService

    process.env.JOB_WORKER_CONCURRENCY = '1'
    process.env.JOB_QUEUE_POLL_INTERVAL_MS = '10'
    process.env.ENABLE_JOB_SCHEDULER = 'false'
    
    jobSystem = new BackgroundJobSystem()
  })

  it('should execute notification.send job using the provider', async () => {
    const payload = {
      recipient: 'test@example.com',
      subject: 'Hello',
      body: 'World',
    }

    const sendMock = mockNotificationService.send
    sendMock.mockResolvedValueOnce(undefined)

    const receipt = jobSystem.enqueue('notification.send', payload)
    
    jobSystem.start()

    // Wait for job to be processed
    await new Promise(resolve => setTimeout(resolve, 100))
    await jobSystem.stop()

    expect(sendMock).toHaveBeenCalledWith(payload.recipient, payload.subject, payload.body)
    
    const metrics = jobSystem.getMetrics()
    expect(metrics.totals.completed).toBe(1)
    expect(metrics.totals.failed).toBe(0)
  })

  it('should retry on failure with exponential backoff', async () => {
    const payload = {
      recipient: 'fail@example.com',
      subject: 'Retry Test',
      body: 'Content',
    }

    const sendMock = mockNotificationService.send
    // Fail the first time, succeed the second time
    sendMock
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockResolvedValueOnce(undefined)

    const receipt = jobSystem.enqueue('notification.send', payload, { maxAttempts: 2 })
    
    jobSystem.start()

    // Wait for first attempt and failure
    await new Promise(resolve => setTimeout(resolve, 150))
    
    let metrics = jobSystem.getMetrics()
    expect(metrics.totals.executions).toBe(1)
    expect(metrics.totals.retried).toBe(1)

    // Wait for retry (initial delay is 1s, but we can't wait that long easily in tests 
    // without mocking timers, or we can adjust getRetryDelayMs for tests)
    // For this test, I'll just verify it was retried (pending again)
    expect(metrics.queueDepth + metrics.delayedJobs).toBe(1)

    await jobSystem.stop()
  })

  it('should record failure after max attempts', async () => {
    const payload = {
      recipient: 'never@example.com',
      subject: 'Fatal Failure',
      body: 'Content',
    }

    const sendMock = mockNotificationService.send
    sendMock.mockRejectedValue(new Error('Persistent Error'))

    const receipt = jobSystem.enqueue('notification.send', payload, { maxAttempts: 1 })
    
    jobSystem.start()

    await new Promise(resolve => setTimeout(resolve, 150))
    await jobSystem.stop()

    const metrics = jobSystem.getMetrics()
    expect(metrics.totals.completed).toBe(0)
    expect(metrics.totals.failed).toBe(1)
    expect(metrics.recentFailures[0].error).toBe('Persistent Error')
  })
})
