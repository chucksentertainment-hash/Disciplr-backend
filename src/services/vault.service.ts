import { Vault, CreateVaultDTO, VaultStatus } from '../types/vault.js';
import pool from '../db/index.js';

export class VaultService {
  /**
   * Creates a new vault record in the database.
   */
  static async createVault(data: CreateVaultDTO): Promise<Vault> {
    const query = `
      INSERT INTO vaults (
        contract_id, creator_address, amount, milestone_hash,
        verifier_address, success_destination, failure_destination, deadline
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    const values = [
      data.contractId, data.creatorAddress, data.amount, data.milestoneHash,
      data.verifierAddress, data.successDestination, data.failureDestination, data.deadline
    ];

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      console.error('Error creating vault:', error);
      throw new Error('Database error during vault creation');
    }
  }

  /**
   * Get a vault by its ID
   */
  static async getVaultById(id: string): Promise<Vault | null> {
    const query = `SELECT * FROM vaults WHERE id = $1`;
    try {
      const result = await pool.query(query, [id]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error fetching vault:', error);
      return null;
    }
  }

  /**
   * Update vault status
   */
  static async updateVaultStatus(id: string, status: VaultStatus): Promise<void> {
    const query = `UPDATE vaults SET status = $1, updated_at = NOW() WHERE id = $2`;
    try {
      await pool.query(query, [status, id]);
    } catch (error) {
      console.error('Error updating vault status:', error);
      throw new Error('Database error during vault update');
    }
  }

  /**
   * Get all vaults for a specific user (by creator address)
   */
  static async getVaultsByUser(address: string): Promise<Vault[]> {
    const query = `SELECT * FROM vaults WHERE creator_address = $1 ORDER BY created_at DESC`;
    try {
      const result = await pool.query(query, [address]);
      return result.rows;
    } catch (error) {
      console.error('Error fetching user vaults:', error);
      return [];
    }
  }

  static async initializePrisma() {
    return getPrisma()
  }

  static async getVaultById(vaultId: string): Promise<Vault | null> {
    const query = 'SELECT * FROM vaults WHERE id = $1';
    try {
      const result = await pool.query(query, [vaultId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error fetching vault:', error);
      return null;
    }
  }

  static async updateVaultStatus(vaultId: string, status: string): Promise<Vault | null> {
    const query = 'UPDATE vaults SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *';
    try {
      const result = await pool.query(query, [status, vaultId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error updating vault status:', error);
      return null;
    }
  }

  static async getVaultsByUser(userId: string): Promise<Vault[]> {
    const query = 'SELECT * FROM vaults WHERE user_id = $1 ORDER BY created_at DESC';
    try {
      const result = await pool.query(query, [userId]);
      return result.rows;
    } catch (error) {
      console.error('Error fetching user vaults:', error);
      return [];
    }
  }
}

// Mock Prisma for when DATABASE_URL is not available
const mockPrisma = {
  vault: {
    findUnique: async () => null,
    findMany: async () => [],
    create: async () => ({}),
    update: async () => ({}),
  }
}

// Lazy-load Prisma to avoid top-level await issues
let prismaInstance: any = null
async function getPrisma() {
  if (prismaInstance) return prismaInstance

  try {
    if (process.env.DATABASE_URL) {
      const { prisma: realPrisma } = await import('../lib/prisma.js')
      prismaInstance = realPrisma
    } else {
      prismaInstance = mockPrisma
    }
  } catch {
    prismaInstance = mockPrisma
  }
  return prismaInstance
}

export { getPrisma }
