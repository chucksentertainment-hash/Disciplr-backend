import { Request, Response, NextFunction } from 'express'
import { UserRole } from '../types/user.js'
import { getVerifierProfile } from '../services/verifiers.js'

type RBACOptions = {
  allow: UserRole[];
};

const logRBACDenied = (req: Request, reason: string) => {
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "security.rbac_denied",
      service: "disciplr-backend",
      userId: req.user?.userId ?? "unknown",
      role: req.user?.role ?? "unknown",
      path: req.originalUrl,
      method: req.method,
      reason,
      timestamp: new Date().toISOString(),
    }),
  );
};

export const enforceRBAC = (options: RBACOptions) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Deny by default
    if (!req.user) {
      logRBACDenied(req, "missing_user");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!options.allow.includes(req.user.role)) {
      logRBACDenied(req, "insufficient_role");
      res.status(403).json({
        error: "Forbidden",
        message: `Requires role: ${options.allow.join(", ")}`,
      });
      return;
    }

    next();
  };
};

// Convenience
export const requireUser = enforceRBAC({
  allow: [UserRole.USER, UserRole.VERIFIER, UserRole.ADMIN],
})

export const requireVerifier = enforceRBAC({
  allow: [UserRole.VERIFIER, UserRole.ADMIN],
})

export const requireAdmin = enforceRBAC({
  allow: [UserRole.ADMIN],
})

// Middleware to check if verifier has an active profile
export const requireActiveVerifier = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!req.user || req.user.role !== UserRole.VERIFIER) {
    logRBACDenied(req, "not_verifier");
    res.status(403).json({ error: "Forbidden", message: "Requires active verifier role" });
    return;
  }
  
  try {
    const profile = await getVerifierProfile(req.user.userId);
    if (!profile || !profile.isActive) {
      logRBACDenied(req, "verifier_not_active");
      res.status(403).json({ error: "Forbidden", message: "Verifier account is not active" });
      return;
    }
    next();
  } catch (error) {
    logRBACDenied(req, "verifier_profile_error");
    res.status(500).json({ error: "Internal server error" });
  }
};
