import { createHash, randomBytes } from "node:crypto";
import {
  MACHINE_CREDENTIAL_PRESET_CAPABILITIES,
  machineCapabilityValues,
  type MachineCapability,
  type MachineCredentialPreset
} from "@ironside/shared";
import type { Redis } from "ioredis";
import type { Pool, PoolClient } from "pg";
import { ulid } from "ulid";

const SCOPED_TOKEN_PREFIX = "ironside_sc_";
const CACHE_PREFIX = "machinecred:v1:";
const CACHE_TTL_SECONDS = 60;
const REVOKED_SENTINEL = "__revoked__";
const CAPABILITIES = new Set<string>(machineCapabilityValues);

export function hashMachineCredential(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateMachineCredentialToken(): string {
  return `${SCOPED_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

export interface CredentialActorInput {
  principalId: string | null;
  username: string;
}

export interface CreatedMachineCredentialRow {
  id: string;
  projectId: string;
  name: string;
  token: string;
  tokenPrefix: string;
  preset: MachineCredentialPreset;
  capabilities: MachineCapability[];
  expiresAt: Date | null;
  createdBy: CredentialActorInput;
  createdAt: Date;
  lastUsedAt: null;
  revokedAt: null;
  revokedBy: null;
}

interface CreateMachineCredentialInput {
  projectId: string;
  organizationId: string;
  name: string;
  preset: MachineCredentialPreset;
  expiresAt: Date | null;
  actor: CredentialActorInput;
}

async function recordCredentialAudit(
  client: PoolClient,
  eventType: "machine_credential.created" | "machine_credential.revoked",
  input: {
    principalId: string | null;
    organizationId: string;
    username: string;
    credentialId: string;
    projectId: string;
    tokenPrefix: string;
    preset: MachineCredentialPreset;
    capabilities: readonly MachineCapability[];
    expiresAt: Date | null;
  }
): Promise<void> {
  await client.query(
    `insert into auth_audit_events (id, event_type, principal_id, organization_id, details)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [
      `audit_${ulid()}`,
      eventType,
      input.principalId,
      input.organizationId,
      JSON.stringify({
        actorUsername: input.username,
        credentialId: input.credentialId,
        projectId: input.projectId,
        tokenPrefix: input.tokenPrefix,
        preset: input.preset,
        capabilities: input.capabilities,
        expiresAt: input.expiresAt?.toISOString() ?? null
      })
    ]
  );
}

