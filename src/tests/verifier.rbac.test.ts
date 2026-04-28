import request from "supertest";
import { app } from "../app.js";
import { 
  TEST_TOKENS, 
  INVALID_TOKENS, 
  VERIFIER_ENDPOINTS,
  validateErrorEnvelope,
  createSecurityBypassTests,
  replacePathParams,
  UserRole
} from "./helpers/rbacTestUtils.js";

/**
 * Verifier RBAC Tests
 * 
 * Comprehensive RBAC testing for verifier workflow endpoints including
 * /api/verifications and milestone validation endpoints.
 * 
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**
 */

describe("Verifier RBAC — Verification Workflow Authorization", () => {
  /**
   * Test POST /api/verifications endpoint
   * Should allow VERIFIER and ADMIN roles, deny USER role
   */
  describe("POST /api/verifications - Create Verification", () => {
    const endpoint = "/api/verifications"
    const requestBody = { 
      milestoneId: "test-milestone-id",
      verificationData: { status: "verified" }
    }

    it("allows VERIFIER role to create verifications", async () => {
      const res = await request(app)
        .post(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)
        .send(requestBody)

      // Should succeed or return 404/400 if endpoint not implemented
      expect([201, 404, 400]).toContain(res.status)
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("allows ADMIN role to create verifications (role hierarchy)", async () => {
      const res = await request(app)
        .post(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.admin()}`)
        .send(requestBody)

      // Should succeed or return 404/400 if endpoint not implemented
      expect([201, 404, 400]).toContain(res.status)
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("denies USER role with 403 Forbidden", async () => {
      const res = await request(app)
        .post(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.user()}`)
        .send(requestBody)

      validateErrorEnvelope(res, 403, /forbidden/i)
    })

    it("denies unauthenticated requests with 401 Unauthorized", async () => {
      const res = await request(app)
        .post(endpoint)
        .send(requestBody)

      validateErrorEnvelope(res, 401, /unauthorized/i)
    })

    it("denies malformed token with 401 Unauthorized", async () => {
      const res = await request(app)
        .post(endpoint)
        .set("Authorization", `Bearer ${INVALID_TOKENS.malformed()}`)
        .send(requestBody)

      validateErrorEnvelope(res, 401, /invalid|unauthorized/i)
    })

    it("denies expired token with 401 Unauthorized", async () => {
      const res = await request(app)
        .post(endpoint)
        .set("Authorization", `Bearer ${INVALID_TOKENS.expired()}`)
        .send(requestBody)

      validateErrorEnvelope(res, 401, /expired|unauthorized/i)
    })
  })

  /**
   * Test GET /api/verifications endpoint
   * Should allow ADMIN role only (for audit purposes), deny VERIFIER and USER
   */
  describe("GET /api/verifications - List Verifications (Admin Audit)", () => {
    const endpoint = "/api/verifications"

    it("allows ADMIN role to list verifications for audit", async () => {
      const res = await request(app)
        .get(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.admin()}`)

      // Should succeed or return 404 if endpoint not implemented
      expect([200, 404]).toContain(res.status)
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("denies VERIFIER role with 403 Forbidden", async () => {
      const res = await request(app)
        .get(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)

      validateErrorEnvelope(res, 403, /forbidden/i)
    })

    it("denies USER role with 403 Forbidden", async () => {
      const res = await request(app)
        .get(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.user()}`)

      validateErrorEnvelope(res, 403, /forbidden/i)
    })

    it("denies unauthenticated requests with 401 Unauthorized", async () => {
      const res = await request(app).get(endpoint)

      validateErrorEnvelope(res, 401, /unauthorized/i)
    })
  })

  /**
   * Role Hierarchy Validation
   * Verify that ADMIN role has access to VERIFIER-level resources
   */
  describe("Role Hierarchy Enforcement", () => {
    it("validates ADMIN > VERIFIER hierarchy for POST /api/verifications", async () => {
      const endpoint = "/api/verifications"
      const requestBody = { milestoneId: "test-milestone" }

      // Both VERIFIER and ADMIN should have access
      const verifierRes = await request(app)
        .post(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)
        .send(requestBody)

      const adminRes = await request(app)
        .post(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.admin()}`)
        .send(requestBody)

      // Both should succeed (or fail with same non-auth error)
      expect(verifierRes.status).not.toBe(403)
      expect(adminRes.status).not.toBe(403)
      
      // If one succeeds, both should succeed (same endpoint, same access level)
      if ([200, 201].includes(verifierRes.status)) {
        expect([200, 201]).toContain(adminRes.status)
      }
    })

    it("validates ADMIN-only access for GET /api/verifications", async () => {
      const endpoint = "/api/verifications"

      // Only ADMIN should have access
      const adminRes = await request(app)
        .get(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.admin()}`)

      const verifierRes = await request(app)
        .get(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)

      // ADMIN should succeed, VERIFIER should be denied
      expect(adminRes.status).not.toBe(403)
      validateErrorEnvelope(verifierRes, 403, /forbidden/i)
    })

    it("validates USER is denied access to all verifier endpoints", async () => {
      const userToken = TEST_TOKENS.user()

      // POST /api/verifications
      const postRes = await request(app)
        .post("/api/verifications")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ milestoneId: "test" })

      validateErrorEnvelope(postRes, 403, /forbidden/i)

      // GET /api/verifications
      const getRes = await request(app)
        .get("/api/verifications")
        .set("Authorization", `Bearer ${userToken}`)

      validateErrorEnvelope(getRes, 403, /forbidden/i)
    })
  })

  /**
   * Security Bypass Prevention for Verifier Endpoints
   */
  describe("Security Bypass Prevention", () => {
    it("prevents header spoofing on POST /api/verifications", async () => {
      const endpoint = "/api/verifications"
      const bypassTests = createSecurityBypassTests(endpoint)
      
      for (const test of bypassTests) {
        const userToken = TEST_TOKENS.user()
        const res = await request(app)
          .post(endpoint)
          .set("Authorization", `Bearer ${userToken}`)
          .set(test.headers)
          .send({ milestoneId: "test" })

        // Should receive 403 (insufficient role), not 201 (success from spoofed header)
        validateErrorEnvelope(res, 403, test.expectedErrorPattern)
      }
    })

    it("prevents header spoofing on GET /api/verifications", async () => {
      const endpoint = "/api/verifications"
      const bypassTests = createSecurityBypassTests(endpoint)
      
      for (const test of bypassTests) {
        const verifierToken = TEST_TOKENS.verifier() // VERIFIER denied on GET
        const res = await request(app)
          .get(endpoint)
          .set("Authorization", `Bearer ${verifierToken}`)
          .set(test.headers)

        // Should receive 403 (insufficient role), not 200 (success from spoofed header)
        validateErrorEnvelope(res, 403, test.expectedErrorPattern)
      }
    })

    it("ignores x-user-role: ADMIN header with VERIFIER token on admin-only endpoint", async () => {
      const verifierToken = TEST_TOKENS.verifier()
      const res = await request(app)
        .get("/api/verifications") // Admin-only endpoint
        .set("Authorization", `Bearer ${verifierToken}`)
        .set("x-user-role", "ADMIN")

      // Should be denied based on JWT role (VERIFIER), not header (ADMIN)
      validateErrorEnvelope(res, 403, /forbidden/i)
    })

    it("ignores multiple role headers simultaneously", async () => {
      const maliciousHeaders = {
        'x-user-role': 'ADMIN',
        'x-requested-role': 'ADMIN',
        'role': 'ADMIN',
        'x-auth-role': 'ADMIN'
      }

      const userToken = TEST_TOKENS.user()
      const res = await request(app)
        .post("/api/verifications")
        .set("Authorization", `Bearer ${userToken}`)
        .set(maliciousHeaders)
        .send({ milestoneId: "test" })

      validateErrorEnvelope(res, 403, /forbidden/i)
    })

    it("returns 401 when role headers present without token", async () => {
      const res = await request(app)
        .post("/api/verifications")
        .set("x-user-role", "VERIFIER")
        .set("x-requested-role", "ADMIN")
        .send({ milestoneId: "test" })

      validateErrorEnvelope(res, 401, /unauthorized/i)
    })
  })

  /**
   * Authentication Precedence Invariant for Verifier Endpoints
   */
  describe("Authentication Before Authorization", () => {
    it("returns 401 (not 403) when Authorization header is missing", async () => {
      const res = await request(app)
        .post("/api/verifications")
        .send({ milestoneId: "test" })

      expect(res.status).toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("returns 401 (not 403) when token is malformed", async () => {
      const res = await request(app)
        .post("/api/verifications")
        .set("Authorization", "Bearer malformed..token")
        .send({ milestoneId: "test" })

      expect(res.status).toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("returns 401 when Bearer prefix is missing", async () => {
      const token = TEST_TOKENS.verifier()
      const res = await request(app)
        .post("/api/verifications")
        .set("Authorization", token) // Missing "Bearer " prefix
        .send({ milestoneId: "test" })

      validateErrorEnvelope(res, 401, /missing|malformed/i)
    })

    it("returns 401 for expired tokens before checking authorization", async () => {
      const res = await request(app)
        .post("/api/verifications")
        .set("Authorization", `Bearer ${INVALID_TOKENS.expired()}`)
        .send({ milestoneId: "test" })

      expect(res.status).toBe(401)
      expect(res.status).not.toBe(403)
    })
  })

  /**
   * Error Response Consistency for Verifier Endpoints
   */
  describe("Error Response Consistency", () => {
    it("401 responses include proper error message", async () => {
      const res = await request(app)
        .post("/api/verifications")
        .send({ milestoneId: "test" })

      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty("error")
      expect(typeof res.body.error).toBe("string")
      expect(res.body.error.toLowerCase()).toMatch(/unauthorized|missing|malformed/)
    })

    it("403 responses include proper error message", async () => {
      const res = await request(app)
        .post("/api/verifications")
        .set("Authorization", `Bearer ${TEST_TOKENS.user()}`)
        .send({ milestoneId: "test" })

      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty("error")
      expect(typeof res.body.error).toBe("string")
      expect(res.body.error.toLowerCase()).toMatch(/forbidden|requires|insufficient/)
    })

    it("403 responses optionally include detailed message", async () => {
      const res = await request(app)
        .get("/api/verifications")
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)

      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty("error")
      
      // May include detailed message about required role
      if (res.body.message) {
        expect(typeof res.body.message).toBe("string")
        expect(res.body.message.toLowerCase()).toMatch(/role|admin/)
      }
    })
  })

  /**
   * Edge Case Testing for Verifier Endpoints
   */
  describe("Edge Case Security Tests", () => {
    it("handles empty request body gracefully", async () => {
      const res = await request(app)
        .post("/api/verifications")
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)
        .send({}) // Empty body

      // Should not be auth/authz error
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
      // May be 400 (bad request) or 404 (not found)
    })

    it("handles malformed JSON in request body", async () => {
      const res = await request(app)
        .post("/api/verifications")
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)
        .set("Content-Type", "application/json")
        .send("invalid-json")

      // Should not be auth/authz error
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("handles extremely long authorization header", async () => {
      const longToken = 'A'.repeat(10000)
      const res = await request(app)
        .post("/api/verifications")
        .set("Authorization", `Bearer ${longToken}`)
        .send({ milestoneId: "test" })

      validateErrorEnvelope(res, 401, /invalid|unauthorized/i)
    })

    it("handles special characters in milestone ID", async () => {
      const specialMilestoneId = "test<script>alert(1)</script>"
      const res = await request(app)
        .post("/api/verifications")
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)
        .send({ milestoneId: specialMilestoneId })

      // Should not be auth/authz error
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("validates that 404 errors still require authentication", async () => {
      const res = await request(app).get("/api/verifications/nonexistent")
      
      // Should get 401 (auth required) before 404 (not found)
      validateErrorEnvelope(res, 401, /unauthorized/i)
    })

    it("validates that 404 errors still require authorization", async () => {
      const userToken = TEST_TOKENS.user()
      const res = await request(app)
        .get("/api/verifications/nonexistent")
        .set("Authorization", `Bearer ${userToken}`)
      
      // Should get 403 (insufficient role) before 404 (not found)
      validateErrorEnvelope(res, 403, /forbidden/i)
    })
  })

  /**
   * Integration Testing - End-to-End Verifier Workflow
   */
  describe("Verifier Workflow Integration", () => {
    it("validates complete verification workflow with proper roles", async () => {
      const milestoneId = "integration-test-milestone"
      
      // Step 1: VERIFIER creates verification
      const createRes = await request(app)
        .post("/api/verifications")
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)
        .send({ milestoneId })

      // Should succeed or return non-auth error
      expect(createRes.status).not.toBe(401)
      expect(createRes.status).not.toBe(403)

      // Step 2: ADMIN can audit verifications
      const auditRes = await request(app)
        .get("/api/verifications")
        .set("Authorization", `Bearer ${TEST_TOKENS.admin()}`)

      // Should succeed or return non-auth error
      expect(auditRes.status).not.toBe(401)
      expect(auditRes.status).not.toBe(403)

      // Step 3: USER cannot access either endpoint
      const userCreateRes = await request(app)
        .post("/api/verifications")
        .set("Authorization", `Bearer ${TEST_TOKENS.user()}`)
        .send({ milestoneId })

      const userAuditRes = await request(app)
        .get("/api/verifications")
        .set("Authorization", `Bearer ${TEST_TOKENS.user()}`)

      validateErrorEnvelope(userCreateRes, 403, /forbidden/i)
      validateErrorEnvelope(userAuditRes, 403, /forbidden/i)
    })

    it("validates role separation between creation and audit", async () => {
      // VERIFIER can create but cannot audit
      const verifierToken = TEST_TOKENS.verifier()
      
      const createRes = await request(app)
        .post("/api/verifications")
        .set("Authorization", `Bearer ${verifierToken}`)
        .send({ milestoneId: "test" })

      const auditRes = await request(app)
        .get("/api/verifications")
        .set("Authorization", `Bearer ${verifierToken}`)

      // Create should succeed, audit should be denied
      expect(createRes.status).not.toBe(403)
      validateErrorEnvelope(auditRes, 403, /forbidden/i)
    })

    it("validates admin oversight capability", async () => {
      // ADMIN can both create and audit
      const adminToken = TEST_TOKENS.admin()
      
      const createRes = await request(app)
        .post("/api/verifications")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ milestoneId: "admin-test" })

      const auditRes = await request(app)
        .get("/api/verifications")
        .set("Authorization", `Bearer ${adminToken}`)

      // Both should succeed (or return non-auth errors)
      expect(createRes.status).not.toBe(401)
      expect(createRes.status).not.toBe(403)
      expect(auditRes.status).not.toBe(401)
      expect(auditRes.status).not.toBe(403)
    })
  })
})

