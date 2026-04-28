import { Milestone } from '../types/horizonSync.js';
import { Vault } from '../types/vault.js';
import { EnterpriseVault, EnterpriseMilestone } from '../types/enterprise.js';

/**
 * Maps an internal Vault model to a public EnterpriseVault DTO.
 * Explicitly omits internal fields like 'created_at'.
 */
export function toPublicVault(vault: Vault): EnterpriseVault {
  // Use legacy compat fields if present, otherwise fall back to the DB columns.
  // The Vault type carries startTimestamp/endTimestamp for in-memory compatibility;
  // the DB schema (post fix_vault_schema migration) uses start_date/end_date.
  const startTs: string =
    vault.startTimestamp ??
    (vault as any).start_date?.toISOString?.() ??
    vault.created_at.toISOString();

  const endTs: string =
    vault.endTimestamp ??
    (vault as any).end_date?.toISOString?.() ??
    vault.deadline.toISOString();

  return {
    id: vault.id,
    creator: vault.creator_address ?? vault.creator ?? '',
    amount: vault.amount,
    status: vault.status as any,
    startTimestamp: startTs,
    endTimestamp: endTs,
    successDestination: vault.success_destination,
    failureDestination: vault.failure_destination,
  };
}

/**
 * Maps an internal Milestone model to a public EnterpriseMilestone DTO.
 */
export function toPublicMilestone(milestone: Milestone): EnterpriseMilestone {
  return {
    id: milestone.id,
    vaultId: milestone.vaultId,
    title: milestone.title,
    description: milestone.description,
    targetAmount: milestone.targetAmount,
    currentAmount: milestone.currentAmount,
    deadline: milestone.deadline.toISOString(),
    status: milestone.status as any,
  };
}