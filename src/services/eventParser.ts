import { xdr, scValToNative } from '@stellar/stellar-sdk'
import { 
  ParsedEvent, 
  EventType, 
  VaultEventPayload, 
  MilestoneEventPayload, 
  ValidationEventPayload 
} from '../types/horizonSync.js'

/**
 * Schema validation result
 */
interface ValidationResult {
  isValid: boolean
  error?: string
  sanitizedPayload?: Record<string, unknown>
}

/**
 * Safe object creation that prevents prototype pollution
 */
function createSafeObject<T extends Record<string, unknown>>(payload: T): T {
  const obj = Object.create(null) as T
  for (const key in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      obj[key] = payload[key]
    }
  }
  return obj
}

/**
 * Validates object against allowed field names (strict schema validation)
 */
function validateAllowedFields(
  payload: Record<string, unknown>,
  allowedFields: string[]
): ValidationResult {
  const payloadKeys = Object.keys(payload)
  const unknownFields = payloadKeys.filter(key => !allowedFields.includes(key))
  
  if (unknownFields.length > 0) {
    return {
      isValid: false,
      error: `Unknown fields not allowed: ${unknownFields.join(', ')}`
    }
  }
  
  return { isValid: true }
}

/**
 * Redacts sensitive information from error logs
 */
function redactSensitiveInfo(data: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...data }
  const sensitiveFields = ['privateKey', 'secret', 'password', 'token', 'key']
  
  for (const key in redacted) {
    if (sensitiveFields.some(sensitive => key.toLowerCase().includes(sensitive))) {
      redacted[key] = '[REDACTED]'
    }
  }
  
  return redacted
}

/**
 * Validates Stellar address format
 */
function validateStellarAddress(address: string): boolean {
  return /^[G][A-Z0-9]{55}$/.test(address)
}

/**
 * Validates decimal amount format
 */
function validateDecimalAmount(amount: string): boolean {
  return /^\d+(\.\d{1,7})?$/.test(amount) && parseFloat(amount) > 0
}

/**
 * Result of parsing a Horizon event
 */
export type ParseResult =
  | {
      success: true
      event: ParsedEvent
    }
  | {
      success: false
      error: string
      details?: Record<string, unknown>
    }

/**
 * Raw Horizon event structure from Stellar SDK
 */
export interface HorizonEvent {
  type: string
  ledger: number
  ledgerClosedAt: string
  contractId: string
  id: string
  pagingToken: string
  topic: string[]
  value: {
    xdr: string
  }
  inSuccessfulContractCall: boolean
  txHash: string
}

/**
 * Validates vault_created event payload
 */
function validateVaultCreatedPayload(payload: VaultEventPayload): ValidationResult {
  const allowedFields = [
    'vaultId', 'creator', 'amount', 'startTimestamp', 'endTimestamp', 
    'successDestination', 'failureDestination', 'status'
  ]
  
  // Check for unknown fields
  const fieldValidation = validateAllowedFields(payload as unknown as Record<string, unknown>, allowedFields)
  if (!fieldValidation.isValid) {
    return fieldValidation
  }
  
  // Validate required fields
  if (!payload.vaultId || typeof payload.vaultId !== 'string') {
    return { isValid: false, error: 'Missing or invalid vaultId field' }
  }
  if (!payload.creator || typeof payload.creator !== 'string') {
    return { isValid: false, error: 'Missing or invalid creator field' }
  }
  
  if (!validateStellarAddress(payload.creator)) {
    return { isValid: false, error: 'Invalid creator address format' }
  }
  if (!payload.amount || typeof payload.amount !== 'string') {
    return { isValid: false, error: 'Missing or invalid amount field' }
  }
  if (isNaN(parseFloat(payload.amount))) {
    return 'Amount must be a valid decimal number'
  }
  if (!payload.startTimestamp || !(payload.startTimestamp instanceof Date) || isNaN(payload.startTimestamp.getTime())) {
    return 'Missing or invalid startTimestamp field'
  }
  if (!payload.endTimestamp || !(payload.endTimestamp instanceof Date) || isNaN(payload.endTimestamp.getTime())) {
    return 'Missing or invalid endTimestamp field'
  }
  if (!payload.successDestination || typeof payload.successDestination !== 'string') {
    return { isValid: false, error: 'Missing or invalid successDestination field' }
  }
  
  if (!validateStellarAddress(payload.successDestination)) {
    return { isValid: false, error: 'Invalid successDestination address format' }
  }
  if (!payload.failureDestination || typeof payload.failureDestination !== 'string') {
    return { isValid: false, error: 'Missing or invalid failureDestination field' }
  }
  return null
}

/**
 * Validates vault status event payload
 */
function validateVaultStatusPayload(payload: VaultEventPayload): ValidationResult {
  const allowedFields = ['vaultId', 'status']
  
  // Check for unknown fields
  const fieldValidation = validateAllowedFields(payload as unknown as Record<string, unknown>, allowedFields)
  if (!fieldValidation.isValid) {
    return fieldValidation
  }
  
  if (!payload.vaultId || typeof payload.vaultId !== 'string') {
    return { isValid: false, error: 'Missing or invalid vaultId field' }
  }
  const validStatuses = ['active', 'completed', 'failed', 'cancelled']
  if (!payload.status || !validStatuses.includes(payload.status)) {
    return `Invalid status value: ${payload.status}. Must be one of: ${validStatuses.join(', ')}`
  }
  return null
}

