import { BackgroundJobSystem } from '../src/jobs/system.js'
import { InMemoryJobQueue } from '../src/jobs/queue.js'

jest.mock('../src/jobs/queue.js')

describe('BackgroundJobSystem Shutdown Behavior', () => {
  let jobSystem: BackgroundJobSystem
  let mockQueue: jest.Mocked<InMemoryJobQueue>

  beforeEach(() => {
    jest.clearAllMocks()
    jobSystem = new BackgroundJobSystem()
    // @ts-ignore - accessing private property for testing
    mockQueue = jobSystem.queue as jest.Mocked<InMemoryJobQueue>
  })

  it('rejects new jobs after stop() is called', async () => {
    // Initially should accept jobs (mockQueue.enqueue is mocked)
    jobSystem.enqueue('deadline.check', { triggerSource: 'manual' })
    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1)

    // Stop the system
    await jobSystem.stop()

    // Now it should throw
    expect(() => {
      jobSystem.enqueue('deadline.check', { triggerSource: 'manual' })
    }).toThrow('Cannot enqueue job: system is shutting down')

    // Queue enqueue should not have been called again
    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1)
  })

  it('sets shuttingDown to true in stop()', async () => {
    await jobSystem.stop()
    // @ts-ignore - accessing private property
    expect(jobSystem.shuttingDown).toBe(true)
  })

  it('resets shuttingDown to false in start()', async () => {
    await jobSystem.stop()
    // @ts-ignore
    expect(jobSystem.shuttingDown).toBe(true)

    jobSystem.start()
    // @ts-ignore
    expect(jobSystem.shuttingDown).toBe(false)
  })
})
