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
  "0001_baseline": "ae18071157ef24c3102aba2d89ae34df489f189f12ede77824c02d88ff8c49bc"
};

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const files = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();

function read(file: string): string {
  return readFileSync(`${migrationsDir}/${file}`, "utf8");
}

/** Same comment stripping and `;` splitting as runMigrations. */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim().replace(/\s+/g, " ").toLowerCase())
    .filter((statement) => statement.length > 0);
}

/**
 * ClickHouse DDL is not transactional and api and worker both migrate on
 * boot, so a migration can run twice or resume after a partial failure.
 * Returns why a statement is unsafe to repeat, or null when it is safe.
 */
function repeatHazard(statement: string): string | null {
  if (/^create /.test(statement) && !statement.includes(" if not exists ")) {
    return "create needs `if not exists`";
  }
  if (/^drop /.test(statement) && !statement.includes(" if exists ")) {
    return "drop needs `if exists`";
  }
  if (/^alter table /.test(statement)) {
    for (const clause of statement.split(",")) {
      if (/\badd (column|index|projection|constraint)\b/.test(clause) && !clause.includes(" if not exists ")) {
        return "add needs `if not exists`";
      }
      if (/\bdrop (column|index|projection|constraint)\b/.test(clause) && !clause.includes(" if exists ")) {
        return "drop needs `if exists`";
      }
      if (/\brename column\b/.test(clause) && !clause.includes(" if exists ")) {
        return "rename column needs `if exists`";
      }
    }
  }
  if (/^(insert|rename|exchange) /.test(statement)) {
    return "insert/rename/exchange cannot be repeated safely; do data backfills in code";
  }
  return null;
}

describe("ClickHouse migration files", () => {
  it("are named NNNN_snake_case.sql and numbered 0001, 0002, ... without gaps", () => {
    files.forEach((file, index) => {
      expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(file.slice(0, 4)).toBe(String(index + 1).padStart(4, "0"));
    });
  });

  it("keep every released migration byte-identical to what installed databases applied", () => {
    for (const [id, released] of Object.entries(RELEASED_CHECKSUMS)) {
      expect(files, `released migration ${id} is missing`).toContain(`${id}.sql`);
      const actual = createHash("sha256").update(read(`${id}.sql`)).digest("hex");
      expect(actual, `released migration ${id} was edited; add a new migration instead`).toBe(released);
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

  it("only contain statements that are safe to run twice", () => {
    const hazards = files.flatMap((file) =>
      statements(read(file))
        .map((statement) => ({ statement, hazard: repeatHazard(statement) }))
        .filter(({ hazard }) => hazard !== null)
        .map(({ statement, hazard }) => `${file}: ${hazard}: ${statement.slice(0, 80)}`)
    );
    expect(hazards).toEqual([]);
  });

  it("flags statements that cannot be repeated", () => {
    expect(repeatHazard("create table traces (id string) engine = memory")).toMatch(/if not exists/);
    expect(repeatHazard("alter table traces add column x string")).toMatch(/if not exists/);
    expect(repeatHazard("alter table traces add column if not exists x string, drop column y")).toMatch(
      /if exists/
    );
    expect(repeatHazard("insert into traces select * from traces_old")).toMatch(/backfills/);
    expect(repeatHazard("alter table traces add column if not exists x string")).toBeNull();
    expect(repeatHazard("alter table traces modify column x nullable(string)")).toBeNull();
  });
});