/**
 * Parses vault event payload from XDR data
 */
function parseVaultPayload(
  eventType: EventType,
  xdrData: string
): VaultEventPayload | null {
  try {
    const scVal = xdr.ScVal.fromXDR(xdrData, 'base64')
    const nativeVal = scValToNative(scVal)
    
    // For vault events, we expect either an object or a direct vault ID
    const vaultId = typeof nativeVal === 'string' ? nativeVal : (nativeVal.vault_id || nativeVal.id || `vault_${Date.now()}`)
    
    if (eventType === 'vault_created') {
      const payload: VaultEventPayload = {
        vaultId,
        creator: nativeVal.creator || 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        amount: nativeVal.amount?.toString() || '0',
        startTimestamp: nativeVal.start_date ? new Date(nativeVal.start_date * 1000) : new Date(),
        endTimestamp: nativeVal.end_date ? new Date(nativeVal.end_date * 1000) : new Date(),
        successDestination: nativeVal.success_destination || 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        failureDestination: nativeVal.failure_destination || 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        status: 'active'
      }
      const error = validateVaultCreatedPayload(payload)
      if (error) {
        console.error(`Vault created validation error: ${error}`)
        return null
      }

      return payload;

    case 'vault_completed':
    case 'vault_failed':
    case 'vault_cancelled':
      const decoded = decodePayloadRecord(xdrData);
      payload = {
        vaultId: readStringField(decoded, 'vaultId') ?? '',
        status: ((readStringField(decoded, 'status')) ?
          eventType.replace('vault_', '') : undefined) as VaultEventPayload['status']
      };

      {
        const statusError = validateVaultStatusPayload(payload)
        if (statusError) {
          console.error(`Vault status validation error: ${statusError}`)
          return null
        }
        return payload
      
      default:
      return payload
    } else {
      const payload: VaultEventPayload = {
        vaultId,
        status: (nativeVal.status || eventType.replace('vault_', '')) as VaultEventPayload['status']
      }
      const error = validateVaultStatusPayload(payload)
      if (error) {
        console.error(`Vault status validation error: ${error}`)
        return null
      }
      return payload
    }
  } catch (error) {
    console.error('Error parsing vault payload XDR:', error)
    return null
  }
}

/**
 * Validates milestone_created event payload
 */
function validateMilestonePayload(payload: MilestoneEventPayload): ValidationResult {
  const allowedFields = ['milestoneId', 'vaultId', 'title', 'description', 'targetAmount', 'deadline']
  
  // Check for unknown fields
  const fieldValidation = validateAllowedFields(payload as unknown as Record<string, unknown>, allowedFields)
  if (!fieldValidation.isValid) {
    return fieldValidation
  }
  
  if (!payload.milestoneId || typeof payload.milestoneId !== 'string') {
    return { isValid: false, error: 'Missing or invalid milestoneId field' }
  }
  if (!payload.vaultId || typeof payload.vaultId !== 'string') {
    return { isValid: false, error: 'Missing or invalid vaultId field' }
  }
  if (!payload.title || typeof payload.title !== 'string') {
    return { isValid: false, error: 'Missing or invalid title field' }
  }
  
  if (payload.title.length > 255) {
    return { isValid: false, error: 'Title must be 255 characters or less' }
  }
  
  if (payload.description !== undefined && typeof payload.description !== 'string') {
    return { isValid: false, error: 'Description must be a string' }
  }
  
  if (payload.description && payload.description.length > 1000) {
    return { isValid: false, error: 'Description must be 1000 characters or less' }
  }
  if (!payload.targetAmount || typeof payload.targetAmount !== 'string') {
    return { isValid: false, error: 'Missing or invalid targetAmount field' }
  }
  if (isNaN(parseFloat(payload.targetAmount))) {
    return 'targetAmount must be a valid decimal number'
  }
  if (!payload.deadline || !(payload.deadline instanceof Date) || isNaN(payload.deadline.getTime())) {
    return 'Missing or invalid deadline field'
  }
  return null
}

/**
 * Parses milestone event payload from XDR data
 */
function parseMilestonePayload(xdrData: string): MilestoneEventPayload | null {
  try {
    const scVal = xdr.ScVal.fromXDR(xdrData, 'base64')
    const nativeVal = scValToNative(scVal)
    
    // Try to decode payload as JSON first (fallback for testing)
    const decoded = decodePayloadRecord(xdrData)
    
    const payload: MilestoneEventPayload = {
      milestoneId: nativeVal.milestone_id || nativeVal.id || `milestone_${Date.now()}`,
      vaultId: nativeVal.vault_id || `vault_${Date.now()}`,
      title: nativeVal.title || 'Untitled',
      description: nativeVal.description || '',
      targetAmount: nativeVal.amount?.toString() || nativeVal.target_amount?.toString() || '0',
      deadline: nativeVal.due_date ? new Date(nativeVal.due_date * 1000) : (nativeVal.deadline ? new Date(nativeVal.deadline) : new Date())
    }
    
    const error = validateMilestonePayload(payload)
    if (error) {
      console.error(`Milestone validation error: ${error}`)
      return null
    }
    return payload
  } catch (error) {
    console.error('Error parsing milestone payload XDR:', error)
    return null
  }
}

/**
 * Validates milestone_validated event payload
 */
function validateValidationPayload(payload: ValidationEventPayload): ValidationResult {
  const allowedFields = ['validationId', 'milestoneId', 'validatorAddress', 'validationResult', 'evidenceHash', 'validatedAt']
  
  // Check for unknown fields
  const fieldValidation = validateAllowedFields(payload as unknown as Record<string, unknown>, allowedFields)
  if (!fieldValidation.isValid) {
    return fieldValidation
  }
  
  if (!payload.validationId || typeof payload.validationId !== 'string') {
    return { isValid: false, error: 'Missing or invalid validationId field' }
  }
  if (!payload.milestoneId || typeof payload.milestoneId !== 'string') {
    return { isValid: false, error: 'Missing or invalid milestoneId field' }
  }
  if (!payload.validatorAddress || typeof payload.validatorAddress !== 'string') {
    return { isValid: false, error: 'Missing or invalid validatorAddress field' }
  }
  
  if (!validateStellarAddress(payload.validatorAddress)) {
    return { isValid: false, error: 'Invalid validatorAddress format' }
  }
  if (!payload.validationResult || typeof payload.validationResult !== 'string') {
    return { isValid: false, error: 'Missing or invalid validationResult field' }
  }
  const validResults = ['approved', 'rejected', 'pending_review']
  if (!validResults.includes(payload.validationResult)) {
    return `Invalid validationResult value: ${payload.validationResult}`
  }
  if (!payload.validatedAt || !(payload.validatedAt instanceof Date) || isNaN(payload.validatedAt.getTime())) {
    return 'Missing or invalid validatedAt field'
  }
  return null
}

/**
 * Parses validation event payload from XDR data
 */
function parseValidationPayload(xdrData: string): ValidationEventPayload | null {
  try {
    const scVal = xdr.ScVal.fromXDR(xdrData, 'base64')
    const nativeVal = scValToNative(scVal)
    
    // Try to decode payload as JSON first (fallback for testing)
    const decoded = decodePayloadRecord(xdrData)
    
    const payload: ValidationEventPayload = {
      validationId: nativeVal.validation_id || nativeVal.id || `val_${Date.now()}`,
      milestoneId: nativeVal.milestone_id || `milestone_${Date.now()}`,
      validatorAddress: nativeVal.validator || nativeVal.validator_address || 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      validationResult: nativeVal.result || nativeVal.validation_result || 'approved',
      evidenceHash: nativeVal.evidence_hash || '',
      validatedAt: nativeVal.timestamp ? new Date(nativeVal.timestamp * 1000) : (nativeVal.validated_at ? new Date(nativeVal.validated_at) : new Date())
    }
    
    const error = validateValidationPayload(payload)
    if (error) {
      console.error(`Validation event validation error: ${error}`)
      return null
    }
    return payload
  } catch (error) {
    console.error('Error parsing validation payload XDR:', error)
    return null
  }
}

/**
 * Routes event to appropriate payload parser based on event type
 */
function routeToPayloadParser(
  eventType: EventType,
  xdrData: string
): VaultEventPayload | MilestoneEventPayload | ValidationEventPayload | null {
  switch (eventType) {
    case 'vault_created':
    case 'vault_completed':
    case 'vault_failed':
    case 'vault_cancelled':
      return parseVaultPayload(eventType, xdrData)
    case 'milestone_created':
      return parseMilestonePayload(xdrData)
    case 'milestone_validated':
      return parseValidationPayload(xdrData)
    default:
      return null
  }
}

/**
 * Parses a Horizon event and extracts metadata and payload
 */
export function parseHorizonEvent(rawEvent: HorizonEvent): ParseResult {
  try {
    if (!rawEvent.txHash || !rawEvent.id || typeof rawEvent.ledger !== 'number') {
      return { success: false, error: 'Missing required Horizon event fields' }
    }

    const eventIndexMatch = rawEvent.id.match(/-(\d+)$/)
    const eventIndex = eventIndexMatch ? parseInt(eventIndexMatch[1], 10) : 0
    const eventId = `${rawEvent.txHash}:${eventIndex}`

    if (!rawEvent.topic || rawEvent.topic.length === 0) {
      return { success: false, error: 'Missing event topic' }
    }

    const eventType = rawEvent.topic[0] as EventType
    const payload = routeToPayloadParser(eventType, rawEvent.value.xdr)
    
    if (!payload) {
      return { success: false, error: `Failed to parse payload for event type: ${eventType}` }
    }

    return {
      success: true,
      event: {
        eventId,
        transactionHash: rawEvent.txHash,
        eventIndex,
        ledgerNumber: rawEvent.ledger,
        eventType,
        payload
      }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown parsing error'
    }
  }
}
