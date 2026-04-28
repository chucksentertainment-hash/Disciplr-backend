import request from "supertest";
import { app } from "../app.js";
import { 
  TEST_TOKENS, 
  INVALID_TOKENS, 
  ADMIN_VERIFIER_ENDPOINTS,
  validateErrorEnvelope,
  createSecurityBypassTests,
  replacePathParams,
  UserRole
} from "./helpers/rbacTestUtils.js";

/**
 * Admin Verifier Management RBAC Tests
 * 
 * Comprehensive RBAC testing for admin verifier management endpoints under
 * /api/admin/verifiers/* including CRUD operations and lifecycle management.
 * 
 * **Validates: Requirements 4.1, 4.2, 4.3**
 */

describe("Admin Verifier Management RBAC — Full CRUD Authorization", () => {
  /**
   * Test GET /api/admin/verifiers - List All Verifiers
   */
  describe("GET /api/admin/verifiers - List Verifier Profiles", () => {
    const endpoint = "/api/admin/verifiers"

    it("allows ADMIN role to list verifier profiles", async () => {
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
   * Test GET /api/admin/verifiers/:userId - Get Specific Verifier Profile
   */
  describe("GET /api/admin/verifiers/:userId - Get Verifier Profile", () => {
    const endpoint = "/api/admin/verifiers/test-verifier-id"

    it("allows ADMIN role to get specific verifier profile", async () => {
      const res = await request(app)
        .get(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.admin()}`)

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
   * Test POST /api/admin/verifiers - Create Verifier Profile
   */
  describe("POST /api/admin/verifiers - Create Verifier Profile", () => {
    const endpoint = "/api/admin/verifiers"
    const requestBody = {
      userId: "new-verifier-user",
      qualifications: ["certification-1", "certification-2"],
      specializations: ["stellar-transactions", "compliance"]
    }

    it("allows ADMIN role to create verifier profiles", async () => {
      const res = await request(app)
        .post(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.admin()}`)
        .send(requestBody)

      expect([201, 404, 400, 409]).toContain(res.status)
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("denies VERIFIER role with 403 Forbidden", async () => {
      const res = await request(app)
        .post(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)
        .send(requestBody)

      validateErrorEnvelope(res, 403, /forbidden/i)
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
  })

  /**
   * Test PATCH /api/admin/verifiers/:userId - Update Verifier Profile
   */
  describe("PATCH /api/admin/verifiers/:userId - Update Verifier Profile", () => {
    const endpoint = "/api/admin/verifiers/test-verifier-id"
    const requestBody = {
      status: "ACTIVE",
      qualifications: ["updated-certification"],
      notes: "Profile updated by admin"
    }

    it("allows ADMIN role to update verifier profiles", async () => {
      const res = await request(app)
        .patch(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.admin()}`)
        .send(requestBody)

      expect([200, 404, 400]).toContain(res.status)
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("denies VERIFIER role with 403 Forbidden", async () => {
      const res = await request(app)
        .patch(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)
        .send(requestBody)

      validateErrorEnvelope(res, 403, /forbidden/i)
    })

    it("denies USER role with 403 Forbidden", async () => {
      const res = await request(app)
        .patch(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.user()}`)
        .send(requestBody)

      validateErrorEnvelope(res, 403, /forbidden/i)
    })

    it("denies unauthenticated requests with 401 Unauthorized", async () => {
      const res = await request(app)
        .patch(endpoint)
        .send(requestBody)

      validateErrorEnvelope(res, 401, /unauthorized/i)
    })
  })

  /**
   * Test DELETE /api/admin/verifiers/:userId - Delete Verifier Profile
   */
  describe("DELETE /api/admin/verifiers/:userId - Delete Verifier Profile", () => {
    const endpoint = "/api/admin/verifiers/test-verifier-id"

    it("allows ADMIN role to delete verifier profiles", async () => {
      const res = await request(app)
        .delete(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.admin()}`)

      expect([200, 404, 400]).toContain(res.status)
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("denies VERIFIER role with 403 Forbidden", async () => {
      const res = await request(app)
        .delete(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)

      validateErrorEnvelope(res, 403, /forbidden/i)
    })

    it("denies USER role with 403 Forbidden", async () => {
      const res = await request(app)
        .delete(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.user()}`)

      validateErrorEnvelope(res, 403, /forbidden/i)
    })

    it("denies unauthenticated requests with 401 Unauthorized", async () => {
      const res = await request(app).delete(endpoint)

      validateErrorEnvelope(res, 401, /unauthorized/i)
    })
  })

  /**
   * Test POST /api/admin/verifiers/:userId/approve - Approve Verifier
   */
  describe("POST /api/admin/verifiers/:userId/approve - Approve Verifier", () => {
    const endpoint = "/api/admin/verifiers/test-verifier-id/approve"
    const requestBody = {
      approvedBy: "admin-user",
      notes: "Verifier approved after review"
    }

    it("allows ADMIN role to approve verifiers", async () => {
      const res = await request(app)
        .post(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.admin()}`)
        .send(requestBody)

      expect([200, 404, 400, 409]).toContain(res.status)
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("denies VERIFIER role with 403 Forbidden", async () => {
      const res = await request(app)
        .post(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)
        .send(requestBody)

      validateErrorEnvelope(res, 403, /forbidden/i)
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
  })

  /**
   * Test POST /api/admin/verifiers/:userId/suspend - Suspend Verifier
   */
  describe("POST /api/admin/verifiers/:userId/suspend - Suspend Verifier", () => {
    const endpoint = "/api/admin/verifiers/test-verifier-id/suspend"
    const requestBody = {
      reason: "Compliance violation",
      suspendedBy: "admin-user",
      duration: "30 days"
    }

    it("allows ADMIN role to suspend verifiers", async () => {
      const res = await request(app)
        .post(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.admin()}`)
        .send(requestBody)

      expect([200, 404, 400, 409]).toContain(res.status)
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("denies VERIFIER role with 403 Forbidden", async () => {
      const res = await request(app)
        .post(endpoint)
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)
        .send(requestBody)

      validateErrorEnvelope(res, 403, /forbidden/i)
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
  })

  /**
   * Comprehensive CRUD Lifecycle Testing
   */
  describe("Complete Verifier Management Lifecycle", () => {
    it("validates complete admin verifier CRUD workflow", async () => {
      const adminToken = TEST_TOKENS.admin()
      const verifierId = "lifecycle-test-verifier"

      // Step 1: Create verifier profile
      const createRes = await request(app)
        .post("/api/admin/verifiers")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          userId: verifierId,
          qualifications: ["test-cert"],
          specializations: ["testing"]
        })

      expect(createRes.status).not.toBe(401)
      expect(createRes.status).not.toBe(403)

      // Step 2: Read verifier profile
      const readRes = await request(app)
        .get(`/api/admin/verifiers/${verifierId}`)
        .set("Authorization", `Bearer ${adminToken}`)

      expect(readRes.status).not.toBe(401)
      expect(readRes.status).not.toBe(403)

      // Step 3: Update verifier profile
      const updateRes = await request(app)
        .patch(`/api/admin/verifiers/${verifierId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "ACTIVE" })

      expect(updateRes.status).not.toBe(401)
      expect(updateRes.status).not.toBe(403)

      // Step 4: Approve verifier
      const approveRes = await request(app)
        .post(`/api/admin/verifiers/${verifierId}/approve`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ notes: "Approved for testing" })

      expect(approveRes.status).not.toBe(401)
      expect(approveRes.status).not.toBe(403)

      // Step 5: Suspend verifier
      const suspendRes = await request(app)
        .post(`/api/admin/verifiers/${verifierId}/suspend`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "Test suspension" })

      expect(suspendRes.status).not.toBe(401)
      expect(suspendRes.status).not.toBe(403)

      // Step 6: Delete verifier profile
      const deleteRes = await request(app)
        .delete(`/api/admin/verifiers/${verifierId}`)
        .set("Authorization", `Bearer ${adminToken}`)

      expect(deleteRes.status).not.toBe(401)
      expect(deleteRes.status).not.toBe(403)
    })

    it("validates non-admin roles cannot perform any CRUD operations", async () => {
      const verifierId = "access-test-verifier"
      const testBody = { userId: verifierId, qualifications: ["test"] }

      const roles = [
        { name: "VERIFIER", token: TEST_TOKENS.verifier() },
        { name: "USER", token: TEST_TOKENS.user() }
      ]

      for (const { name, token } of roles) {
        // Create
        const createRes = await request(app)
          .post("/api/admin/verifiers")
          .set("Authorization", `Bearer ${token}`)
          .send(testBody)

        validateErrorEnvelope(createRes, 403, /forbidden/i)

        // Read (list)
        const listRes = await request(app)
          .get("/api/admin/verifiers")
          .set("Authorization", `Bearer ${token}`)

        validateErrorEnvelope(listRes, 403, /forbidden/i)

        // Read (specific)
        const readRes = await request(app)
          .get(`/api/admin/verifiers/${verifierId}`)
          .set("Authorization", `Bearer ${token}`)

        validateErrorEnvelope(readRes, 403, /forbidden/i)

        // Update
        const updateRes = await request(app)
          .patch(`/api/admin/verifiers/${verifierId}`)
          .set("Authorization", `Bearer ${token}`)
          .send({ status: "ACTIVE" })

        validateErrorEnvelope(updateRes, 403, /forbidden/i)

        // Delete
        const deleteRes = await request(app)
          .delete(`/api/admin/verifiers/${verifierId}`)
          .set("Authorization", `Bearer ${token}`)

        validateErrorEnvelope(deleteRes, 403, /forbidden/i)

        // Approve
        const approveRes = await request(app)
          .post(`/api/admin/verifiers/${verifierId}/approve`)
          .set("Authorization", `Bearer ${token}`)
          .send({ notes: "Test" })

        validateErrorEnvelope(approveRes, 403, /forbidden/i)

        // Suspend
        const suspendRes = await request(app)
          .post(`/api/admin/verifiers/${verifierId}/suspend`)
          .set("Authorization", `Bearer ${token}`)
          .send({ reason: "Test" })

        validateErrorEnvelope(suspendRes, 403, /forbidden/i)
      }
    })
  })

  /**
   * Security Bypass Prevention for Admin Verifier Management
   */
  describe("Security Bypass Prevention", () => {
    const testEndpoints = [
      "/api/admin/verifiers",
      "/api/admin/verifiers/test-id",
      "/api/admin/verifiers/test-id/approve",
      "/api/admin/verifiers/test-id/suspend"
    ]

    testEndpoints.forEach(endpoint => {
      it(`prevents header spoofing on ${endpoint}`, async () => {
        const bypassTests = createSecurityBypassTests(endpoint)
        
        for (const test of bypassTests) {
          const verifierToken = TEST_TOKENS.verifier()
          const res = await request(app)
            .get(endpoint)
            .set("Authorization", `Bearer ${verifierToken}`)
            .set(test.headers)

          // Should receive 403 (insufficient role), not 200 (success from spoofed header)
          validateErrorEnvelope(res, 403, test.expectedErrorPattern)
        }
      })
    })

    it("ignores multiple simultaneous role headers", async () => {
      const maliciousHeaders = {
        'x-user-role': 'ADMIN',
        'x-requested-role': 'ADMIN',
        'role': 'ADMIN',
        'x-auth-role': 'ADMIN',
        'authorization-role': 'ADMIN'
      }

      const verifierToken = TEST_TOKENS.verifier()
      const res = await request(app)
        .get("/api/admin/verifiers")
        .set("Authorization", `Bearer ${verifierToken}`)
        .set(maliciousHeaders)

      validateErrorEnvelope(res, 403, /forbidden/i)
    })

    it("returns 401 when role headers present without token", async () => {
      const res = await request(app)
        .get("/api/admin/verifiers")
        .set("x-user-role", "ADMIN")
        .set("x-requested-role", "ADMIN")

      validateErrorEnvelope(res, 401, /unauthorized/i)
    })

    it("prevents privilege escalation through POST body manipulation", async () => {
      const maliciousBody = {
        userId: "test-verifier",
        role: "ADMIN", // Attempt to set admin role
        permissions: ["admin", "superuser"],
        isAdmin: true,
        escalatePrivileges: true
      }

      const verifierToken = TEST_TOKENS.verifier()
      const res = await request(app)
        .post("/api/admin/verifiers")
        .set("Authorization", `Bearer ${verifierToken}`)
        .send(maliciousBody)

      // Should be denied based on JWT role, not request body
      validateErrorEnvelope(res, 403, /forbidden/i)
    })
  })

  /**
   * Token Manipulation Security Tests
   */
  describe("Token Manipulation Security Tests", () => {
    it("rejects malformed tokens on all endpoints", async () => {
      const endpoints = [
        { method: 'get', path: '/api/admin/verifiers' },
        { method: 'post', path: '/api/admin/verifiers' },
        { method: 'get', path: '/api/admin/verifiers/test-id' },
        { method: 'patch', path: '/api/admin/verifiers/test-id' },
        { method: 'delete', path: '/api/admin/verifiers/test-id' }
      ]

      for (const { method, path } of endpoints) {
        const res = await request(app)
          [method as 'get' | 'post' | 'patch' | 'delete'](path)
          .set("Authorization", `Bearer ${INVALID_TOKENS.malformed()}`)
          .send({})

        validateErrorEnvelope(res, 401, /invalid|unauthorized/i)
      }
    })

    it("rejects expired tokens on all endpoints", async () => {
      const endpoints = [
        { method: 'get', path: '/api/admin/verifiers' },
        { method: 'post', path: '/api/admin/verifiers' },
        { method: 'patch', path: '/api/admin/verifiers/test-id' }
      ]

      for (const { method, path } of endpoints) {
        const res = await request(app)
          [method as 'get' | 'post' | 'patch' | 'delete'](path)
          .set("Authorization", `Bearer ${INVALID_TOKENS.expired()}`)
          .send({})

        validateErrorEnvelope(res, 401, /expired|unauthorized/i)
      }
    })

    it("rejects tokens with wrong signature", async () => {
      const res = await request(app)
        .get("/api/admin/verifiers")
        .set("Authorization", `Bearer ${INVALID_TOKENS.wrongSecret()}`)

      validateErrorEnvelope(res, 401, /invalid|unauthorized/i)
    })
  })

  /**
   * Authentication Precedence Invariant
   */
  describe("Authentication Before Authorization", () => {
    it("returns 401 (not 403) when Authorization header is missing", async () => {
      const res = await request(app).get("/api/admin/verifiers")

      expect(res.status).toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("returns 401 (not 403) when token is malformed", async () => {
      const res = await request(app)
        .get("/api/admin/verifiers")
        .set("Authorization", "Bearer malformed..token")

      expect(res.status).toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("returns 401 when Bearer prefix is missing", async () => {
      const token = TEST_TOKENS.admin()
      const res = await request(app)
        .get("/api/admin/verifiers")
        .set("Authorization", token) // Missing "Bearer " prefix

      validateErrorEnvelope(res, 401, /missing|malformed/i)
    })
  })

  /**
   * Error Response Consistency
   */
  describe("Error Response Consistency", () => {
    it("401 responses include proper error message", async () => {
      const res = await request(app).get("/api/admin/verifiers")

      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty("error")
      expect(typeof res.body.error).toBe("string")
      expect(res.body.error.toLowerCase()).toMatch(/unauthorized|missing|malformed/)
    })

    it("403 responses include proper error message", async () => {
      const res = await request(app)
        .get("/api/admin/verifiers")
        .set("Authorization", `Bearer ${TEST_TOKENS.verifier()}`)

      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty("error")
      expect(typeof res.body.error).toBe("string")
      expect(res.body.error.toLowerCase()).toMatch(/forbidden|requires|insufficient/)
    })

    it("403 responses optionally include detailed message", async () => {
      const res = await request(app)
        .post("/api/admin/verifiers")
        .set("Authorization", `Bearer ${TEST_TOKENS.user()}`)
        .send({ userId: "test" })

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
   * Edge Case Security Tests
   */
  describe("Edge Case Security Tests", () => {
    it("handles extremely long user IDs in URL parameters", async () => {
      const longUserId = 'A'.repeat(1000)
      const res = await request(app)
        .get(`/api/admin/verifiers/${longUserId}`)
        .set("Authorization", `Bearer ${TEST_TOKENS.admin()}`)

      // Should not be auth/authz error
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("handles special characters in user IDs", async () => {
      const specialUserId = "test<script>alert(1)</script>"
      const res = await request(app)
        .get(`/api/admin/verifiers/${encodeURIComponent(specialUserId)}`)
        .set("Authorization", `Bearer ${TEST_TOKENS.admin()}`)

      // Should not be auth/authz error
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it("validates that 404 errors still require authentication", async () => {
      const res = await request(app).get("/api/admin/verifiers/nonexistent")
      
      // Should get 401 (auth required) before 404 (not found)
      validateErrorEnvelope(res, 401, /unauthorized/i)
    })

    it("validates that 404 errors still require authorization", async () => {
      const userToken = TEST_TOKENS.user()
      const res = await request(app)
        .get("/api/admin/verifiers/nonexistent")
        .set("Authorization", `Bearer ${userToken}`)
      
      // Should get 403 (insufficient role) before 404 (not found)
      validateErrorEnvelope(res, 403, /forbidden/i)
    })
  })
})