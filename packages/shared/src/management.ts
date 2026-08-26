import { z } from "zod";
import { environmentNameSchema } from "./environment.js";

// Owner-session contract for /api/v1/projects and the explicit
// /api/v1/projects/:projectId/* management tree. Project creation returns one
// initial machine credential exactly once; machine credentials never
// authenticate these management routes.

export const projectSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  /** Per-project override of the platform-default ingest rate limit (requests/minute); null = use the platform default. */
  rateLimitPerMinute: z.number().int().positive().nullable(),
  /** Per-project override of the platform-default ClickHouse retention window in days; null = use the platform default. */
  retentionDays: z.number().int().positive().nullable(),
  /** Seconds without trace/observation activity before automated consumers may process a trace; null = platform default. */
  traceQuietPeriodSeconds: z.number().int().positive().max(2_147_483_647).nullable().default(null)
});
export type Project = z.infer<typeof projectSchema>;

// PATCH /api/v1/projects/:projectId/quotas — a field is only changed when present
// in the request body; a field explicitly set to `null` clears that
// override back to the platform default. An absent field is left
// untouched (see packages/db/src/projects.ts's setProjectQuotas, which
// distinguishes "not provided" from "explicitly null" the same way).
export const updateProjectQuotasRequestSchema = z.object({
  rateLimitPerMinute: z.number().int().positive().nullable().optional(),
  retentionDays: z.number().int().positive().nullable().optional(),
  traceQuietPeriodSeconds: z.number().int().positive().max(2_147_483_647).nullable().optional()
});
export type UpdateProjectQuotasRequest = z.infer<typeof updateProjectQuotasRequestSchema>;

export const listProjectsResponseSchema = z.object({
  projects: z.array(projectSchema)
});
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>;

export const createProjectRequestSchema = z.object({
  name: z.string().min(1).max(200)
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const projectEnvironmentSchema = z.object({
  name: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  hidden: z.boolean()
});
export type ProjectEnvironment = z.infer<typeof projectEnvironmentSchema>;

export const listProjectEnvironmentsResponseSchema = z.object({
  environments: z.array(projectEnvironmentSchema),
  limit: z.number().int().positive(),
  overflowed: z.boolean(),
  overflowLastSeenAt: z.string().nullable(),
  lastRebuiltAt: z.string().nullable()
});
export type ListProjectEnvironmentsResponse = z.infer<
  typeof listProjectEnvironmentsResponseSchema
>;

export const updateProjectEnvironmentRequestSchema = z
  .object({
    environment: environmentNameSchema,
    hidden: z.boolean()
  })
  .strict();
export type UpdateProjectEnvironmentRequest = z.infer<
  typeof updateProjectEnvironmentRequestSchema
>;

export const machineCapabilityValues = ["ingest", "media:write", "traces:read", "scores:write"] as const;
export const machineCapabilitySchema = z.enum(machineCapabilityValues);
export type MachineCapability = z.infer<typeof machineCapabilitySchema>;

export const machineCredentialPresetSchema = z.enum(["ingest", "integration"]);
export type MachineCredentialPreset = z.infer<typeof machineCredentialPresetSchema>;

// Presets are creation-time bundles only. Authorization always checks the
// immutable capability snapshot persisted on the credential.
export const MACHINE_CREDENTIAL_PRESET_CAPABILITIES: Record<MachineCredentialPreset, readonly MachineCapability[]> = {
  ingest: ["ingest", "media:write"],
  integration: ["traces:read", "scores:write"]
};

export const credentialActorSchema = z.object({
  principalId: z.string().nullable(),
  username: z.string()
});
export type CredentialActor = z.infer<typeof credentialActorSchema>;

// A credential's plaintext token is only ever present in the CREATE response.
// Every list response omits it because only a SHA-256 hash is persisted.
export const machineCredentialSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  tokenPrefix: z.string(),
  preset: machineCredentialPresetSchema,
  capabilities: z.array(machineCapabilitySchema),
  expiresAt: z.string().nullable(),
  createdBy: credentialActorSchema.nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedBy: credentialActorSchema.nullable()
});
export type MachineCredentialSummary = z.infer<typeof machineCredentialSchema>;

export const createdMachineCredentialSchema = machineCredentialSchema.extend({
  token: z.string()
});
export type CreatedMachineCredential = z.infer<typeof createdMachineCredentialSchema>;

export const createdProjectWithCredentialSchema = z.object({
  project: projectSchema,
  initialCredential: createdMachineCredentialSchema
});
export type CreatedProjectWithCredential = z.infer<typeof createdProjectWithCredentialSchema>;

