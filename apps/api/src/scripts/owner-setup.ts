// Host-local owner bootstrap. The plaintext capability is shown once; only
// its SHA-256 hash is persisted, and a successful setup atomically consumes
// it. The short expiry bounds exposure through terminal or container logs.
import { issueSetupChallenge, OwnerAuthError, runMigrations } from "@ironside/db";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { generateOwnerChallengeToken } from "../lib/owner-secrets.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });

try {
  await runMigrations(pool);
  const issued = generateOwnerChallengeToken("setup");
  const expiresAt = new Date(Date.now() + config.authChallengeTtlSeconds * 1000);
  await issueSetupChallenge(pool, issued.tokenHash, expiresAt);

  console.log("Owner setup capability (shown once):");
  console.log(issued.token);
  console.log(`Expires: ${expiresAt.toISOString()}`);
  console.log(`Open: ${config.webOrigins[0] ?? "the Ironside web URL"}/setup`);
} catch (error) {
  if (error instanceof OwnerAuthError && error.code === "setup_closed") {
    console.error("Owner setup is already complete. Use the owner-recovery command if access was lost.");
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}
