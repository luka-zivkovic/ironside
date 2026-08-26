import {
  aggregatesResponseSchema,
  createdMachineCredentialSchema,
  createdProjectWithCredentialSchema,
  listMachineCredentialsResponseSchema,
  listProjectEnvironmentsResponseSchema,
  projectEnvironmentSchema,
  listTracesResponseSchema,
  listProjectsResponseSchema,
  traceTreeResponseSchema,
  type AggregatesResponse,
  type CreatedMachineCredential,
  type CreatedProjectWithCredential,
  type ListMachineCredentialsResponse,
  type ListProjectEnvironmentsResponse,
  type ProjectEnvironment,
  type MachineCredentialPreset,
  type ListProjectsResponse,
  type ListTracesResponse,
  type TraceTreeResponse
} from "@ironside/shared/browser";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

/** Absolute API base for commands that run outside the browser, such as onboarding curl examples. */
export function getApiBaseUrl(): string {
  const base = API_BASE ? new URL(API_BASE, window.location.origin).toString() : window.location.origin;
  return base.replace(/\/$/, "");
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error) return error;
  }
  return fallback;
}

async function apiErrorFromResponse(response: Response, fallback: string): Promise<ApiError> {
  const payload = (await response.json().catch(() => null)) as unknown;
  return new ApiError(errorMessage(payload, `${fallback}: ${response.status}`), response.status, payload);
}

// Fires when the owner session is rejected so the app shell can preserve the
// requested deep link and return to the login screen.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, { ...init, credentials: "include" });
  if (response.status === 401) {
    onUnauthorized?.();
  }
  return response;
}

export interface ListTracesParams {
  from?: string;
  to?: string;
  userId?: string;
  sessionId?: string;
  environment?: string;
  tags?: string[];
  metadataKey?: string;
  metadataValue?: string;
  limit?: number;
  cursor?: string;
}

function buildQuery(params: ListTracesParams): string {
  const search = new URLSearchParams();
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.userId) search.set("userId", params.userId);
  if (params.sessionId) search.set("sessionId", params.sessionId);
  if (params.environment) search.set("environment", params.environment);
  if (params.metadataKey) search.set("metadataKey", params.metadataKey);
  if (params.metadataValue) search.set("metadataValue", params.metadataValue);
  if (params.limit) search.set("limit", String(params.limit));
  if (params.cursor) search.set("cursor", params.cursor);
  for (const tag of params.tags ?? []) search.append("tags", tag);
  return search.toString();
}

function projectPath(projectId: string, suffix = ""): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}${suffix}`;
}

export async function fetchTraces(projectId: string, params: ListTracesParams): Promise<ListTracesResponse> {
  const query = buildQuery(params);
  const response = await apiFetch(`${projectPath(projectId, "/traces")}${query ? `?${query}` : ""}`);
  if (!response.ok) throw await apiErrorFromResponse(response, "Failed to list traces");
  return listTracesResponseSchema.parse(await response.json());
}

export async function fetchTraceTree(projectId: string, traceId: string): Promise<TraceTreeResponse> {
  const response = await apiFetch(projectPath(projectId, `/traces/${encodeURIComponent(traceId)}`));
  if (!response.ok) throw await apiErrorFromResponse(response, "Failed to fetch trace");
  return traceTreeResponseSchema.parse(await response.json());
}

export async function fetchAggregates(
  projectId: string,
  params: Omit<ListTracesParams, "limit" | "cursor">
): Promise<AggregatesResponse> {
  const query = buildQuery(params);
  const response = await apiFetch(`${projectPath(projectId, "/traces/aggregates")}${query ? `?${query}` : ""}`);
  if (!response.ok) throw await apiErrorFromResponse(response, "Failed to fetch aggregates");
  return aggregatesResponseSchema.parse(await response.json());
}

export interface HealthReport {
  service: string;
  status: string;
  [key: string]: unknown;
}

// Unauthenticated API reachability check used before mounting the app shell.
export async function checkHealth(): Promise<HealthReport> {
  const response = await fetch(`${API_BASE}/health`);
  const body = (await response.json()) as HealthReport;
  return body;
}

export async function fetchProjects(): Promise<ListProjectsResponse> {
  const response = await apiFetch("/api/v1/projects");
  if (!response.ok) throw await apiErrorFromResponse(response, "Failed to list projects");
  return listProjectsResponseSchema.parse(await response.json());
}

export async function fetchProjectEnvironments(
  projectId: string
): Promise<ListProjectEnvironmentsResponse> {
  const response = await apiFetch(projectPath(projectId, "/environments"));
  if (!response.ok) throw await apiErrorFromResponse(response, "Failed to list environments");
  return listProjectEnvironmentsResponseSchema.parse(await response.json());
}

export async function setProjectEnvironmentVisibility(
  projectId: string,
  environment: string,
  hidden: boolean
): Promise<ProjectEnvironment> {
  const response = await apiFetch(projectPath(projectId, "/environments/visibility"), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environment, hidden })
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Failed to update environment visibility");
  return projectEnvironmentSchema.parse(await response.json());
}

export async function createProject(name: string): Promise<CreatedProjectWithCredential> {
  const response = await apiFetch("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Failed to create project");
  return createdProjectWithCredentialSchema.parse(await response.json());
}

export async function fetchMachineCredentials(projectId: string): Promise<ListMachineCredentialsResponse> {
  const response = await apiFetch(projectPath(projectId, "/credentials"));
  if (!response.ok) throw await apiErrorFromResponse(response, "Failed to list machine credentials");
  return listMachineCredentialsResponseSchema.parse(await response.json());
}

// The returned token is the ONLY time the plaintext machine credential is
// ever available — the caller must show/copy it immediately.
export async function createMachineCredential(
  projectId: string,
  name: string,
  preset: MachineCredentialPreset,
  expiresAt: string | null
): Promise<CreatedMachineCredential> {
  const response = await apiFetch(projectPath(projectId, "/credentials"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, preset, expiresAt })
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Failed to create machine credential");
  return createdMachineCredentialSchema.parse(await response.json());
}

export async function revokeMachineCredential(projectId: string, id: string): Promise<void> {
  const response = await apiFetch(projectPath(projectId, `/credentials/${encodeURIComponent(id)}`), {
    method: "DELETE"
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Failed to revoke machine credential");
}

// Media assets (M9-09): trace input/output JSON carries compact refs
// ("ironside://media/<id>") instead of blob bytes; the viewer resolves
// them here. Returns the blob so callers can build an object URL — an
// <img src> can't carry the Authorization header.
export const MEDIA_REF_PATTERN = /ironside:\/\/media\/([0-9A-HJKMNP-TV-Z]{26})/g;

export async function fetchMediaBlob(projectId: string, id: string): Promise<Blob> {
  const response = await apiFetch(projectPath(projectId, `/media/${id}`));
  if (!response.ok) {
    throw await apiErrorFromResponse(response, "Failed to load media");
  }
  return response.blob();
}
