# RBAC Codebase Reconnaissance Analysis

## Executive Summary

This analysis documents the existing RBAC middleware implementation, authentication flow, admin endpoints, verifier endpoints, and test infrastructure in the Disciplr backend. The findings will inform the implementation of comprehensive RBAC policy tests as specified in Issue #223.

## Current RBAC Implementation

### Middleware Architecture

**Authentication Flow:**
1. `authenticate` middleware (from `src/middleware/auth.ts` or `src/middleware/auth.middleware.ts`)
2. RBAC enforcement middleware (`enforceRBAC`, `requireAdmin`, `requireVerifier` from `src/middleware/rbac.ts`)

**Key Security Properties:**
- Role information is read exclusively from `req.user.role` after JWT verification
- JWT tokens contain `userId`, `role`, and optional `jti` (session ID)
- Role hierarchy: USER < VERIFIER < ADMIN (hierarchical access model)
- Session validation occurs for tokens with `jti` field

### RBAC Middleware Implementation (`src/middleware/rbac.ts`)

**Core Functions:**
- `enforceRBAC(options: RBACOptions)` - Generic role enforcement
- `requireUser` - Allows USER, VERIFIER, ADMIN
- `requireVerifier` - Allows VERIFIER, ADMIN  
- `requireAdmin` - Allows ADMIN only

**Security Features:**
- Deny-by-default approach
- Comprehensive logging of RBAC denials
- Consistent error response format
- Authentication-before-authorization invariant

**Error Response Format:**
```typescript
// 401 Unauthorized
{ error: "Unauthorized" }

// 403 Forbidden  
{ 
  error: "Forbidden", 
  message: "Requires role: ${allowedRoles.join(', ')}" 
}
```

### Authentication Implementation

**Two Authentication Middleware Files:**

1. **`src/middleware/auth.ts`** (Primary)
   - Uses `JWT_SECRET` environment variable
   - Supports session validation via `jti` field
   - Includes session recording and revocation
   - Provides `signToken()` and `authenticate()` functions

2. **`src/middleware/auth.middleware.ts`** (Alternative)
   - Uses `verifyAccessToken()` from `src/lib/auth-utils.ts`
   - Simpler implementation without session support
   - Uses `JWT_ACCESS_SECRET` environment variable

**JWT Token Structure:**
```typescript
interface JWTPayload {
  userId: string
  role: UserRole  // 'USER' | 'VERIFIER' | 'ADMIN'
  email?: string
  jti?: string    // Session ID for revocation support
}
```

## Admin Endpoints Analysis

### Admin Routes (`src/routes/admin.ts`)

**Authentication Pattern:**
```typescript
adminRouter.use(authenticate)
adminRouter.use(requireAdmin)
```

**Discovered Endpoints:**

1. **User Management:**
   - `GET /api/admin/users` - List users with filtering
   - `PATCH /api/admin/users/:id/role` - Update user role
   - `PATCH /api/admin/users/:id/status` - Update user status
   - `DELETE /api/admin/users/:id` - Soft/hard delete user
   - `POST /api/admin/users/:id/restore` - Restore deleted user

2. **Session Management:**
   - `POST /api/admin/users/:userId/revoke-sessions` - Force logout user

3. **Audit Logs:**
   - `GET /api/admin/audit-logs` - List audit logs with filtering
   - `GET /api/admin/audit-logs/:id` - Get specific audit log

4. **System Overrides:**
   - `POST /api/admin/overrides/vaults/:id/cancel` - Cancel vault

### Admin Verifier Management (`src/routes/adminVerifiers.ts`)

**Authentication Pattern:**
```typescript
adminVerifiersRouter.use(authenticate, requireAdmin)
```

**Discovered Endpoints:**
- `GET /api/admin/verifiers` - List all verifier profiles
- `GET /api/admin/verifiers/:userId` - Get specific verifier profile
- `POST /api/admin/verifiers` - Create verifier profile
- `PATCH /api/admin/verifiers/:userId` - Update verifier profile
- `DELETE /api/admin/verifiers/:userId` - Delete verifier profile
- `POST /api/admin/verifiers/:userId/approve` - Approve verifier
- `POST /api/admin/verifiers/:userId/suspend` - Suspend verifier

## Verifier Endpoints Analysis

### Verification Routes (`src/routes/verifications.ts`)

**Endpoints:**
1. `POST /api/verifications` - Create verification (VERIFIER + ADMIN access)
2. `GET /api/verifications` - List verifications (ADMIN only)

**Authentication Patterns:**
```typescript
// POST endpoint
verificationsRouter.post('/', authenticate, requireVerifier, ...)

// GET endpoint  
verificationsRouter.get('/', authenticate, requireAdmin, ...)
```

## Existing Test Infrastructure

### Test Framework Configuration
- **Framework:** Jest with TypeScript support
- **Property-Based Testing:** Fast-check library available
- **Test Database:** PostgreSQL with Knex migrations
- **Coverage:** Global Jest configuration with coverage thresholds

### Current Test Files

1. **`src/tests/rbac.test.ts`**
   - Unit tests for role definitions and hierarchy
   - Authorization logic testing
   - Security invariant validation
   - No integration testing with actual middleware

