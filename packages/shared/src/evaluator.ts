import { z } from "zod";
import { identifierSchema } from "./domain.js";
import { machineCapabilitySchema } from "./management.js";
import { traceTreeResponseSchema } from "./query.js";

export const EVALUATOR_PROTOCOL_VERSION = "ironside/evaluator/v1" as const;

export const evaluatorContextResponseSchema = z.object({
  protocolVersion: z.literal(EVALUATOR_PROTOCOL_VERSION),
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1)
  }),
  capabilities: z.array(machineCapabilitySchema),
  settlement: z.object({
    kind: z.literal("quiet_period"),
    quietPeriodSeconds: z.number().int().nonnegative()
  })
});
export type EvaluatorContextResponse = z.infer<typeof evaluatorContextResponseSchema>;

export const evaluatorTraceSummarySchema = z.object({
  traceId: identifierSchema,
  traceVersion: z.iso.datetime({ offset: true }),
  timestamp: z.iso.datetime({ offset: true }),
  name: z.string().nullable(),
  userId: z.string().nullable(),
  sessionId: z.string().nullable(),
  environment: z.string().nullable(),
  tags: z.array(z.string()),
  metadata: z.record(z.string(), z.string())
});
export type EvaluatorTraceSummary = z.infer<typeof evaluatorTraceSummarySchema>;

export const evaluatorTraceFeedResponseSchema = z.object({
  protocolVersion: z.literal(EVALUATOR_PROTOCOL_VERSION),
  traces: z.array(evaluatorTraceSummarySchema),
  nextCursor: z.string().min(1),
  hasMore: z.boolean()
});
export type EvaluatorTraceFeedResponse = z.infer<typeof evaluatorTraceFeedResponseSchema>;

export const evaluatorTraceResponseSchema = traceTreeResponseSchema.extend({
  traceVersion: z.iso.datetime({ offset: true })
});
export type EvaluatorTraceResponse = z.infer<typeof evaluatorTraceResponseSchema>;

export const evaluatorScoreInputSchema = z.object({
  id: identifierSchema,
  traceId: identifierSchema,
  name: z.string().min(1),
  value: z.number(),
  assessmentLabel: z.string().min(1).max(100),
  comment: z.string().max(20_000).optional(),
  evaluator: z.object({
    provider: z.string().min(1).max(100),
    versionId: z.string().min(1),
    criterionKey: z.string().min(1).max(240)
  }),
  metadata: z.record(z.string(), z.unknown()).optional()
});
export type EvaluatorScoreInput = z.infer<typeof evaluatorScoreInputSchema>;

export const evaluatorScoreResponseSchema = z.object({ id: z.string().min(1) });
export type EvaluatorScoreResponse = z.infer<typeof evaluatorScoreResponseSchema>;
