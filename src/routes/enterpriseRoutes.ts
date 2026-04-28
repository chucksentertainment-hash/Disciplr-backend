import { Router, Response } from 'express';
import { db } from '../db/knex.js';
import { toPublicVault, toPublicMilestone } from '../utils/mappers.js';
import { maskPii } from '../utils/privacy.js';
import { authenticate } from '../middleware/auth.js';
import { enterpriseGuard } from '../middleware/enterpriseGuard.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import gr from 'debug';

const debug = gr('disciplr:api:enterprise');
const router = Router();

// Apply enterprise-wide authorization
router.use(authenticate);
router.use(enterpriseGuard);

/**
 * @route GET /api/v1/enterprise/vaults/:id
 * @desc Fetches a vault by ID with strict exposure audit applied.
 * Enforces enterprise-level isolation via organization_id check.
 */
router.get('/vaults/:id', async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const enterpriseId = req.user?.enterpriseId;
  
  try {
    // Validate identifier and ownership to prevent guessing/leakage
    const vault = await db('vaults')
      .where({ id, organization_id: enterpriseId })
      .first();
    
    if (!vault) {
      // Consistent response for missing or unauthorized access
      return res.status(404).json({ error: 'Vault not found' });
    }

    // Audit Logging: Mask PII in observability output
    debug('Fetching vault %s for enterprise %s', id, enterpriseId);

    // Exposure Audit: Map to public DTO to strip internal fields
    const publicVault = toPublicVault(vault);
    
    return res.json(publicVault);
  } catch (error) {
    debug('Error fetching vault %s: %O', id, error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @route GET /api/v1/enterprise/vaults/:id/milestones
 * @desc Fetches milestones for a vault with strict exposure audit.
 * Enforces enterprise-level isolation.
 */
router.get('/vaults/:id/milestones', async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const enterpriseId = req.user?.enterpriseId;
  
  try {
    // Verify vault ownership first
    const vault = await db('vaults')
      .where({ id, organization_id: enterpriseId })
      .select('id')
      .first();

    if (!vault) {
      return res.status(404).json({ error: 'Vault not found' });
    }

    const milestones = await db('milestones').where({ vault_id: id });
    
    debug('Fetching %d milestones for vault %s', milestones.length, id);

    const publicMilestones = milestones.map(toPublicMilestone);
    return res.json(publicMilestones);
  } catch (error) {
    debug('Error fetching milestones for vault %s: %O', id, error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;