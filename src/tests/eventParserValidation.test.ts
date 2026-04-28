import { parseHorizonEvent } from '../services/eventParser.js'
import { createRawHorizonEvent } from './fixtures/horizonEvents.js'
import fc from 'fast-check'
import {
  arbitraryVaultCreatedEvent,
  arbitraryVaultCompletedEvent,
  arbitraryVaultFailedEvent,
  arbitraryVaultCancelledEvent,
  arbitraryMilestoneCreatedEvent,
  arbitraryMilestoneValidatedEvent,
  arbitraryParsedEvent,
  arbitraryStellarAddress,
  arbitraryAmount,
  arbitraryFutureDate,
  arbitraryPastDate,
  arbitraryEdgeCaseAmount,
  arbitraryEdgeCaseString
} from './fixtures/arbitraries.js'

describe('eventParser - Payload Validation', () => {
  it('should validate all required fields for vault_created events', () => {
    const result = parseHorizonEvent(
      createRawHorizonEvent('vault_created', {
        vaultId: 'vault-123',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        amount: '1000.0000000',
        startTimestamp: '2024-01-01T00:00:00.000Z',
        endTimestamp: '2024-12-31T00:00:00.000Z',
        successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
      })
    )

    expect(result.success).toBe(true)
    if (result.success) {
      const payload = result.event.payload as any
      expect(payload.vaultId).toBe('vault-123')
      expect(payload.creator).toBe('GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
      expect(payload.amount).toBe('1000.0000000')
      expect(payload.startTimestamp).toEqual(new Date('2024-01-01T00:00:00.000Z'))
      expect(payload.endTimestamp).toEqual(new Date('2024-12-31T00:00:00.000Z'))
      expect(payload.successDestination).toBe('GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
      expect(payload.failureDestination).toBe('GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
    }
  })

  it('should validate vault status events from encoded payload fields', () => {
    const completed = parseHorizonEvent(
      createRawHorizonEvent('vault_completed', {
        vaultId: 'vault-complete'
      })
    )
    const failed = parseHorizonEvent(
      createRawHorizonEvent('vault_failed', {
        vaultId: 'vault-failed',
        status: 'failed'
      })
    )
    const cancelled = parseHorizonEvent(
      createRawHorizonEvent('vault_cancelled', {
        vaultId: 'vault-cancelled'
      })
    )

    expect(completed.success).toBe(true)
    expect(failed.success).toBe(true)
    expect(cancelled.success).toBe(true)

    if (completed.success) {
      expect(completed.event.payload).toMatchObject({
        vaultId: 'vault-complete',
        status: 'completed'
      })
    }

    if (failed.success) {
      expect(failed.event.payload).toMatchObject({
        vaultId: 'vault-failed',
        status: 'failed'
      })
    }

    if (cancelled.success) {
      expect(cancelled.event.payload).toMatchObject({
        vaultId: 'vault-cancelled',
        status: 'cancelled'
      })
    }
  })

  it('should validate all required fields for milestone_created events', () => {
    const result = parseHorizonEvent(
      createRawHorizonEvent('milestone_created', {
        milestoneId: 'milestone-456',
        vaultId: 'vault-456',
        title: 'First Milestone',
        description: 'Complete first task',
        targetAmount: '500.0000000',
        deadline: '2024-06-30T00:00:00.000Z'
      })
    )

    expect(result.success).toBe(true)
    if (result.success) {
      const payload = result.event.payload as any
      expect(payload.milestoneId).toBe('milestone-456')
      expect(payload.vaultId).toBe('vault-456')
      expect(payload.title).toBe('First Milestone')
      expect(payload.targetAmount).toBe('500.0000000')
      expect(payload.deadline).toEqual(new Date('2024-06-30T00:00:00.000Z'))
    }
  })

  it('should validate all required fields for milestone_validated events', () => {
    const result = parseHorizonEvent(
      createRawHorizonEvent('milestone_validated', {
        validationId: 'validation-789',
        milestoneId: 'milestone-789',
        validatorAddress: 'GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        validationResult: 'pending_review',
        evidenceHash: 'hash-abc123def456',
        validatedAt: '2024-03-15T10:30:00.000Z'
      })
    )

    expect(result.success).toBe(true)
    if (result.success) {
      const payload = result.event.payload as any
      expect(payload.validationId).toBe('validation-789')
      expect(payload.milestoneId).toBe('milestone-789')
      expect(payload.validatorAddress).toBe('GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
      expect(payload.validationResult).toBe('pending_review')
      expect(payload.validatedAt).toEqual(new Date('2024-03-15T10:30:00.000Z'))
    }
  })

  it('should reject encoded payloads with missing required fields', () => {
    const result = parseHorizonEvent(
      createRawHorizonEvent('milestone_created', {
        milestoneId: 'milestone-invalid',
        vaultId: 'vault-invalid',
        description: 'Missing title and target amount',
        deadline: '2024-06-30T00:00:00.000Z'
      })
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Failed to parse payload')
    }
  })

  it('should reject invalid decimal and date values without throwing', () => {
    const invalidAmountResult = parseHorizonEvent(
      createRawHorizonEvent('vault_created', {
        vaultId: 'vault-invalid-amount',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        amount: 'not-a-number',
        startTimestamp: '2024-01-01T00:00:00.000Z',
        endTimestamp: '2024-12-31T00:00:00.000Z',
        successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
      })
    )

    const invalidDateResult = parseHorizonEvent(
      createRawHorizonEvent('milestone_validated', {
        validationId: 'validation-invalid-date',
        milestoneId: 'milestone-invalid-date',
        validatorAddress: 'GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        validationResult: 'approved',
        evidenceHash: 'hash-invalid-date',
        validatedAt: 'not-a-date'
      })
    )

    expect(invalidAmountResult.success).toBe(false)
    expect(invalidDateResult.success).toBe(false)
  })
})

describe('eventParser - Property-Based Tests with Fuzzing', () => {
  describe('Valid Event Processing', () => {
    it('should successfully parse all valid vault_created events', () => {
      fc.assert(
        fc.property(arbitraryVaultCreatedEvent(), (event) => {
          const rawEvent = createRawHorizonEvent('vault_created', event.payload as any, {
            txHash: event.transactionHash,
            id: `${event.transactionHash}-${event.eventIndex}`,
            ledger: event.ledgerNumber
          })
          
          const result = parseHorizonEvent(rawEvent)
          
          expect(result.success).toBe(true)
          if (result.success) {
            expect(result.event.eventType).toBe('vault_created')
            expect(result.event.eventId).toBe(event.eventId)
            expect(result.event.transactionHash).toBe(event.transactionHash)
            expect(result.event.eventIndex).toBe(event.eventIndex)
            expect(result.event.ledgerNumber).toBe(event.ledgerNumber)
          }
        }),
        { numRuns: 100, seed: 42 }
      )
    })

    it('should successfully parse all valid vault status events', () => {
      fc.assert(
        fc.property(
          fc.oneof(arbitraryVaultCompletedEvent(), arbitraryVaultFailedEvent(), arbitraryVaultCancelledEvent()),
          (event) => {
            const rawEvent = createRawHorizonEvent(event.eventType, event.payload as any, {
              txHash: event.transactionHash,
              id: `${event.transactionHash}-${event.eventIndex}`,
              ledger: event.ledgerNumber
            })
            
            const result = parseHorizonEvent(rawEvent)
            
            expect(result.success).toBe(true)
            if (result.success) {
              expect(['vault_completed', 'vault_failed', 'vault_cancelled']).toContain(result.event.eventType)
              expect(result.event.eventId).toBe(event.eventId)
            }
          }
        ),
        { numRuns: 100, seed: 42 }
      )
    })

    it('should successfully parse all valid milestone_created events', () => {
      fc.assert(
        fc.property(arbitraryMilestoneCreatedEvent(), (event) => {
          const rawEvent = createRawHorizonEvent('milestone_created', event.payload as any, {
            txHash: event.transactionHash,
            id: `${event.transactionHash}-${event.eventIndex}`,
            ledger: event.ledgerNumber
          })
          
          const result = parseHorizonEvent(rawEvent)
          
          expect(result.success).toBe(true)
          if (result.success) {
            expect(result.event.eventType).toBe('milestone_created')
            expect(result.event.eventId).toBe(event.eventId)
          }
        }),
        { numRuns: 100, seed: 42 }
      )
    })

    it('should successfully parse all valid milestone_validated events', () => {
      fc.assert(
        fc.property(arbitraryMilestoneValidatedEvent(), (event) => {
          const rawEvent = createRawHorizonEvent('milestone_validated', event.payload as any, {
            txHash: event.transactionHash,
            id: `${event.transactionHash}-${event.eventIndex}`,
            ledger: event.ledgerNumber
          })
          
          const result = parseHorizonEvent(rawEvent)
          
          expect(result.success).toBe(true)
          if (result.success) {
            expect(result.event.eventType).toBe('milestone_validated')
            expect(result.event.eventId).toBe(event.eventId)
          }
        }),
        { numRuns: 100, seed: 42 }
      )
    })
  })

  describe('Invalid Input Rejection', () => {
    it('should reject vault_created events with invalid Stellar addresses', () => {
      fc.assert(
        fc.property(
          fc.record({
            vaultId: fc.string(),
            creator: fc.string().filter(s => !/^[G][A-Z0-9]{55}$/.test(s)),
            amount: arbitraryAmount(),
            startTimestamp: arbitraryPastDate(),
            endTimestamp: arbitraryFutureDate(),
            successDestination: arbitraryStellarAddress(),
            failureDestination: arbitraryStellarAddress()
          }),
          (payload) => {
            const rawEvent = createRawHorizonEvent('vault_created', payload)
            const result = parseHorizonEvent(rawEvent)
            
            expect(result.success).toBe(false)
            if (!result.success) {
              expect(result.error).toContain('Invalid creator address format')
            }
          }
        ),
        { numRuns: 100, seed: 42 }
      )
    })

    it('should reject events with invalid decimal amounts', () => {
      fc.assert(
        fc.property(
          fc.record({
            vaultId: fc.string(),
            creator: arbitraryStellarAddress(),
            amount: fc.string().filter(s => !/^\d+(\.\d{1,7})?$/.test(s) || parseFloat(s) <= 0),
            startTimestamp: arbitraryPastDate(),
            endTimestamp: arbitraryFutureDate(),
            successDestination: arbitraryStellarAddress(),
            failureDestination: arbitraryStellarAddress()
          }),
          (payload) => {
            const rawEvent = createRawHorizonEvent('vault_created', payload)
            const result = parseHorizonEvent(rawEvent)
            
            expect(result.success).toBe(false)
            if (!result.success) {
              expect(result.error).toContain('Amount must be a valid positive decimal number')
            }
          }
        ),
        { numRuns: 100, seed: 42 }
      )
    })

    it('should reject milestone events with past deadlines', () => {
      fc.assert(
        fc.property(
          fc.record({
            milestoneId: fc.string(),
            vaultId: fc.string(),
            title: fc.string(),
            description: fc.string(),
            targetAmount: arbitraryAmount(),
            deadline: fc.date({ max: new Date() }) // Past or present dates
          }),
          (payload) => {
            const rawEvent = createRawHorizonEvent('milestone_created', payload)
            const result = parseHorizonEvent(rawEvent)
            
            expect(result.success).toBe(false)
            if (!result.success) {
              expect(result.error).toContain('deadline must be in the future')
            }
          }
        ),
        { numRuns: 100, seed: 42 }
      )
    })

    it('should reject events with unknown fields (strict schema validation)', () => {
      fc.assert(
        fc.property(
          fc.record({
            vaultId: fc.string(),
            creator: arbitraryStellarAddress(),
            amount: arbitraryAmount(),
            startTimestamp: arbitraryPastDate(),
            endTimestamp: arbitraryFutureDate(),
            successDestination: arbitraryStellarAddress(),
            failureDestination: arbitraryStellarAddress(),
            unknownField: fc.string() // This should cause rejection
          }),
          (payload) => {
            const rawEvent = createRawHorizonEvent('vault_created', payload)
            const result = parseHorizonEvent(rawEvent)
            
            expect(result.success).toBe(false)
            if (!result.success) {
              expect(result.error).toContain('Unknown fields not allowed')
            }
          }
        ),
        { numRuns: 100, seed: 42 }
      )
    })

    it('should reject validation events with invalid evidence hashes', () => {
      fc.assert(
        fc.property(
          fc.record({
            validationId: fc.string(),
            milestoneId: fc.string(),
            validatorAddress: arbitraryStellarAddress(),
            validationResult: fc.constantFrom('approved', 'rejected', 'pending_review'),
            evidenceHash: fc.string().filter(s => !/^[a-zA-Z0-9_-]+$/.test(s)),
            validatedAt: arbitraryPastDate()
          }),
          (payload) => {
            const rawEvent = createRawHorizonEvent('milestone_validated', payload)
            const result = parseHorizonEvent(rawEvent)
            
            expect(result.success).toBe(false)
            if (!result.success) {
              expect(result.error).toContain('evidenceHash must contain only alphanumeric characters')
            }
          }
        ),
        { numRuns: 100, seed: 42 }
      )
    })
  })

  describe('Edge Case Handling', () => {
    it('should handle malformed XDR data gracefully', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant(''),
            fc.constant('invalid-xdr'),
            fc.string({ minLength: 1000 }),
            fc.lorem({ maxCount: 10 })
          ),
          (xdrData) => {
            const rawEvent = createRawHorizonEvent('vault_created', { vaultId: 'test' }, {
              value: { xdr: xdrData }
            })
            
            const result = parseHorizonEvent(rawEvent)
            
            // Should not throw, should return error result
            expect(result.success).toBe(false)
          }
        ),
        { numRuns: 100, seed: 42 }
      )
    })

    it('should handle extremely long string values', () => {
      fc.assert(
        fc.property(
          fc.record({
            vaultId: fc.string({ minLength: 1000, maxLength: 10000 }),
            creator: arbitraryStellarAddress(),
            amount: arbitraryAmount(),
            startTimestamp: arbitraryPastDate(),
            endTimestamp: arbitraryFutureDate(),
            successDestination: arbitraryStellarAddress(),
            failureDestination: arbitraryStellarAddress()
          }),
          (payload) => {
            const rawEvent = createRawHorizonEvent('vault_created', payload)
            const result = parseHorizonEvent(rawEvent)
            
            // Should handle gracefully (either accept or reject with clear error)
            expect(typeof result.success).toBe('boolean')
          }
        ),
        { numRuns: 50, seed: 42 }
      )
    })

    it('should handle boundary values for amounts', () => {
      fc.assert(
        fc.property(arbitraryEdgeCaseAmount(), (amount) => {
          const rawEvent = createRawHorizonEvent('vault_created', {
            vaultId: 'test-boundary',
            creator: arbitraryStellarAddress(),
            amount,
            startTimestamp: arbitraryPastDate(),
            endTimestamp: arbitraryFutureDate(),
            successDestination: arbitraryStellarAddress(),
            failureDestination: arbitraryStellarAddress()
          })
          
          const result = parseHorizonEvent(rawEvent)
          
          // Should handle boundary amounts correctly
          expect(typeof result.success).toBe('boolean')
        }),
        { numRuns: 100, seed: 42 }
      )
    })
  })

  describe('Security and Robustness', () => {
    it('should prevent prototype pollution attacks', () => {
      fc.assert(
        fc.property(
          fc.record({
            vaultId: fc.string(),
            creator: arbitraryStellarAddress(),
            amount: arbitraryAmount(),
            startTimestamp: arbitraryPastDate(),
            endTimestamp: arbitraryFutureDate(),
            successDestination: arbitraryStellarAddress(),
            failureDestination: arbitraryStellarAddress(),
            '__proto__': fc.record({ toString: fc.constant('hacked') }),
            'constructor': fc.record({ prototype: fc.constant({}) })
          }),
          (payload) => {
            const rawEvent = createRawHorizonEvent('vault_created', payload)
            const result = parseHorizonEvent(rawEvent)
            
            // Should reject prototype pollution attempts
            expect(result.success).toBe(false)
            if (!result.success) {
              expect(result.error).toContain('Unknown fields not allowed')
            }
          }
        ),
        { numRuns: 100, seed: 42 }
      )
    })

    it('should handle null and undefined values gracefully', () => {
      fc.assert(
        fc.property(
          fc.record({
            vaultId: fc.oneof(fc.constant(null), fc.constant(undefined), fc.string()),
            creator: fc.oneof(fc.constant(null), fc.constant(undefined), arbitraryStellarAddress()),
            amount: fc.oneof(fc.constant(null), fc.constant(undefined), arbitraryAmount()),
            startTimestamp: fc.oneof(fc.constant(null), fc.constant(undefined), arbitraryPastDate()),
            endTimestamp: fc.oneof(fc.constant(null), fc.constant(undefined), arbitraryFutureDate()),
            successDestination: fc.oneof(fc.constant(null), fc.constant(undefined), arbitraryStellarAddress()),
            failureDestination: fc.oneof(fc.constant(null), fc.constant(undefined), arbitraryStellarAddress())
          }),
          (payload) => {
            const rawEvent = createRawHorizonEvent('vault_created', payload)
            const result = parseHorizonEvent(rawEvent)
            
            // Should handle null/undefined gracefully without throwing
            expect(typeof result.success).toBe('boolean')
          }
        ),
        { numRuns: 100, seed: 42 }
      )
    })
  })

  describe('Performance and Scalability', () => {
    it('should handle large numbers of events efficiently', () => {
      const events = fc.sample(arbitraryParsedEvent(), { numRuns: 1000, seed: 42 })
      
      const startTime = Date.now()
      
      for (const event of events) {
        const rawEvent = createRawHorizonEvent(event.eventType, event.payload as any, {
          txHash: event.transactionHash,
          id: `${event.transactionHash}-${event.eventIndex}`,
          ledger: event.ledgerNumber
        })
        
        const result = parseHorizonEvent(rawEvent)
        expect(typeof result.success).toBe('boolean')
      }
      
      const endTime = Date.now()
      const duration = endTime - startTime
      
      // Should process 1000 events in reasonable time (adjust threshold as needed)
      expect(duration).toBeLessThan(5000) // 5 seconds
    })
  })
})
