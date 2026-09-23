import type { TraceRow } from "@ironside/clickhouse";
import type { ExportFilter } from "@ironside/db";

/** The destination filter applied in process; same semantics as buildTraceConditions in @ironside/clickhouse. */
export function matchesExportFilter(trace: TraceRow, filter: ExportFilter): boolean {
  const timestamp = Date.parse(trace.timestamp);
  if (filter.from && timestamp < Date.parse(filter.from)) return false;
  if (filter.to && timestamp > Date.parse(filter.to)) return false;
  if (filter.userId && trace.user_id !== filter.userId) return false;
  if (filter.sessionId && trace.session_id !== filter.sessionId) return false;
  if (filter.tags && filter.tags.length > 0 && !filter.tags.every((tag) => trace.tags.includes(tag))) {
    return false;
  }
  if (filter.metadataKey && filter.metadataValue && trace.metadata[filter.metadataKey] !== filter.metadataValue) {
    return false;
  }
  return true;
}
