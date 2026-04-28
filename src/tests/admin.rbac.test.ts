import request from "supertest";
import { app } from "../app.js";
import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import jwt from "jsonwebtoken";
import { clearProcessedOverrides } from "../routes/admin.js";
import { clearAuditLogs } from "../lib/audit-logs.js";

// Create a test router with minimal dependencies to test RBAC
const testAdminRouter = Router();
testAdminRouter.use(authenticate);
testAdminRouter.use(requireAdmin);

const makeToken = (role: string, userId: string = "test-user") =>
  jwt.sign({ userId, role }, SECRET);

describe("Admin RBAC", () => {
  beforeEach(() => {
    clearProcessedOverrides();
    clearAuditLogs();
  });

  it("allows ADMIN", async () => {
    const res = await request(app)
      .get("/api/admin/audit-logs")
      .set("Authorization", `Bearer ${makeToken("ADMIN")}`);

    it("denies VERIFIER role with 403 Forbidden", async () => {
      const res = await request(app)
        .get("/api/admin/audit-logs")
        .set("Authorization", `Bearer ${makeToken("VERIFIER")}`);

      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty("error");
    });

    it("denies unauthenticated requests with 401 Unauthorized", async () => {
      const res = await request(app).get("/api/admin/audit-logs");

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error");
    });

    it("denies malformed token with 401 Unauthorized", async () => {
      const res = await request(app)
        .get("/api/admin/audit-logs")
        .set("Authorization", "Bearer invalid-token");

      expect(res.status).toBe(401);
    });
  });

  describe("Security Invariant: Authentication Before Authorization", () => {
    /**
     * These tests confirm the critical security invariant that authentication checks
     * ALWAYS occur before authorization checks. This means:
     * - Unauthenticated requests ALWAYS receive 401, never 403
     * - The absence of a valid token is caught before role checking happens
     */

    it("returns 401 (not 403) when Authorization header is missing", async () => {
      const res = await request(app).get("/api/admin/audit-logs");

      expect(res.status).toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("returns 401 (not 403) when token is malformed", async () => {
      const res = await request(app)
        .get("/api/admin/audit-logs")
        .set("Authorization", "Bearer malformed..invalid..token");

      expect(res.status).toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("returns 401 when Bearer prefix is missing", async () => {
      const token = makeToken("ADMIN");
      const res = await request(app)
        .get("/api/admin/audit-logs")
        .set("Authorization", token); // Missing "Bearer " prefix

      expect(res.status).toBe(401);
    });
  });

  describe("Security: Role Header Spoofing Prevention", () => {
    /**
     * These tests verify the critical security property that roles cannot be
     * escalated or changed via request headers. The authorize middleware reads
     * ONLY from req.user.role (set by authenticate middleware after JWT verification)
     * and NEVER from request headers like x-user-role, x-requested-role, etc.
     */

    it("ignores x-user-role: admin header when token is USER role", async () => {
      const userToken = makeToken("USER");
      const res = await request(app)
        .get("/api/admin/audit-logs")
        .set("Authorization", `Bearer ${userToken}`)
        .set("x-user-role", "ADMIN"); // Attempt to spoof admin role via header

      // Must receive 403 (insufficient permissions), not 200 (success)
      expect(res.status).toBe(403);
      expect(res.status).not.toBe(200);
    });

    it("ignores x-requested-role header regardless of token", async () => {
      const adminToken = makeToken("ADMIN");
      const res = await request(app)
        .get("/api/admin/audit-logs")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("x-requested-role", "SUPERADMIN"); // Attempt role escalation via header

      // Admin can access, and the header is ignored (so success, not error)
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it("returns 401 when x-user-role header is present without token", async () => {
      const res = await request(app)
        .get("/api/admin/audit-logs")
        .set("x-user-role", "ADMIN"); // Header alone, no token

      expect(res.status).toBe(401);
      expect(res.status).not.toBe(403); // Not treated as role failure, auth failure
    });
  });

  describe("Error Envelope Consistency", () => {
    /**
     * Verify that error responses follow a consistent shape with
     * proper HTTP status codes and error messages.
     */

    it("401 response includes error message", async () => {
      const res = await request(app).get("/api/admin/audit-logs");

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error");
      expect(typeof res.body.error).toBe("string");
      expect(res.body.error.length).toBeGreaterThan(0);
    });

    it("403 response includes error message", async () => {
      const res = await request(app)
        .get("/api/admin/audit-logs")
        .set("Authorization", `Bearer ${makeToken("USER")}`);

      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty("error");
      expect(typeof res.body.error).toBe("string");
    });
  });
});

describe("Admin Override RBAC Security", () => {
  beforeEach(() => {
    clearProcessedOverrides();
    clearAuditLogs();
  });

  describe("POST /api/admin/overrides/vaults/:id/cancel", () => {
    it("denies USER role from performing admin overrides", async () => {
      const res = await request(app)
        .post("/api/admin/overrides/vaults/test-vault-id/cancel")
        .set("Authorization", `Bearer ${makeToken("USER", "user-123")}`)
        .send({
          reasonCode: "USER_REQUEST",
          reason: "Test reason",
        });

      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty("error");
    });

    it("denies VERIFIER role from performing admin overrides", async () => {
      const res = await request(app)
        .post("/api/admin/overrides/vaults/test-vault-id/cancel")
        .set("Authorization", `Bearer ${makeToken("VERIFIER", "verifier-123")}`)
        .send({
          reasonCode: "FRAUD_DETECTED",
          reason: "Suspicious activity",
        });

      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty("error");
    });

    it("denies unauthenticated access to admin overrides", async () => {
      const res = await request(app)
        .post("/api/admin/overrides/vaults/test-vault-id/cancel")
        .send({
          reasonCode: "SYSTEM_ERROR",
          reason: "System error",
        });

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error");
    });

    it("allows ADMIN to access override endpoint", async () => {
      // Note: This test may return 404 or 409 depending on vault state,
      // but should NOT return 403 (Forbidden)
      const res = await request(app)
        .post("/api/admin/overrides/vaults/non-existent-vault/cancel")
        .set("Authorization", `Bearer ${makeToken("ADMIN", "admin-123")}`)
        .send({
          reasonCode: "TESTING_CLEANUP",
          reason: "Test admin access",
        });

      // Should not be forbidden - actual error depends on vault state
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it("denies expired token access", async () => {
      const expiredToken = jwt.sign(
        { userId: "test-admin", role: "ADMIN", exp: Math.floor(Date.now() / 1000) - 3600 },
        SECRET
      );

      const res = await request(app)
        .post("/api/admin/overrides/vaults/test-vault-id/cancel")
        .set("Authorization", `Bearer ${expiredToken}`)
        .send({
          reasonCode: "EMERGENCY_ADMIN_ACTION",
        });

      expect(res.status).toBe(401);
    });

    it("denies malformed token access", async () => {
      const res = await request(app)
        .post("/api/admin/overrides/vaults/test-vault-id/cancel")
        .set("Authorization", "Bearer invalid-token-here")
        .send({
          reasonCode: "POLICY_VIOLATION",
        });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/admin/audit-logs/:id (audit log access)", () => {
    it("denies USER from accessing specific audit logs", async () => {
      const res = await request(app)
        .get("/api/admin/audit-logs/audit-12345")
        .set("Authorization", `Bearer ${makeToken("USER")}`);

      expect(res.status).toBe(403);
    });

    it("denies VERIFIER from accessing specific audit logs", async () => {
      const res = await request(app)
        .get("/api/admin/audit-logs/audit-12345")
        .set("Authorization", `Bearer ${makeToken("VERIFIER")}`);

      expect(res.status).toBe(403);
    });

    it("allows ADMIN to access specific audit logs", async () => {
      // Will return 404 since audit log doesn't exist, but not 403
      const res = await request(app)
        .get("/api/admin/audit-logs/non-existent-audit-id")
        .set("Authorization", `Bearer ${makeToken("ADMIN")}`);

      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });
  });
});
