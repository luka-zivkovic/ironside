import {
  getTraceRawAnchor,
  getTraceRawIndex
} from "@ironside/clickhouse";
import type { ClickHouseClient } from "@ironside/clickhouse";
import type { ObjectStorage } from "@ironside/storage";
import type { RawEventsTruncationReason, TraceRawEventsResponse } from "@ironside/shared";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";
import type { RawScanCaps, RawScanResult } from "../lib/raw-events.js";
import { RawLogUnavailableError, scanRawEvents } from "../lib/raw-events.js";

export interface RawEventsDeps {
  clickhouse: ClickHouseClient;
  storage: ObjectStorage;
}

const SCAN_CAPS: RawScanCaps = {
  /** Hard cap on raw objects fetched per lookup — bounds S3 GET count and latency. */
  maxScannedObjects: 500,
  /** Budget on bytes fetched from storage per lookup — bounds transfer cost even when the objects under the cap are large. */
  maxScannedBytes: 256 * 1024 * 1024,
  /** Cap on the accumulated event payload — mirrors the app-wide 10MB request body limit. */
  maxResponseBytes: 10 * 1024 * 1024
};

/**
 * The exact tags the importers stamp on every trace they write (see
 * apps/worker/src/importers/*-mapper.ts). Exact match on purpose: tags are
 * client-controlled, so a prefix test on "imported:" would let a user tag
 * like "imported:jira" masquerade as an importer marker and turn a real
 * raw log into a false 404.
 */
const IMPORTER_TAGS = new Set(["imported:langfuse", "imported:langsmith"]);

/**
 * GET /api/v1/projects/:projectId/traces/:id/raw-events — read-only replay slice (R-01): the
 * verbatim ingest envelope events that produced a trace, recovered from
 * the immutable raw log in object storage through the durable
 * trace→objectKey index written by the ingest worker. When any cap
 * (object count, byte budget, response size) stops the read early, the
 * response carries the partial results with `truncated: true` and a
 * `truncationReason` instead of failing.
 *
 * Known coverage gap: the LangFuse/LangSmith IMPORTERS write straight to
 * ClickHouse and never write raw batches, so imported traces have no raw
 * log — detected via the importer-stamped tags and answered with an
 * explanatory 404 instead of an empty scan.
 */
export function rawEventsRoutes(deps: RawEventsDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/traces/:id/raw-events", async (c) => {
    const projectId = c.get("projectId");
    const traceId = c.req.param("id");
    const startedAt = Date.now();

    // Structured usage log on every call, including error outcomes. The
    // API's logging convention is plain console; one JSON object per line
    // keeps it grep- and pipeline-friendly.
    const logUsage = (fields: Record<string, unknown>) => {
      console.log(
        JSON.stringify({
          msg: "raw_events_lookup",
          projectId,
          traceId,
          durationMs: Date.now() - startedAt,
          ...fields
        })
      );
    };

    const [anchor, rawIndex] = await Promise.all([
      getTraceRawAnchor(deps.clickhouse, projectId, traceId),
      getTraceRawIndex(deps.clickhouse, projectId, traceId, SCAN_CAPS.maxScannedObjects)
    ]);
    // A sticky retention marker is durable endpoint evidence even after the
    // query-visible trace row itself has expired. Without either an anchor or
    // that marker, the trace identity is genuinely unknown to this read path.
    if (!anchor && !rawIndex.retentionExpired) {
      logUsage({ outcome: "trace_not_found" });
      return c.json({ error: "trace not found" }, 404);
    }

    // Importers tag every trace they write and insert straight to
    // ClickHouse without a raw batch — scanning would only burn S3
    // requests to find nothing.
    if (
      rawIndex.objectKeys.length === 0 &&
      !rawIndex.hasPendingRefs &&
      !rawIndex.retentionExpired &&
      anchor?.tags.some((tag) => IMPORTER_TAGS.has(tag))
    ) {
      logUsage({ outcome: "imported_no_raw_log" });
      return c.json(
        {
          error: "no_raw_log",
          reason: "trace was imported; importers do not write the raw event log"
        },
        404
      );
    }

    let scan: RawScanResult;
    try {
      scan = await scanRawEvents(
        deps.storage,
        traceId,
        SCAN_CAPS,
        rawIndex.objectKeys
      );
    } catch (error) {
      // A genuine storage failure (not a missing/unparsable object — those
      // are skipped inside the scan) must surface as an upstream error:
      // returning 404/200 here would be indistinguishable from "no raw
      // log", sending the caller down the wrong path during an S3 outage.
      if (error instanceof RawLogUnavailableError) {
        logUsage({ outcome: "storage_error", objectKey: error.objectKey });
        return c.json(
          {
            error: "raw_log_unavailable",
            message: "object storage failed while scanning the raw event log; retry later"
          },
          502
        );
      }
      throw error;
    }

    const truncationReason: RawEventsTruncationReason | undefined =
      scan.truncationReason ??
      (rawIndex.hasPendingRefs
        ? "raw_index_pending"
        : rawIndex.retentionExpired
          ? "retention_expired"
          : undefined);

    // Zero raw events from a COMPLETE scan with no durable retention marker:
    // the trace arrived through an unknown path or its objects disappeared
    // outside Ironside's retention contract. That remains an explanatory
    // 404. Deliberate retention is different: its sticky marker produces an
    // honest empty 200 with `retentionExpired: true`. A capped/truncated scan
    // proves nothing about absence and also falls through to the partial 200.
    if (scan.events.length === 0 && truncationReason === undefined) {
      logUsage({ outcome: "no_raw_log", scannedObjects: scan.scannedObjects });
      return c.json(
        {
          error: "no_raw_log",
          reason: "no raw batch containing this trace was found; it was likely imported (importers do not write the raw event log) or its raw objects have been deleted"
        },
        404
      );
    }

    logUsage({
      outcome: "ok",
      scannedObjects: scan.scannedObjects,
      matchedEvents: scan.events.length,
      retentionExpired: rawIndex.retentionExpired,
      ...(truncationReason && { truncationReason })
    });
    const response: TraceRawEventsResponse = {
      traceId,
      events: scan.events,
      scannedObjects: scan.scannedObjects,
      truncated: truncationReason !== undefined,
      retentionExpired: rawIndex.retentionExpired,
      ...(truncationReason && { truncationReason })
    };
    return c.json(response, 200);
  });

  return app;
}
