import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every migration shipped in a release, with the checksum installed databases
// recorded. runMigrations refuses to start when a file no longer matches, so
// a released migration is never edited: add a new NNNN_*.sql file instead.
// When cutting a release, add each new file here (docs/schema-migrations.md).
const RELEASED_CHECKSUMS: Record<string, string> = {
  // v0.3.0
  "0001_baseline": "ca0fe03d88db6c911b1c682303738c090b6351c192845b453781b7321d2b588b"
};

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const files = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();

function checksum(file: string): string {
  return createHash("sha256")
    .update(readFileSync(`${migrationsDir}/${file}`, "utf8"))
    .digest("hex");
}

describe("Postgres migration files", () => {
  it("are named NNNN_snake_case.sql and numbered 0001, 0002, ... without gaps", () => {
    files.forEach((file, index) => {
      expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(file.slice(0, 4)).toBe(String(index + 1).padStart(4, "0"));
    });
  });

  it("keep every released migration byte-identical to what installed databases applied", () => {
    for (const [id, released] of Object.entries(RELEASED_CHECKSUMS)) {
      expect(files, `released migration ${id} is missing`).toContain(`${id}.sql`);
      expect(checksum(`${id}.sql`), `released migration ${id} was edited; add a new migration instead`).toBe(
        released
      );
    }
  });

  it("number unreleased migrations after every released one", () => {
    const released = new Set(Object.keys(RELEASED_CHECKSUMS));
    const firstUnreleased = files.findIndex((file) => !released.has(file.replace(/\.sql$/, "")));
    if (firstUnreleased === -1) return;
    for (const file of files.slice(firstUnreleased)) {
      expect(released.has(file.replace(/\.sql$/, "")), `${file} is released but ordered after an unreleased migration`).toBe(
        false
      );
    }
  });
});
