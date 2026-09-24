import { z } from "zod";
import { MAX_EVENTS_PER_BATCH, ingestEventTypeSchema } from "./envelope.js";

// Client-facing contract for POST /api/v1/ingest. The server fills in an
// omitted event id (a ULID) and stamps source/projectId itself — clients never
// control those. An idempotencyKey is stored as sent; without one, the event
// id is stored in its place.

export const ingestRequestEventSchema = z.object({
  id: z.string().min(1).optional(),
  type: ingestEventTypeSchema,
  idempotencyKey: z.string().min(1).optional(),
  body: z.unknown()
});
export type IngestRequestEvent = z.infer<typeof ingestRequestEventSchema>;

export const ingestRequestSchema = z.object({
  events: z.array(ingestRequestEventSchema).min(1).max(MAX_EVENTS_PER_BATCH)
});
export type IngestRequest = z.infer<typeof ingestRequestSchema>;

export const ingestResponseSchema = z.object({
  batchId: z.string(),
  received: z.number().int().nonnegative()
});
export type IngestResponse = z.infer<typeof ingestResponseSchema>;