export const listMachineCredentialsResponseSchema = z.object({
  credentials: z.array(machineCredentialSchema)
});
export type ListMachineCredentialsResponse = z.infer<typeof listMachineCredentialsResponseSchema>;

export const createMachineCredentialRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    preset: machineCredentialPresetSchema,
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional()
  })
  .strict();
export type CreateMachineCredentialRequest = z.infer<typeof createMachineCredentialRequestSchema>;

// Contract for the project-explicit exports, OTLP-forward, and webhook routes —
// day-2 CRUD for the M6 destinations the worker scheduler (M6-05) now runs
// automatically. All three share the same TraceFilter shape (from/to/
// userId/sessionId/tags/metadataKey/metadataValue, all optional) used
// elsewhere for trace queries/exports. Environment is deliberately absent:
// #66 makes it a discovery/UI trace filter, never destination policy.

export const traceFilterSchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadataKey: z.string().optional(),
  metadataValue: z.string().optional()
});
export type TraceFilterRequest = z.infer<typeof traceFilterSchema>;

// Every create/update route accepts pollIntervalSeconds as an optional
// override of the per-subsystem DB default — capped at 30 days so a typo can't accidentally
// starve a destination of any scheduling for a near-eternity.
const pollIntervalSecondsSchema = z.number().int().min(1).max(30 * 24 * 60 * 60);

export const exportConfigSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  format: z.enum(["parquet", "jsonl"]),
  filter: traceFilterSchema,
  destinationBucket: z.string(),
  destinationPrefix: z.string(),
  destinationEndpoint: z.string(),
  destinationRegion: z.string(),
  destinationAccessKeyId: z.string(),
  enabled: z.boolean(),
  pollIntervalSeconds: z.number().int().positive(),
  nextRunAt: z.string(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.enum(["success", "error"]).nullable(),
  lastRunError: z.string().nullable(),
  lastRunRowCount: z.number().int().nonnegative().nullable()
});
export type ExportConfigResponse = z.infer<typeof exportConfigSchema>;

export const listExportConfigsResponseSchema = z.object({
  exports: z.array(exportConfigSchema)
});
export type ListExportConfigsResponse = z.infer<typeof listExportConfigsResponseSchema>;

export const createExportConfigRequestSchema = z.object({
  name: z.string().min(1).max(200),
  format: z.enum(["parquet", "jsonl"]).default("jsonl"),
  filter: traceFilterSchema.default({}),
  destinationBucket: z.string().min(1),
  destinationPrefix: z.string().default(""),
  destinationEndpoint: z.string().min(1),
  destinationRegion: z.string().default("us-east-1"),
  destinationAccessKeyId: z.string().min(1),
  /** Plaintext — encrypted server-side before it ever reaches Postgres; never echoed back in any response. */
  destinationSecretAccessKey: z.string().min(1),
  pollIntervalSeconds: pollIntervalSecondsSchema.optional()
});
export type CreateExportConfigRequest = z.infer<typeof createExportConfigRequestSchema>;

export const updateExportConfigRequestSchema = z.object({
  enabled: z.boolean().optional(),
  pollIntervalSeconds: pollIntervalSecondsSchema.optional()
});
export type UpdateExportConfigRequest = z.infer<typeof updateExportConfigRequestSchema>;

export const otlpForwardRuleSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  destinationUrl: z.string(),
  /** True if an auth header is configured — the header value itself is a write-only secret, never returned. */
  hasDestinationAuthHeader: z.boolean(),
  filter: traceFilterSchema,
  enabled: z.boolean(),
  pollIntervalSeconds: z.number().int().positive(),
  nextRunAt: z.string()
});
export type OtlpForwardRuleResponse = z.infer<typeof otlpForwardRuleSchema>;

export const listOtlpForwardRulesResponseSchema = z.object({
  forwards: z.array(otlpForwardRuleSchema)
});
export type ListOtlpForwardRulesResponse = z.infer<typeof listOtlpForwardRulesResponseSchema>;

export const createOtlpForwardRuleRequestSchema = z.object({
  name: z.string().min(1).max(200),
  destinationUrl: z.url(),
  /** Plaintext — encrypted server-side; never echoed back. Omit for a destination that needs no auth. */
  destinationAuthHeader: z.string().min(1).optional(),
  filter: traceFilterSchema.default({}),
  pollIntervalSeconds: pollIntervalSecondsSchema.optional()
});
export type CreateOtlpForwardRuleRequest = z.infer<typeof createOtlpForwardRuleRequestSchema>;

export const updateOtlpForwardRuleRequestSchema = z.object({
  enabled: z.boolean().optional(),
  pollIntervalSeconds: pollIntervalSecondsSchema.optional()
});
export type UpdateOtlpForwardRuleRequest = z.infer<typeof updateOtlpForwardRuleRequestSchema>;

