import type { Pool, PoolClient } from "pg";
import { ulid } from "ulid";

const OWNER_AUTH_LOCK_ID = 427193857;

export type OwnerAuthState =
  | { state: "setup" }
  | { state: "login"; organizationName: string; username: string };

export type AuthChallengePurpose = "setup" | "recovery";

export interface ActiveAuthChallenge {
  id: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface OwnerPrincipal {
  id: string;
  organizationId: string;
  organizationName: string;
  username: string;
  usernameNormalized: string;
  passwordHash: string;
  createdAt: Date;
}

export interface OwnerSession {
  id: string;
  principalId: string;
  organizationId: string;
  organizationName: string;
  username: string;
  createdAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export type OwnerAuthErrorCode =
  | "challenge_invalid"
  | "setup_closed"
  | "owner_missing";

export class OwnerAuthError extends Error {
  constructor(readonly code: OwnerAuthErrorCode) {
    super(code);
    this.name = "OwnerAuthError";
  }
}

interface PrincipalRow {
  id: string;
  organization_id: string;
  organization_name: string;
  username: string;
  username_normalized: string;
  password_hash: string;
  created_at: Date;
}

interface SessionRow {
  id: string;
  principal_id: string;
  organization_id: string;
  organization_name: string;
  username: string;
  created_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
}

function toPrincipal(row: PrincipalRow): OwnerPrincipal {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    username: row.username,
    usernameNormalized: row.username_normalized,
    passwordHash: row.password_hash,
    createdAt: row.created_at
  };
}

function toSession(row: SessionRow): OwnerSession {
  return {
    id: row.id,
    principalId: row.principal_id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    username: row.username,
    createdAt: row.created_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at
  };
}

async function withTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function lockOwnerAuth(client: PoolClient): Promise<void> {
  await client.query("select pg_advisory_xact_lock($1)", [OWNER_AUTH_LOCK_ID]);
}

async function recordAudit(
  client: PoolClient,
  eventType: string,
  principalId: string | null,
  organizationId: string | null,
  details: Record<string, unknown> = {}
): Promise<void> {
  await client.query(
    `insert into auth_audit_events (id, event_type, principal_id, organization_id, details)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [`audit_${ulid()}`, eventType, principalId, organizationId, JSON.stringify(details)]
  );
}

export async function getOwnerAuthState(pool: Pool): Promise<OwnerAuthState> {
  const owner = await pool.query<{ organization_name: string; username: string }>(
    `select o.name as organization_name, p.username
       from owner_principals p
       join organizations o on o.id = p.organization_id
      limit 2`
  );
  if (owner.rows[0]) {
    return {
      state: "login",
      organizationName: owner.rows[0].organization_name,
      username: owner.rows[0].username
    };
  }

  return { state: "setup" };
}

export async function issueSetupChallenge(
  pool: Pool,
  tokenHash: string,
  expiresAt: Date
): Promise<ActiveAuthChallenge> {
  return withTransaction(pool, async (client) => {
    await lockOwnerAuth(client);
    const owners = await client.query("select id from owner_principals limit 1");
    if ((owners.rowCount ?? 0) > 0) throw new OwnerAuthError("setup_closed");

    await client.query(
      "update owner_auth_challenges set consumed_at = now() where purpose = 'setup' and consumed_at is null"
    );
    const id = `challenge_${ulid()}`;
    const result = await client.query<{ expires_at: Date }>(
      `insert into owner_auth_challenges (id, purpose, token_hash, expires_at)
       values ($1, 'setup', $2, $3)
       returning expires_at`,
      [id, tokenHash, expiresAt]
    );
    await recordAudit(client, "setup_challenge_issued", null, null, {
      expiresAt: expiresAt.toISOString()
    });
    return { id, tokenHash, expiresAt: result.rows[0]!.expires_at };
  });
}

export async function issueRecoveryChallenge(
  pool: Pool,
  tokenHash: string,
  expiresAt: Date
): Promise<ActiveAuthChallenge> {
  return withTransaction(pool, async (client) => {
    await lockOwnerAuth(client);
    const owner = await client.query<{ id: string; organization_id: string }>(
      "select id, organization_id from owner_principals limit 2"
    );
    if (owner.rows.length !== 1) throw new OwnerAuthError("owner_missing");

    await client.query(
      "update owner_auth_challenges set consumed_at = now() where purpose = 'recovery' and consumed_at is null"
    );
    const id = `challenge_${ulid()}`;
    const result = await client.query<{ expires_at: Date }>(
      `insert into owner_auth_challenges (id, purpose, token_hash, expires_at)
       values ($1, 'recovery', $2, $3)
       returning expires_at`,
      [id, tokenHash, expiresAt]
    );
    await recordAudit(client, "recovery_challenge_issued", owner.rows[0]!.id, owner.rows[0]!.organization_id, {
      expiresAt: expiresAt.toISOString()
    });
    return { id, tokenHash, expiresAt: result.rows[0]!.expires_at };
  });
}

export async function listActiveAuthChallenges(
  pool: Pool,
  purpose: AuthChallengePurpose
): Promise<ActiveAuthChallenge[]> {
  const result = await pool.query<{ id: string; token_hash: string; expires_at: Date }>(
    `select id, token_hash, expires_at
       from owner_auth_challenges
      where purpose = $1 and consumed_at is null and expires_at > now()
      order by created_at desc`,
    [purpose]
  );
  return result.rows.map((row) => ({ id: row.id, tokenHash: row.token_hash, expiresAt: row.expires_at }));
}

export interface ClaimSetupInput {
  challengeId: string;
  tokenHash: string;
  username: string;
  usernameNormalized: string;
  passwordHash: string;
  defaultOrganizationName: string;
}

export async function claimOwnerSetup(pool: Pool, input: ClaimSetupInput): Promise<OwnerPrincipal> {
  return withTransaction(pool, async (client) => {
    await lockOwnerAuth(client);
    const challenge = await client.query<{
      token_hash: string;
      consumed_at: Date | null;
      unexpired: boolean;
    }>(
      `select token_hash, consumed_at, expires_at > now() as unexpired
         from owner_auth_challenges
        where id = $1 and purpose = 'setup'
        for update`,
      [input.challengeId]
    );
    const row = challenge.rows[0];
    if (!row || row.token_hash !== input.tokenHash || row.consumed_at || !row.unexpired) {
      throw new OwnerAuthError("challenge_invalid");
    }

    const existingOwner = await client.query("select id from owner_principals limit 1");
    if ((existingOwner.rowCount ?? 0) > 0) throw new OwnerAuthError("setup_closed");

    const organization = await client.query<{ id: string; name: string }>(
      "insert into organizations (id, name) values ($1, $2) returning id, name",
      [`org_${ulid()}`, input.defaultOrganizationName]
    );
    const organizationRow = organization.rows[0]!;

    const principalId = `owner_${ulid()}`;
    const inserted = await client.query<PrincipalRow>(
      `insert into owner_principals
         (id, organization_id, username, username_normalized, password_hash)
       values ($1, $2, $3, $4, $5)
       returning id, organization_id, $6::text as organization_name,
                 username, username_normalized, password_hash, created_at`,
      [
        principalId,
        organizationRow.id,
        input.username,
        input.usernameNormalized,
        input.passwordHash,
        organizationRow.name
      ]
    );
    await client.query(
      "update owner_auth_challenges set consumed_at = now() where purpose = 'setup' and consumed_at is null"
    );
    await recordAudit(client, "owner_setup_completed", principalId, organizationRow.id);
    return toPrincipal(inserted.rows[0]!);
  });
}

export async function findOwnerByUsername(pool: Pool, usernameNormalized: string): Promise<OwnerPrincipal | null> {
  const result = await pool.query<PrincipalRow>(
    `select p.id, p.organization_id, o.name as organization_name,
            p.username, p.username_normalized, p.password_hash, p.created_at
       from owner_principals p
       join organizations o on o.id = p.organization_id
      where p.username_normalized = $1`,
    [usernameNormalized]
  );
  return result.rows[0] ? toPrincipal(result.rows[0]) : null;
}

export async function claimOwnerRecovery(
  pool: Pool,
  input: { challengeId: string; tokenHash: string; passwordHash: string }
): Promise<OwnerPrincipal> {
  return withTransaction(pool, async (client) => {
    await lockOwnerAuth(client);
    const challenge = await client.query<{
      token_hash: string;
      consumed_at: Date | null;
      unexpired: boolean;
    }>(
      `select token_hash, consumed_at, expires_at > now() as unexpired
         from owner_auth_challenges
        where id = $1 and purpose = 'recovery'
        for update`,
      [input.challengeId]
    );
    const row = challenge.rows[0];
    if (!row || row.token_hash !== input.tokenHash || row.consumed_at || !row.unexpired) {
      throw new OwnerAuthError("challenge_invalid");
    }

    const owner = await client.query<PrincipalRow>(
      `select p.id, p.organization_id, o.name as organization_name,
              p.username, p.username_normalized, p.password_hash, p.created_at
         from owner_principals p
         join organizations o on o.id = p.organization_id
        limit 2
        for update of p`
    );
    if (owner.rows.length !== 1) throw new OwnerAuthError("owner_missing");

    await client.query(
      "update owner_principals set password_hash = $1, updated_at = now() where id = $2",
      [input.passwordHash, owner.rows[0]!.id]
    );
    await client.query(
      "update owner_sessions set revoked_at = now() where principal_id = $1 and revoked_at is null",
      [owner.rows[0]!.id]
    );
    await client.query(
      "update owner_auth_challenges set consumed_at = now() where purpose = 'recovery' and consumed_at is null"
    );
    await recordAudit(
      client,
      "owner_recovery_completed",
      owner.rows[0]!.id,
      owner.rows[0]!.organization_id
    );
    return toPrincipal({ ...owner.rows[0]!, password_hash: input.passwordHash });
  });
}

export async function createOwnerSession(
  pool: Pool,
  input: {
    principalId: string;
    tokenHash: string;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    replacedTokenHash?: string;
  }
): Promise<OwnerSession> {
  return withTransaction(pool, async (client) => {
    if (input.replacedTokenHash) {
      await client.query(
        "update owner_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null",
        [input.replacedTokenHash]
      );
    }
    const result = await client.query<SessionRow>(
      `with inserted as (
         insert into owner_sessions
           (id, principal_id, token_hash, idle_expires_at, absolute_expires_at)
         values ($1, $2, $3, $4, $5)
         returning id, principal_id, created_at, idle_expires_at, absolute_expires_at
       )
       select i.id, i.principal_id, p.organization_id, o.name as organization_name,
              p.username, i.created_at, i.idle_expires_at, i.absolute_expires_at
         from inserted i
         join owner_principals p on p.id = i.principal_id
         join organizations o on o.id = p.organization_id`,
      [`session_${ulid()}`, input.principalId, input.tokenHash, input.idleExpiresAt, input.absoluteExpiresAt]
    );
    const session = toSession(result.rows[0]!);
    await recordAudit(client, "owner_login_succeeded", session.principalId, session.organizationId);
    return session;
  });
}

export async function resolveOwnerSession(
  pool: Pool,
  tokenHash: string,
  idleTtlSeconds: number
): Promise<OwnerSession | null> {
  const result = await pool.query<SessionRow>(
    `with refreshed as (
       update owner_sessions
          set last_seen_at = now(),
              idle_expires_at = least(absolute_expires_at, now() + ($2 * interval '1 second'))
        where token_hash = $1
          and revoked_at is null
          and idle_expires_at > now()
          and absolute_expires_at > now()
       returning id, principal_id, created_at, idle_expires_at, absolute_expires_at
     )
     select s.id, s.principal_id, p.organization_id, o.name as organization_name,
            p.username, s.created_at, s.idle_expires_at, s.absolute_expires_at
       from refreshed s
       join owner_principals p on p.id = s.principal_id
       join organizations o on o.id = p.organization_id`,
    [tokenHash, idleTtlSeconds]
  );
  return result.rows[0] ? toSession(result.rows[0]) : null;
}

export async function revokeOwnerSession(pool: Pool, tokenHash: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    const revoked = await client.query<{ principal_id: string; organization_id: string }>(
      `with revoked as (
         update owner_sessions
            set revoked_at = now()
          where token_hash = $1 and revoked_at is null
          returning principal_id
       )
       select r.principal_id, p.organization_id
         from revoked r join owner_principals p on p.id = r.principal_id`,
      [tokenHash]
    );
    if (revoked.rows[0]) {
      await recordAudit(
        client,
        "owner_logout",
        revoked.rows[0].principal_id,
        revoked.rows[0].organization_id
      );
    }
  });
}

export async function recordOwnerLoginFailure(
  pool: Pool,
  principal: Pick<OwnerPrincipal, "id" | "organizationId"> | null
): Promise<void> {
  const client = await pool.connect();
  try {
    await recordAudit(
      client,
      "owner_login_failed",
      principal?.id ?? null,
      principal?.organizationId ?? null
    );
  } finally {
    client.release();
  }
}
