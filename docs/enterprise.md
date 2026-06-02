# Enterprise Features Documentation

## Overview
The Disciplr Enterprise API provides dedicated endpoints for institutional users and savings groups. It enforces strict authorization and data exposure controls to ensure multi-tenant isolation and security.

## Authorization Flow
Enterprise access is managed through the `enterpriseGuard` middleware. Eligibility is determined by the `isEnterprise` flag in the JWT auth context, which is populated during authentication.

### Eligibility Criteria
- User must be authenticated.
- User must belong to an organization marked as an enterprise.
- The `enterpriseId` must be present in the auth context.

### Guard Behavior
- **Non-Enterprise Users**: Receive a `403 Forbidden` response.
- **Unauthenticated Requests**: Receive a `401 Unauthorized` response.
- **Unauthorized Access Attempts**: Logged to the security audit trail with the `security.enterprise_denied` event.

## Exposure Controls
The Enterprise API implements strict data exposure controls to prevent leakage of internal metadata:
1. **PII Masking**: Sensitive identifiers (e.g., creator addresses) are masked using deterministic hashing for observability.
2. **Public DTOs**: Internal database models are mapped to `EnterpriseVault` and `EnterpriseMilestone` DTOs, stripping fields like `created_at`, `updated_at`, and internal notes.
3. **Identifier Validation**: Enterprise identifiers are strictly retrieved from the verified auth context, preventing ID guessing or cross-tenant leakage.

## Rollout Approach
Enterprise features are controlled via a feature flag matrix:
- **`isEnterprise`**: Global flag per user/org.
- **`enterpriseId`**: Scopes data access to a specific tenant.

### Feature Flag Matrix
| Feature | Flag Requirement | Status |
|---|---|---|
| Enterprise Routes | `isEnterprise: true` | Active |
| Custom Milestones | `enterprise_custom_milestones: true` | In Development |
| Advanced Analytics | `enterprise_analytics_tier: 'premium'` | In Development |

## Security Assumptions
- JWTs are signed and cannot be tampered with.
- The `isEnterprise` flag is accurately populated by the Identity Provider or the core auth service.
- All enterprise-specific data is tagged with an `organization_id` for isolation.
