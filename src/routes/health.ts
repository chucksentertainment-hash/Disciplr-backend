import { Router } from 'express'
import { BackgroundJobSystem } from '../jobs/system.js'

export const createHealthRouter = (jobSystem: BackgroundJobSystem) => {
  const router = Router()

  router.get('/', async (req, res) => {
    const healthData: any = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      jobs: jobSystem.getMetrics()
    };)
    }
    
    res.json(healthData)
  })

  return router
}

