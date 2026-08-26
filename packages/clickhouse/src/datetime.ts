// ClickHouse DateTime64 columns want "YYYY-MM-DD HH:MM:SS.mmm" (no `T`/`Z`)
// interpreted as UTC (server default timezone is UTC in
// docker-compose.yml/CI). Input ISO strings may carry a non-UTC offset, so
// this must convert to UTC via Date, not just strip the offset suffix —
// stripping would silently shift the instant for any non-UTC client.
export function toClickHouseDateTime(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 23);
}

// Inverse of toClickHouseDateTime: converts a value read back from
// ClickHouse ("YYYY-MM-DD HH:MM:SS.mmm", implicitly UTC) to a real ISO-8601
// string. This MUST be used at every read boundary (query results, cursors
// built from them) — space-separated datetimes are parsed as *local* time by
// `new Date(...)` (unlike `T`-separated ISO strings), so re-running
// toClickHouseDateTime on an un-normalized CH-format string silently shifts
// it by the host's UTC offset. This bit a keyset-pagination cursor: the
// cursor carried CH's raw format, got reinterpreted as local time on the
// next page's query, and shifted the boundary enough to drop all remaining
// rows.
export function fromClickHouseDateTime(chDateTime: string): string {
  return `${chDateTime.replace(" ", "T")}Z`;
}
