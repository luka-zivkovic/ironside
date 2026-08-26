import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Pool } from "pg";
import { getProject, resolveOwnerSession, type OwnerSession } from "@ironside/db";
import { hashOwnerSecret } from "../lib/owner-secrets.js";

export const OWNER_SESSION_COOKIE = "ironside_session";
const SESSION_TOKEN_PATTERN = /^ironside_session_[A-Za-z0-9_-]{43}$/;

export interface OwnerSessionEnv {
  Variables: {
    ownerSession: OwnerSession;
  };
}

export interface OwnerProjectEnv {
  Variables: {
    ownerSession: OwnerSession;
    projectId: string;
  };
}

export interface OwnerCookieOptions {
  secure: boolean;
  maxAgeSeconds: number;
}

export function getOwnerSessionToken(c: Parameters<typeof getCookie>[0]): string | null {
  const token = getCookie(c, OWNER_SESSION_COOKIE);
  return token && SESSION_TOKEN_PATTERN.test(token) ? token : null;
}

export function setOwnerSessionCookie(
  c: Parameters<typeof setCookie>[0],
  token: string,
  options: OwnerCookieOptions
): void {
  setCookie(c, OWNER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: options.secure,
    sameSite: "Lax",
    path: "/",
    maxAge: options.maxAgeSeconds,
    priority: "High"
  });
}

export function clearOwnerSessionCookie(c: Parameters<typeof deleteCookie>[0], secure: boolean): void {
  deleteCookie(c, OWNER_SESSION_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/"
  });
}

export async function resolveRequestOwnerSession(
  pool: Pool,
  c: Parameters<typeof getCookie>[0],
  idleTtlSeconds: number
): Promise<OwnerSession | null> {
  const token = getOwnerSessionToken(c);
  if (!token) return null;
  return resolveOwnerSession(pool, hashOwnerSecret(token), idleTtlSeconds);
}

export function ownerSessionAuth(
  pool: Pool,
  options: { idleTtlSeconds: number; secureCookies: boolean }
): MiddlewareHandler<OwnerSessionEnv> {
  return async (c, next) => {
    const session = await resolveRequestOwnerSession(pool, c, options.idleTtlSeconds);
    if (!session) {
      clearOwnerSessionCookie(c, options.secureCookies);
      return c.json({ error: "owner session required" }, 401);
    }
    c.set("ownerSession", session);
    await next();
  };
}

/**
 * Resolves the explicit project in a browser/control-plane URL against the
 * organization bound to the owner session. Missing and foreign projects are
 * deliberately indistinguishable so this boundary cannot be used to enumerate
 * another organization's project ids.
 */
export function ownerProjectAuth(pool: Pool): MiddlewareHandler<OwnerProjectEnv> {
  return async (c, next) => {
    const projectId = c.req.param("projectId");
    const project = projectId ? await getProject(pool, projectId) : null;
    if (!project || project.organizationId !== c.get("ownerSession").organizationId) {
      return c.json({ error: "project not found" }, 404);
    }
    c.set("projectId", project.id);
    await next();
  };
}

export function trustedBrowserMutation(origins: string[]): MiddlewareHandler {
  const allowed = new Set(origins.map((origin) => origin.replace(/\/$/, "")));
  return async (c, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      await next();
      return;
    }

    const fetchSite = c.req.header("sec-fetch-site");
    if (fetchSite === "cross-site") {
      return c.json({ error: "cross-site request rejected" }, 403);
    }

    const origin = c.req.header("origin")?.replace(/\/$/, "");
    if (!origin || !allowed.has(origin)) {
      return c.json({ error: "untrusted request origin" }, 403);
    }
    await next();
  };
}