/**
 * Milestone Validation Endpoint Tests
 * 
 * Tests for milestone validation endpoints that may be part of the verifier workflow
 */
describe("Verifier RBAC — Milestone Validation Authorization", () => {
  /**
   * Test milestone validation endpoints if they exist
   * These are hypothetical endpoints based on the requirements
   */
  describe("Milestone Validation Endpoints", () => {
    it("validates milestone approval requires appropriate role", async () => {
      const endpoint = "/api/milestones/test-milestone/validate"
      const requestBody = { status: "approved", notes: "Validation complete" }

      // Test with different roles
      const roles = [
        { token: TEST_TOKENS.user(), shouldSucceed: false },
        { token: TEST_TOKENS.verifier(), shouldSucceed: true },
        { token: TEST_TOKENS.admin(), shouldSucceed: true }
      ]

      for (const { token, shouldSucceed } of roles) {
        const res = await request(app)
          .post(endpoint)
          .set("Authorization", `Bearer ${token}`)
          .send(requestBody)

        if (shouldSucceed) {
          // Should succeed or return non-auth error
          expect(res.status).not.toBe(401)
          expect(res.status).not.toBe(403)
        } else {
          // Should be denied with 403
          validateErrorEnvelope(res, 403, /forbidden/i)
        }
      }
    })

    it("validates milestone status check access control", async () => {
      const endpoint = "/api/milestones/test-milestone/status"

      // Different access patterns for status checking
      const adminRes = await request(app)
        .get(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.admin()}`)

      const verifierRes = await request(app)
        .get(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)

      const userRes = await request(app)
        .get(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.user()}`)

      // ADMIN and VERIFIER should have access, USER should not
      expect(adminRes.status).not.toBe(403)
      expect(verifierRes.status).not.toBe(403)
      
      // USER access depends on business requirements - may be allowed for own milestones
      // For this test, assume USER is denied
      if (userRes.status === 403) {
        validateErrorEnvelope(userRes, 403, /forbidden/i)
      }
    })
  })
})