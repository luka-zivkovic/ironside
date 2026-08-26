import {
  ownerAuthStatusSchema,
  ownerSessionSchema,
  type OwnerAuthStatus,
  type OwnerSessionResponse
} from "@ironside/shared/browser";
import { ApiError } from "./api.js";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

async function authError(response: Response, fallback: string): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as unknown;
  const message =
    body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `${fallback}: ${response.status}`;
  return new ApiError(message, response.status, body);
}

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}/api/auth${path}`, {
    ...init,
    credentials: "include"
  });
}

export async function fetchOwnerAuthStatus(): Promise<OwnerAuthStatus> {
  const response = await authFetch("/status");
  if (!response.ok) throw await authError(response, "Could not check owner setup");
  return ownerAuthStatusSchema.parse(await response.json());
}

export async function fetchOwnerSession(): Promise<OwnerSessionResponse> {
  const response = await authFetch("/session");
  if (!response.ok) throw await authError(response, "Could not load owner session");
  return ownerSessionSchema.parse(await response.json());
}

export async function setupOwner(input: {
  token: string;
  username: string;
  password: string;
}): Promise<OwnerSessionResponse> {
  const response = await authFetch("/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw await authError(response, "Owner setup failed");
  return ownerSessionSchema.parse(await response.json());
}

export async function loginOwner(input: {
  username: string;
  password: string;
}): Promise<OwnerSessionResponse> {
  const response = await authFetch("/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw await authError(response, "Sign in failed");
  return ownerSessionSchema.parse(await response.json());
}

export async function logoutOwner(): Promise<void> {
  const response = await authFetch("/logout", { method: "POST" });
  if (!response.ok) throw await authError(response, "Sign out failed");
}

export async function recoverOwner(input: { token: string; password: string }): Promise<void> {
  const response = await authFetch("/recover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw await authError(response, "Recovery failed");
}
