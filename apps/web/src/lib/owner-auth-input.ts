export function extractOwnerCapability(value: string, kind: "setup" | "recovery"): string | null {
  return value.match(new RegExp(`\\bironside_${kind}_[A-Za-z0-9_-]{43}\\b`))?.[0] ?? null;
}

export function safeNextPath(raw: string | null): string | null {
  return raw?.startsWith("/") && !raw.startsWith("//") ? raw : null;
}