2. **`src/tests/admin.rbac.test.ts`**
   - Integration tests with supertest
   - Tests authentication-before-authorization invariant
   - Header spoofing prevention tests
   - Error envelope consistency validation
   - Limited endpoint coverage (only audit-logs)

### Test Utilities Available

1. **`src/tests/helpers/testDatabase.ts`**
   - Database setup/teardown functions
   - State capture and comparison utilities
   - Test data insertion helpers

2. **`src/tests/fixtures/arbitraries.ts`**
   - Extensive property-based test generators
   - Stellar-specific data generators
   - Event and entity generators

3. **`src/lib/auth-utils.ts`**
   - JWT token generation and verification
   - Password hashing utilities
   - Access and refresh token support

### Token Generation Pattern (Current)
```typescript
const SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || "change-me-in-production"

const makeToken = (role: string, userId: string = "test-user") =>
  jwt.sign({ userId, role }, SECRET)
```

## Security Assumptions and Potential Bypass Vectors

### Current Security Model

**Strengths:**
1. **Token-Based Identity:** Role information comes exclusively from JWT verification
2. **Deny-by-Default:** RBAC middleware denies access unless explicitly allowed
3. **Authentication Precedence:** Authentication always checked before authorization
4. **Session Support:** Optional session revocation via `jti` field
5. **Comprehensive Logging:** Security events are logged for audit

**Identified Security Assumptions:**
1. JWT secret is secure and not compromised
2. Request headers are untrusted and ignored for role determination
3. Role hierarchy is enforced consistently across all endpoints
4. Session validation (when present) is reliable

### Potential Bypass Vectors to Test

1. **Header Spoofing:**
   - `x-user-role`, `x-requested-role` headers
   - Custom role headers
   - Authorization header manipulation

2. **Token Manipulation:**
   - Malformed JWT tokens
   - Expired tokens
   - Wrong signature/secret
   - Missing required fields

3. **Session Bypass:**
   - Revoked session tokens
   - Invalid `jti` values
   - Session timing attacks

4. **Role Escalation:**
   - Accessing higher-privilege endpoints
   - Cross-role endpoint access
   - Privilege boundary testing

5. **Authentication Bypass:**
   - Missing Authorization header
   - Malformed Bearer token format
   - Empty or null tokens

## Test Coverage Gaps Identified

### Missing Test Coverage

1. **Comprehensive Endpoint Coverage:**
   - Only audit-logs endpoint tested in admin.rbac.test.ts
   - No testing of user management endpoints
   - No testing of verifier management endpoints
   - No testing of system override endpoints

2. **Verifier Workflow Testing:**
   - No RBAC tests for verification endpoints
   - No role hierarchy validation for verifier access
   - No cross-role access testing

3. **Security Bypass Testing:**
   - Limited header spoofing tests
   - No comprehensive token manipulation tests
   - No session revocation testing
   - No edge case authentication testing

4. **Property-Based Testing:**
   - No property-based RBAC tests
   - No randomized security bypass attempts
   - No comprehensive input validation testing

### Test Utility Gaps

1. **RBAC-Specific Utilities:**
   - No dedicated RBAC test utility module
   - No standardized token generation for all roles
   - No security bypass test case generators
   - No endpoint test matrix generators

2. **Property-Based Generators:**
   - No RBAC-specific arbitraries
   - No malicious header generators
   - No invalid token generators

## Recommendations for Implementation

### Phase 1: Test Infrastructure Enhancement
1. Create `src/tests/helpers/rbacTestUtils.ts` with standardized token generation
2. Create `src/tests/fixtures/rbacArbitraries.ts` for property-based testing
3. Enhance test database setup for RBAC-specific scenarios

### Phase 2: Core Security Testing
1. Extend `src/tests/rbac.test.ts` with property-based security invariants
2. Implement comprehensive header spoofing prevention tests
3. Add authentication-before-authorization invariant validation

### Phase 3: Endpoint Coverage
1. Extend `src/tests/admin.rbac.test.ts` with all admin endpoints
2. Create `src/tests/verifier.rbac.test.ts` for verifier workflow testing
3. Create `src/tests/adminVerifiers.rbac.test.ts` for verifier management

### Phase 4: Integration and Validation
1. Implement end-to-end RBAC validation tests
2. Add performance testing for property-based tests
3. Validate coverage thresholds and CI integration

## Key Implementation Notes

1. **Dual Authentication Middleware:** The codebase has two authentication implementations - tests should use the primary one (`src/middleware/auth.ts`)

2. **Environment Variables:** JWT secrets vary between `JWT_SECRET` and `JWT_ACCESS_SECRET` - test utilities must handle both

3. **Session Support:** Optional session validation adds complexity - tests must cover both session and non-session scenarios

4. **Error Response Consistency:** Existing tests validate error envelope format - new tests must maintain consistency

5. **Coverage Requirements:** Global Jest configuration enforces coverage thresholds - new tests must meet these requirements

This reconnaissance provides the foundation for implementing comprehensive RBAC policy tests that will strengthen the security posture of the Disciplr backend and prevent privilege escalation vulnerabilities.