export const webhookRuleSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  destinationUrl: z.string(),
  filter: traceFilterSchema,
  enabled: z.boolean(),
  pollIntervalSeconds: z.number().int().positive(),
  nextRunAt: z.string()
});
export type WebhookRuleResponse = z.infer<typeof webhookRuleSchema>;

export const listWebhookRulesResponseSchema = z.object({
  webhooks: z.array(webhookRuleSchema)
});
export type ListWebhookRulesResponse = z.infer<typeof listWebhookRulesResponseSchema>;

export const createWebhookRuleRequestSchema = z.object({
  name: z.string().min(1).max(200),
  destinationUrl: z.url(),
  filter: traceFilterSchema.default({}),
  pollIntervalSeconds: pollIntervalSecondsSchema.optional()
});
export type CreateWebhookRuleRequest = z.infer<typeof createWebhookRuleRequestSchema>;

export const updateWebhookRuleRequestSchema = z.object({
  enabled: z.boolean().optional(),
  pollIntervalSeconds: pollIntervalSecondsSchema.optional()
});
export type UpdateWebhookRuleRequest = z.infer<typeof updateWebhookRuleRequestSchema>;

// Contract for project-explicit import-source management — day-2 CRUD for the credentials +
// scheduling apps/worker's scheduler (M5-07) needs to run
// runLangfuseImport/runLangsmithImport automatically. Credentials are
// write-only, identically to exports/otlp-forwards/webhooks: encrypted
// server-side before ever reaching Postgres, never echoed back in any
// response. The two providers' credential shapes genuinely differ
// (LangFuse needs a public+secret key pair; LangSmith needs a single API
// key plus which "session" (project) UUIDs to pull from) — modeled as a
// discriminated union rather than one loose bag of optional fields, so a
// caller can't submit a LangFuse request with LangSmith fields (or vice
// versa) and have half of them silently ignored.

export const langfuseImportCredentialsSchema = z.object({
  provider: z.literal("langfuse"),
  publicKey: z.string().min(1),
  secretKey: z.string().min(1),
  baseUrl: z.url()
});
export type LangfuseImportCredentials = z.infer<typeof langfuseImportCredentialsSchema>;

export const langsmithImportCredentialsSchema = z.object({
  provider: z.literal("langsmith"),
  apiKey: z.string().min(1),
  baseUrl: z.url().optional(),
  /** LangSmith "session" (project) UUIDs to pull traces from. */
  sessionIds: z.array(z.string().min(1)).min(1)
});
export type LangsmithImportCredentials = z.infer<typeof langsmithImportCredentialsSchema>;

export const createImportSourceRequestSchema = z.discriminatedUnion("provider", [
  langfuseImportCredentialsSchema.extend({ pollIntervalSeconds: pollIntervalSecondsSchema.optional() }),
  langsmithImportCredentialsSchema.extend({ pollIntervalSeconds: pollIntervalSecondsSchema.optional() })
]);
export type CreateImportSourceRequest = z.infer<typeof createImportSourceRequestSchema>;

export const updateImportSourceRequestSchema = z.object({
  enabled: z.boolean().optional(),
  pollIntervalSeconds: pollIntervalSecondsSchema.optional()
});
export type UpdateImportSourceRequest = z.infer<typeof updateImportSourceRequestSchema>;

export const importSourceSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: z.enum(["langfuse", "langsmith"]),
  enabled: z.boolean(),
  pollIntervalSeconds: z.number().int().positive(),
  nextRunAt: z.string()
});
export type ImportSourceResponse = z.infer<typeof importSourceSchema>;

export const listImportSourcesResponseSchema = z.object({
  importSources: z.array(importSourceSchema)
});
export type ListImportSourcesResponse = z.infer<typeof listImportSourcesResponseSchema>;

// Contract for the project-explicit owner dead-letter view
// (M9-03): ingest events the worker could not map, previously visible
// only in worker logs. objectKey + eventId locate the full raw payload
// in object storage; the body itself is deliberately not duplicated here.

export const ingestFailureSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  batchId: z.string(),
  objectKey: z.string(),
  eventId: z.string(),
  source: z.string(),
  eventType: z.string(),
  error: z.string(),
  createdAt: z.string()
});
export type IngestFailureResponse = z.infer<typeof ingestFailureSchema>;

export const listIngestFailuresQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50)
});
export type ListIngestFailuresQuery = z.infer<typeof listIngestFailuresQuerySchema>;

export const listIngestFailuresResponseSchema = z.object({
  failures: z.array(ingestFailureSchema)
});
export type ListIngestFailuresResponse = z.infer<typeof listIngestFailuresResponseSchema>;