/** Inserts a scoped credential and its creation audit inside the caller's transaction. */
export async function insertMachineCredential(
  client: PoolClient,
  input: CreateMachineCredentialInput
): Promise<CreatedMachineCredentialRow> {
  const token = generateMachineCredentialToken();
  const id = `cred_${ulid()}`;
  const tokenPrefix = token.slice(0, SCOPED_TOKEN_PREFIX.length + 4);
  const capabilities = [...MACHINE_CREDENTIAL_PRESET_CAPABILITIES[input.preset]];
  const result = await client.query<{ created_at: Date }>(
    `insert into machine_credentials
       (id, project_id, name, token_hash, token_prefix, preset, capabilities,
        expires_at, created_by_principal_id, created_by_username)
     values ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10)
     returning created_at`,
    [
      id,
      input.projectId,
      input.name,
      hashMachineCredential(token),
      tokenPrefix,
      input.preset,
      capabilities,
      input.expiresAt,
      input.actor.principalId,
      input.actor.username
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("failed to create machine credential");
  await recordCredentialAudit(client, "machine_credential.created", {
    principalId: input.actor.principalId,
    organizationId: input.organizationId,
    username: input.actor.username,
    credentialId: id,
    projectId: input.projectId,
    tokenPrefix,
    preset: input.preset,
    capabilities,
    expiresAt: input.expiresAt
  });
  return {
    id,
    projectId: input.projectId,
    name: input.name,
    token,
    tokenPrefix,
    preset: input.preset,
    capabilities,
    expiresAt: input.expiresAt,
    createdBy: input.actor,
    createdAt: row.created_at,
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null
  };
}

export async function createMachineCredential(
  pool: Pool,
  input: CreateMachineCredentialInput
): Promise<CreatedMachineCredentialRow> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const created = await insertMachineCredential(client, input);
    await client.query("commit");
    return created;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface MachineCredentialSummaryRow {
  id: string;
  projectId: string;
  name: string;
  tokenPrefix: string;
  preset: MachineCredentialPreset;
  capabilities: MachineCapability[];
  expiresAt: Date | null;
  createdBy: CredentialActorInput | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedBy: CredentialActorInput | null;
}

interface CredentialSummaryDbRow {
  id: string;
  project_id: string;
  name: string;
  token_prefix: string;
  preset: MachineCredentialPreset;
  capabilities: string[];
  expires_at: Date | null;
  created_by_principal_id: string | null;
  created_by_username: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revoked_by_principal_id: string | null;
  revoked_by_username: string | null;
}

function validCapabilities(values: string[]): values is MachineCapability[] {
  return values.length > 0 && values.every((value) => CAPABILITIES.has(value));
}

function summaryFromRow(row: CredentialSummaryDbRow): MachineCredentialSummaryRow {
  if (!validCapabilities(row.capabilities)) throw new Error(`credential ${row.id} has invalid capabilities`);
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    preset: row.preset,
    capabilities: row.capabilities,
    expiresAt: row.expires_at,
    createdBy:
      row.created_by_username === null
        ? null
        : { principalId: row.created_by_principal_id, username: row.created_by_username },
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedBy:
      row.revoked_by_username === null
        ? null
        : { principalId: row.revoked_by_principal_id, username: row.revoked_by_username }
  };
}

export async function listMachineCredentials(pool: Pool, projectId: string): Promise<MachineCredentialSummaryRow[]> {
  const result = await pool.query<CredentialSummaryDbRow>(
    `select id, project_id, name, token_prefix, preset, capabilities,
            expires_at, created_by_principal_id,
            created_by_username, created_at, last_used_at, revoked_at,
            revoked_by_principal_id, revoked_by_username
       from machine_credentials
      where project_id = $1
      order by created_at desc, id desc`,
    [projectId]
  );
  return result.rows.map(summaryFromRow);
}

interface RevokedCredentialRow {
  id: string;
  project_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  preset: MachineCredentialPreset;
  capabilities: MachineCapability[];
  expires_at: Date | null;
}

async function writeRevokedSentinel(redis: Redis, tokenHash: string): Promise<void> {
  const cacheKey = `${CACHE_PREFIX}${tokenHash}`;
  const result = await redis.set(cacheKey, REVOKED_SENTINEL, "EX", CACHE_TTL_SECONDS);
  if (result !== "OK") throw new Error("failed to persist credential revocation sentinel");
}

export async function revokeMachineCredential(
  pool: Pool,
  redis: Redis,
  input: {
    projectId: string;
    organizationId: string;
    credentialId: string;
    actor: CredentialActorInput;
  }
): Promise<boolean> {
  const client = await pool.connect();
  let revoked: RevokedCredentialRow | undefined;
  try {
    await client.query("begin");
    const result = await client.query<RevokedCredentialRow>(
      `update machine_credentials
          set revoked_at = now(), revoked_by_principal_id = $3, revoked_by_username = $4
        where id = $1 and project_id = $2 and revoked_at is null
        returning id, project_id, name, token_hash, token_prefix, preset,
                  capabilities, expires_at`,
      [input.credentialId, input.projectId, input.actor.principalId, input.actor.username]
    );
    revoked = result.rows[0];

    if (!revoked) {
      await client.query("rollback");
      return false;
    }
    await recordCredentialAudit(client, "machine_credential.revoked", {
      principalId: input.actor.principalId,
      organizationId: input.organizationId,
      username: input.actor.username,
      credentialId: revoked.id,
      projectId: revoked.project_id,
      tokenPrefix: revoked.token_prefix,
      preset: revoked.preset,
      capabilities: revoked.capabilities,
      expiresAt: revoked.expires_at
    });
    await writeRevokedSentinel(redis, revoked.token_hash);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  return true;
}

export interface ResolvedMachineCredential {
  credentialId: string;
  projectId: string;
  capabilities: MachineCapability[];
  expiresAt: string | null;
}

function parseCachedCredential(value: string): ResolvedMachineCredential | null {
  try {
    const parsed = JSON.parse(value) as Partial<ResolvedMachineCredential>;
    if (
      typeof parsed.credentialId !== "string" ||
      typeof parsed.projectId !== "string" ||
      !Array.isArray(parsed.capabilities) ||
      !validCapabilities(parsed.capabilities) ||
      !(
        parsed.expiresAt === null ||
        (typeof parsed.expiresAt === "string" && Number.isFinite(Date.parse(parsed.expiresAt)))
      )
    ) {
      return null;
    }
    return {
      credentialId: parsed.credentialId,
      projectId: parsed.projectId,
      capabilities: parsed.capabilities,
      expiresAt: parsed.expiresAt
    };
  } catch {
    return null;
  }
}

function isExpired(expiresAt: string | null): boolean {
  if (expiresAt === null) return false;
  const timestamp = Date.parse(expiresAt);
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
}

function cacheTtl(expiresAt: string | null): number {
  if (!expiresAt) return CACHE_TTL_SECONDS;
  return Math.max(1, Math.min(CACHE_TTL_SECONDS, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000)));
}

interface ResolvedDbRow {
  credential_id: string;
  project_id: string;
  capabilities: string[];
  expires_at: Date | null;
}

/** Resolves and authorizes a scoped machine credential. */
export async function resolveMachineCredential(
  pool: Pool,
  redis: Redis,
  token: string
): Promise<ResolvedMachineCredential | null> {
  if (!/^ironside_sc_[0-9a-f]{64}$/.test(token)) return null;

  const hash = hashMachineCredential(token);
  const cacheKey = `${CACHE_PREFIX}${hash}`;
  const cachedValue = await redis.get(cacheKey);
  if (cachedValue === REVOKED_SENTINEL) return null;
  if (cachedValue) {
    const cached = parseCachedCredential(cachedValue);
    if (cached && !isExpired(cached.expiresAt)) return cached;
    await redis.del(cacheKey);
    if (cached && isExpired(cached.expiresAt)) return null;
  }

  const result = await pool.query<ResolvedDbRow>(
    `select id as credential_id, project_id, capabilities, expires_at
       from machine_credentials
      where token_hash = $1 and revoked_at is null
        and (expires_at is null or expires_at > now())`,
    [hash]
  );
  const row = result.rows[0];
  if (!row || !validCapabilities(row.capabilities)) return null;

  const resolved: ResolvedMachineCredential = {
    credentialId: row.credential_id,
    projectId: row.project_id,
    capabilities: row.capabilities,
    expiresAt: row.expires_at?.toISOString() ?? null
  };
  const setResult = await redis.set(
    cacheKey,
    JSON.stringify(resolved),
    "EX",
    cacheTtl(resolved.expiresAt),
    "NX"
  );
  if (setResult === null) {
    const winner = await redis.get(cacheKey);
    if (winner === REVOKED_SENTINEL) return null;
    const cachedWinner = winner ? parseCachedCredential(winner) : null;
    if (!cachedWinner || isExpired(cachedWinner.expiresAt)) return null;
    return cachedWinner;
  }

  void pool.query("update machine_credentials set last_used_at = now() where token_hash = $1", [hash]).catch(() => {});
  return resolved;
}

export const __testing = {
  CACHE_PREFIX,
  REVOKED_SENTINEL
};
