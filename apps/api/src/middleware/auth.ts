import type { MiddlewareHandler } from "hono";
import type { MachineCapability } from "@ironside/shared";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { resolveMachineCredential } from "../lib/machine-credentials.js";

export interface AuthEnv {
  Variables: {
    projectId: string;
    credentialId: string;
    capabilities: MachineCapability[];
  };
}

/**
 * Extracts the caller's machine credential from either scheme:
 * - `Bearer <key>` — Ironside's native scheme.
 * - `Basic base64(anything:<key>)` — LangFuse SDK compat. LangFuse sends
 *   Basic base64(publicKey:secretKey); Ironside has no public/secret key
 *   pair concept, so the "secret key" slot is treated as the real
 *   Ironside machine token and the "public key" slot is ignored. See
 *   spec/langfuse-compat-v1.md.
 */
function extractToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  if (header.startsWith("Bearer ")) return header.slice(7);
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex === -1) return undefined;
    return decoded.slice(separatorIndex + 1);
  }
  return undefined;
}

export function machineAuth(
  pool: Pool,
  redis: Redis,
  requiredCapability: MachineCapability
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = extractToken(c.req.header("authorization"));
    if (!token) {
      return c.json({ error: "missing bearer token" }, 401);
    }
    const credential = await resolveMachineCredential(pool, redis, token);
    if (!credential) {
      return c.json({ error: "invalid machine credential" }, 401);
    }
    if (!credential.capabilities.includes(requiredCapability)) {
      return c.json({ error: `credential lacks ${requiredCapability} capability` }, 403);
    }
    c.set("projectId", credential.projectId);
    c.set("credentialId", credential.credentialId);
    c.set("capabilities", credential.capabilities);
    await next();
  };
}
