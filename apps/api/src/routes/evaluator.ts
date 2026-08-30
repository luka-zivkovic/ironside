import { createHash } from "node:crypto";
import type { ClickHouseClient, VersionedTraceDetailRow } from "@ironside/clickhouse";
import {
  getVersionedTrace,
  getVersionedTraceSummaries,
  hasPendingTraceRawRefs,
  listPendingTraceRawRefIds,
  listObservationsForTrace,
  listSettledTraceVersions
} from "@ironside/clickhouse";
import {
  claimEvaluatorScoreReceipt,
  EvaluatorScoreIdempotencyConflictError,
  getEvaluatorTracePublications,
  getProject,
  listPendingEvaluatorImportTraceIds,
  listEvaluatorTraceActivities,
  markEvaluatorScoreReceiptStaged
} from "@ironside/db";
import { buildObservationTree, safeJsonParse } from "@ironside/mappers";
import {
  EVALUATOR_PROTOCOL_VERSION,
  INGEST_SCHEMA_VERSION,
  evaluatorScoreInputSchema,
  traceSettledBefore,
  type EvaluatorContextResponse,
  type EvaluatorTraceFeedResponse,
  type EvaluatorTraceResponse,
  type IngestBatch,
  type IngestEvent,
  type QueueMessage
} from "@ironside/shared";
import type { ObjectStorage } from "@ironside/storage";
import type { Queue } from "bullmq";
import { Hono } from "hono";
import type { Pool } from "pg";
import { ulid } from "ulid";
import { z } from "zod";
import {
  decodeEvaluatorCursor,
  encodeEvaluatorCursor,
  initialLiveEvaluatorCursor,
  type EvaluatorCursor
} from "../lib/evaluator-cursor.js";
import { persistAndEnqueueIngestBatch } from "../lib/persist-ingest-batch.js";
import type { AuthEnv } from "../middleware/auth.js";

interface EvaluatorReadDeps {
  clickhouse: ClickHouseClient;
  pool: Pool;
  defaultTraceQuietPeriodSeconds: number;
}

interface EvaluatorScoreDeps {
  pool: Pool;
  storage: ObjectStorage;
  queue: Queue<QueueMessage>;
}

const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

const detailQuerySchema = z.object({
  version: z.iso.datetime({ offset: true })
});

async function projectSettlement(
  deps: EvaluatorReadDeps,
  projectId: string
): Promise<{ project: NonNullable<Awaited<ReturnType<typeof getProject>>>; quietPeriodSeconds: number; settledBefore: string }> {
  const project = await getProject(deps.pool, projectId);
  if (!project) throw new Error(`machine credential resolved missing project: ${projectId}`);
  const quietPeriodSeconds =
    project.traceQuietPeriodSeconds ?? deps.defaultTraceQuietPeriodSeconds;
  return {
    project,
    quietPeriodSeconds,
    settledBefore: traceSettledBefore(quietPeriodSeconds)
  };
}

function traceSummary(trace: {
  id: string;
  trace_version: string;
  timestamp: string;
  name: string | null;
  user_id: string | null;
  session_id: string | null;
  environment: string | null;
  tags: string[];
  metadata: Record<string, string>;
}, traceVersion = trace.trace_version) {
  return {
    traceId: trace.id,
    traceVersion,
    timestamp: trace.timestamp,
    name: trace.name,
    userId: trace.user_id,
    sessionId: trace.session_id,
    environment: trace.environment,
    tags: trace.tags,
    metadata: trace.metadata
  };
}

function traceDetail(
  trace: VersionedTraceDetailRow,
  observations: Awaited<ReturnType<typeof listObservationsForTrace>>,
  traceVersion = trace.trace_version
): EvaluatorTraceResponse {
  return {
    id: trace.id,
    traceVersion,
    timestamp: trace.timestamp,
    name: trace.name,
    userId: trace.user_id,
    sessionId: trace.session_id,
    environment: trace.environment,
    release: trace.release,
    version: trace.version,
    tags: trace.tags,
    metadata: trace.metadata,
    input: safeJsonParse(trace.input),
    output: safeJsonParse(trace.output),
    observations: buildObservationTree(observations)
  };
}

