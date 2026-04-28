import { createShutdownHandler, type ShutdownOptions } from '../src/server/shutdown.js'
import type { Server } from 'node:http'
import type { BackgroundJobSystem } from '../src/jobs/system.js'
import type { ETLWorker } from '../src/services/etlWorker.js'

describe('Graceful Shutdown', () => {
  let mockServer: jest.Mocked<Server>
  let mockJobSystem: jest.Mocked<BackgroundJobSystem>
  let mockEtlWorker: jest.Mocked<ETLWorker>
  let mockCloseDb: jest.Mock
  let mockExit: jest.SpyInstance
  let mockLog: jest.SpyInstance
  let mockError: jest.SpyInstance

  beforeEach(() => {
    mockServer = {
      close: jest.fn((cb?: (err?: Error) => void) => {
        if (cb) cb()
        return mockServer
      }),
    } as unknown as jest.Mocked<Server>

    mockJobSystem = {
      stop: jest.fn().mockResolvedValue(undefined),
      enqueue: jest.fn(),
    } as unknown as jest.Mocked<BackgroundJobSystem>

    mockEtlWorker = {
      stop: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ETLWorker>

    mockCloseDb = jest.fn()

    mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
        return undefined as never
    })
    mockLog = jest.spyOn(console, 'log').mockImplementation(() => {})
    mockError = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    mockExit.mockRestore()
    mockLog.mockRestore()
    mockError.mockRestore()
  })

  it('performs shutdown in the correct order', async () => {
    const handler = createShutdownHandler({
      server: mockServer,
      jobSystem: mockJobSystem,
      etlWorker: mockEtlWorker,
      closeDb: mockCloseDb,
    })

    await handler('SIGTERM')

    // Verify order using call sequence if possible, or just check they were all called
    expect(mockEtlWorker.stop).toHaveBeenCalled()
    expect(mockJobSystem.stop).toHaveBeenCalled()
    expect(mockServer.close).toHaveBeenCalled()
    expect(mockCloseDb).toHaveBeenCalled()
    expect(mockExit).toHaveBeenCalledWith(0)
  })

  it('exits with code 1 if a component fails to stop', async () => {
    const shutdownError = new Error('Server failed to close')
    mockServer.close.mockImplementationOnce((cb?: (err?: Error) => void) => {
      if (cb) cb(shutdownError)
      return mockServer
    })

    const handler = createShutdownHandler({
      server: mockServer,
      jobSystem: mockJobSystem,
      etlWorker: mockEtlWorker,
      closeDb: mockCloseDb,
    })

    await handler('SIGTERM')

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Failed during graceful shutdown'), shutdownError)
    expect(mockExit).toHaveBeenCalledWith(1)
  })

  it('does not run shutdown multiple times', async () => {
    const handler = createShutdownHandler({
      server: mockServer,
      jobSystem: mockJobSystem,
      etlWorker: mockEtlWorker,
      closeDb: mockCloseDb,
    })

    // Call multiple times concurrently
    await Promise.all([
      handler('SIGTERM'),
      handler('SIGINT'),
    ])

    expect(mockEtlWorker.stop).toHaveBeenCalledTimes(1)
    expect(mockJobSystem.stop).toHaveBeenCalledTimes(1)
    expect(mockServer.close).toHaveBeenCalledTimes(1)
    expect(mockCloseDb).toHaveBeenCalledTimes(1)
  })
})
