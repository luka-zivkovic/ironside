// Host-local recovery never creates another owner. It issues a short-lived,
// single-use capability that can only replace the existing owner's password;
// successful recovery revokes every active owner session.
import { issueRecoveryChallenge, OwnerAuthError, runMigrations } from "@ironside/db";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { generateOwnerChallengeToken } from "../lib/owner-secrets.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });

try {
  await runMigrations(pool);
  const issued = generateOwnerChallengeToken("recovery");
  const expiresAt = new Date(Date.now() + config.authChallengeTtlSeconds * 1000);
  await issueRecoveryChallenge(pool, issued.tokenHash, expiresAt);

  console.log("Owner recovery capability (shown once):");
  console.log(issued.token);
  console.log(`Expires: ${expiresAt.toISOString()}`);
  console.log(`Open: ${config.webOrigins[0] ?? "the Ironside web URL"}/recover`);
} catch (error) {
  if (error instanceof OwnerAuthError && error.code === "owner_missing") {
    console.error("Owner recovery is unavailable until initial owner setup is complete.");
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}
