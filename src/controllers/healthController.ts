import type { Request, Response } from 'express'
import { healthService } from '../services/healthService.js'
import { config } from '../config/index.js'

export const getHealth = (_req: Request, res: Response) => {
  // Note: this controller is kept for structural consistency but the router
  // currently invokes healthService directly.
  res.json(healthService.buildHealthStatus(config.serviceName))
}

