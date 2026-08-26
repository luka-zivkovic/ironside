import type { ExportFilter } from "@ironside/db";
import type { TraceFilterRequest } from "@ironside/shared";

// exactOptionalPropertyTypes (tsconfig.base.json) rejects assigning a
// Zod-parsed `.optional()` field (typed `T | undefined`) directly to a
// target property typed `T?` — the target requires the key to be
// genuinely ABSENT when unset, not present-with-value-undefined. Zod
// itself omits absent keys at runtime, but its inferred TS type doesn't
// encode that, so the object literal has to be rebuilt with conditional
// spreads to satisfy the type checker. Shared here since exports.ts,
// forwards.ts, and webhooks.ts all hit the identical shape twice each
// (the create request's `filter`, and the create/update request's
// `pollIntervalSeconds`/`enabled` pass-through) — same pattern already
// established in projects.ts's PATCH /quotas route.

export function toFilter(filter: TraceFilterRequest): ExportFilter {
  return {
    ...(filter.from !== undefined && { from: filter.from }),
    ...(filter.to !== undefined && { to: filter.to }),
    ...(filter.userId !== undefined && { userId: filter.userId }),
    ...(filter.sessionId !== undefined && { sessionId: filter.sessionId }),
    ...(filter.tags !== undefined && { tags: filter.tags }),
    ...(filter.metadataKey !== undefined && { metadataKey: filter.metadataKey }),
    ...(filter.metadataValue !== undefined && { metadataValue: filter.metadataValue })
  };
}

export interface EnabledPollIntervalUpdate {
  enabled?: boolean;
  pollIntervalSeconds?: number;
}

export function toEnabledPollIntervalUpdate(input: {
  enabled?: boolean | undefined;
  pollIntervalSeconds?: number | undefined;
}): EnabledPollIntervalUpdate {
  return {
    ...(input.enabled !== undefined && { enabled: input.enabled }),
    ...(input.pollIntervalSeconds !== undefined && { pollIntervalSeconds: input.pollIntervalSeconds })
  };
}