export function evaluatorReadRoutes(deps: EvaluatorReadDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/evaluator/context", async (c) => {
    const projectId = c.get("projectId");
    const { project, quietPeriodSeconds } = await projectSettlement(deps, projectId);
    const response: EvaluatorContextResponse = {
      protocolVersion: EVALUATOR_PROTOCOL_VERSION,
      project: { id: project.id, name: project.name },
      capabilities: c.get("capabilities"),
      settlement: { kind: "quiet_period", quietPeriodSeconds }
    };
    return c.json(response, 200);
  });

  app.get("/evaluator/traces", async (c) => {
    const parsed = listQuerySchema.safeParse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit")
    });
    if (!parsed.success) return c.json({ error: "invalid evaluator trace query", issues: parsed.error.issues }, 400);

    const suppliedCursor = parsed.data.cursor
      ? decodeEvaluatorCursor(parsed.data.cursor)
      : null;
    if (parsed.data.cursor && !suppliedCursor) return c.json({ error: "invalid evaluator cursor" }, 400);

    const projectId = c.get("projectId");
    const { settledBefore, quietPeriodSeconds } = await projectSettlement(deps, projectId);
    const cursor: EvaluatorCursor = suppliedCursor ?? {
      v: 1,
      kind: "bootstrap",
      // Keep reconciling until everything that existed when this consumer
      // connected has had time to settle. This closes the small upgrade gap
      // for traces written before evaluator_trace_feed existed but still
      // inside their quiet period on the first request.
      through: new Date(new Date(settledBefore).getTime() + quietPeriodSeconds * 1000).toISOString(),
      afterVersion: "1970-01-01T00:00:00.000Z",
      afterTraceId: ""
    };

    if (cursor.kind === "bootstrap") {
      const windowTo = settledBefore < cursor.through ? settledBefore : cursor.through;
      const rows = await listSettledTraceVersions(deps.clickhouse, {
        projectId,
        settledBefore: windowTo,
        limit: parsed.data.limit + 1,
        ...(cursor.afterTraceId
          ? { cursor: { traceVersion: cursor.afterVersion, traceId: cursor.afterTraceId } }
          : {})
      });
      const hasMore = rows.length > parsed.data.limit;
      const candidatePage = hasMore ? rows.slice(0, parsed.data.limit) : rows;
      const candidateTraceIds = candidatePage.map((row) => row.id);
      const [pendingRawTraceIds, pendingImportTraceIds] = await Promise.all([
        listPendingTraceRawRefIds(deps.clickhouse, projectId, candidateTraceIds),
        listPendingEvaluatorImportTraceIds(deps.pool, projectId, candidateTraceIds)
      ]);
      const pendingTraceIds = new Set([...pendingRawTraceIds, ...pendingImportTraceIds]);
      const firstPendingIndex = candidatePage.findIndex((row) => pendingTraceIds.has(row.id));
      const page = firstPendingIndex === -1
        ? candidatePage
        : candidatePage.slice(0, firstPendingIndex);
      const blocked = firstPendingIndex !== -1;
      const publications = await getEvaluatorTracePublications(
        deps.pool,
        projectId,
        page.map((row) => row.id)
      );
      const last = page.at(-1);
      const nextCursor = (hasMore || blocked) && last
        ? encodeEvaluatorCursor({
            v: 1,
            kind: "bootstrap",
            through: cursor.through,
            afterVersion: last.trace_version,
            afterTraceId: last.id
          })
        : blocked
          ? encodeEvaluatorCursor(cursor)
          : windowTo < cursor.through
          ? encodeEvaluatorCursor({
              v: 1,
              kind: "bootstrap",
              through: cursor.through,
              afterVersion: last?.trace_version ?? windowTo,
              afterTraceId: last?.id ?? "\uffff"
            })
          : encodeEvaluatorCursor(initialLiveEvaluatorCursor());
      const response: EvaluatorTraceFeedResponse = {
        protocolVersion: EVALUATOR_PROTOCOL_VERSION,
        traces: page.map((row) => {
          const publication = publications.get(row.id);
          return traceSummary(
            row,
            publication?.sourceActivityAt === row.trace_version
              ? publication.traceVersion
              : row.trace_version
          );
        }),
        nextCursor,
        // A pending first row returns an unchanged cursor and false so a
        // consumer yields instead of spinning. A safe prefix advertises the
        // blocked remainder and the next request stops on that first row.
        hasMore: blocked ? page.length > 0 : hasMore
      };
      return c.json(response, 200);
    }

    const activities = await listEvaluatorTraceActivities(deps.pool, {
      projectId,
      ...(cursor.publishedAt && cursor.traceId
        ? { cursor: { publishedAt: cursor.publishedAt, traceId: cursor.traceId } }
        : {}),
      limit: parsed.data.limit + 1
    });
    const traces: EvaluatorTraceFeedResponse["traces"] = [];
    let consumed = 0;
    let next: EvaluatorCursor = cursor;
    let blocked = false;
    const activityTraceIds = activities.map((activity) => activity.traceId);
    const [currentByTraceId, pendingRawTraceIds, pendingImportTraceIds] = await Promise.all([
      getVersionedTraceSummaries(deps.clickhouse, projectId, activityTraceIds),
      listPendingTraceRawRefIds(deps.clickhouse, projectId, activityTraceIds),
      listPendingEvaluatorImportTraceIds(deps.pool, projectId, activityTraceIds)
    ]);
    const pendingTraceIds = new Set([...pendingRawTraceIds, ...pendingImportTraceIds]);

    for (const activity of activities) {
      if (activity.sourceActivityAt > settledBefore) {
        blocked = true;
        break;
      }
      if (pendingTraceIds.has(activity.traceId)) {
        // Publication happens before the worker clears the durable pending
        // reference. Keep the cursor before this item so it becomes visible
        // after materialization completes instead of being skipped on 409.
        blocked = true;
        break;
      }
      const current = currentByTraceId.get(activity.traceId);
      if (!current) {
        // Retention may remove the trace after its feed row was published.
        // Advancing past the orphan prevents one deleted trace from blocking
        // every later activity for this consumer.
        consumed += 1;
        next = { v: 1, kind: "live", publishedAt: activity.publishedAt, traceId: activity.traceId };
        continue;
      }
      if (current.trace_version !== activity.sourceActivityAt) {
        if (current.trace_version < activity.sourceActivityAt) {
          // Row-level retention can remove the row that supplied the prior
          // maximum activity while leaving an older trace snapshot behind.
          // That regression cannot become visible again, so advance past the
          // stale publication exactly like a fully retained-away trace.
          consumed += 1;
          next = { v: 1, kind: "live", publishedAt: activity.publishedAt, traceId: activity.traceId };
          continue;
        }
        // A strictly newer ClickHouse snapshot became visible just before
        // the worker advanced the durable feed row. Do not pass it; the
        // idempotent retry/upsert will move this trace forward.
        blocked = true;
        break;
      }
      traces.push(traceSummary(current, activity.traceVersion));
      consumed += 1;
      next = { v: 1, kind: "live", publishedAt: activity.publishedAt, traceId: activity.traceId };
      if (traces.length >= parsed.data.limit) break;
    }

    // If every fetched row was an orphan, consumed === activities.length. A
    // full limit+1 window is still evidence that another page may exist.
    const hasMore = !blocked && (
      activities.length > consumed || activities.length === parsed.data.limit + 1
    );
    const response: EvaluatorTraceFeedResponse = {
      protocolVersion: EVALUATOR_PROTOCOL_VERSION,
      traces,
      nextCursor: encodeEvaluatorCursor(next),
      hasMore
    };
    return c.json(response, 200);
  });

  app.get("/evaluator/traces/:id", async (c) => {
    const parsed = detailQuerySchema.safeParse({ version: c.req.query("version") });
    if (!parsed.success) return c.json({ error: "a valid trace version is required", issues: parsed.error.issues }, 400);

    const projectId = c.get("projectId");
    const traceId = c.req.param("id");
    const { settledBefore } = await projectSettlement(deps, projectId);
    const publicationBefore = (await getEvaluatorTracePublications(
      deps.pool,
      projectId,
      [traceId]
    )).get(traceId);
    const [hasPendingRawRef, pendingImportTraceIds] = await Promise.all([
      hasPendingTraceRawRefs(deps.clickhouse, projectId, traceId),
      listPendingEvaluatorImportTraceIds(deps.pool, projectId, [traceId])
    ]);
    if (hasPendingRawRef || pendingImportTraceIds.has(traceId)) {
      return c.json({ error: "trace is still materializing", code: "trace_version_changed" }, 409);
    }
    const before = await getVersionedTrace(deps.clickhouse, projectId, traceId);
    if (!before) return c.json({ error: "trace not found" }, 404);
    const expectedVersion = publicationBefore?.traceVersion ?? before.trace_version;
    const expectedSourceActivity = publicationBefore?.sourceActivityAt ?? before.trace_version;
    if (
      expectedVersion !== parsed.data.version ||
      before.trace_version !== expectedSourceActivity ||
      before.trace_version > settledBefore
    ) {
      return c.json({ error: "trace version changed or is no longer settled", code: "trace_version_changed" }, 409);
    }

    const observations = await listObservationsForTrace(deps.clickhouse, projectId, traceId);
    const after = await getVersionedTrace(deps.clickhouse, projectId, traceId);
    const pendingAfter = await hasPendingTraceRawRefs(deps.clickhouse, projectId, traceId);
    const pendingImportAfter = (
      await listPendingEvaluatorImportTraceIds(deps.pool, projectId, [traceId])
    ).has(traceId);
    // This read must be ordered after pendingAfter. If the worker cleared the
    // pending marker, its publication commit must be visible here; running
    // these reads concurrently would not form a valid seqlock.
    const publicationAfterMap = await getEvaluatorTracePublications(
      deps.pool,
      projectId,
      [traceId]
    );
    const publicationAfter = publicationAfterMap.get(traceId);
    if (
      pendingAfter ||
      pendingImportAfter ||
      !after ||
      after.trace_version !== before.trace_version ||
      publicationAfter?.traceVersion !== publicationBefore?.traceVersion ||
      publicationAfter?.sourceActivityAt !== publicationBefore?.sourceActivityAt
    ) {
      return c.json({ error: "trace version changed while reading", code: "trace_version_changed" }, 409);
    }
    return c.json(traceDetail(before, observations, expectedVersion), 200);
  });

  return app;
}

function stringifyMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> {
  if (!metadata) return {};
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value)
    ])
  );
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => [key, canonicalizeJson(entry)])
    );
  }
  return value;
}

export function evaluatorScoreRoutes(deps: EvaluatorScoreDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.post("/evaluator/scores", async (c) => {
    const parsed = evaluatorScoreInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid evaluator score", issues: parsed.error.issues }, 400);
    const score = parsed.data;
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify(canonicalizeJson(score)))
      .digest("hex");
    const projectId = c.get("projectId");
    let receipt: { timestamp: string; batchId: string; staged: boolean };
    try {
      receipt = await claimEvaluatorScoreReceipt(deps.pool, {
        projectId,
        scoreId: score.id,
        traceId: score.traceId,
        requestFingerprint,
        candidateBatchId: ulid()
      });
    } catch (error) {
      if (!(error instanceof EvaluatorScoreIdempotencyConflictError)) throw error;
      return c.json({
        error: error.message,
        code: "score_idempotency_conflict"
      }, 409);
    }
    if (receipt.staged) return c.json({ id: score.id }, 200);
    const body = {
      id: score.id,
      traceId: score.traceId,
      name: score.name,
      dataType: "numeric",
      value: score.value,
      source: "eval",
      comment: score.comment ? `${score.assessmentLabel}: ${score.comment}` : score.assessmentLabel,
      timestamp: receipt.timestamp,
      metadata: {
        ...stringifyMetadata(score.metadata),
        assessmentLabel: score.assessmentLabel,
        evaluatorProvider: score.evaluator.provider,
        evaluatorVersionId: score.evaluator.versionId,
        criterionKey: score.evaluator.criterionKey
      }
    };
    const event: IngestEvent = {
      id: `event_${receipt.batchId}`,
      type: "score-upsert",
      source: "native",
      schemaVersion: INGEST_SCHEMA_VERSION,
      idempotencyKey: requestFingerprint,
      body
    };
    const batch: IngestBatch = {
      batchId: receipt.batchId,
      projectId,
      receivedAt: receipt.timestamp,
      events: [event]
    };
    await persistAndEnqueueIngestBatch(deps, batch, {
      afterIntentPersisted: async () => {
        await markEvaluatorScoreReceiptStaged(deps.pool, {
          projectId,
          scoreId: score.id,
          batchId: receipt.batchId
        });
      }
    });
    return c.json({ id: score.id }, 200);
  });
  return app;
}
