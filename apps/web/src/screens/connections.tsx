import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  MachineCredentialPreset,
  MachineCredentialSummary
} from "@ironside/shared/browser";
import { ApiError, createMachineCredential, fetchMachineCredentials, getApiBaseUrl, revokeMachineCredential } from "@/lib/api";
import { buildConnectionSnippets, type ConnectionSnippet } from "@/lib/connection-snippets";
import { useActiveProject } from "@/lib/projects";
import { formatTimestamp } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type CopyState = "idle" | "copied" | "failed";

async function copyText(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to a selection-based copy for deliberate plain-HTTP
      // self-hosts where the Clipboard API may be unavailable.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

export function ConnectionsScreen() {
  const { project } = useActiveProject();
  const host = getApiBaseUrl();
  const snippets = useMemo(() => buildConnectionSnippets(host), [host]);
  const [credentials, setCredentials] = useState<MachineCredentialSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<MachineCredentialPreset>("ingest");
  const [expiresAt, setExpiresAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  function reload() {
    return fetchMachineCredentials(project.id)
      .then((response) => setCredentials(response.credentials))
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : "Failed to load credentials"));
  }

  useEffect(() => {
    void reload();
  }, [project.id]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const credentialName = name.trim();
    if (!credentialName || creating) return;
    setCreating(true);
    setError(null);
    try {
      const expiry = expiresAt ? new Date(expiresAt).toISOString() : null;
      const created = await createMachineCredential(project.id, credentialName, preset, expiry);
      setCreatedToken(created.token);
      setName("");
      setExpiresAt("");
      await reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Failed to create credential");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!window.confirm("Revoke this credential immediately? Clients using it will start receiving 401 responses.")) return;
    setError(null);
    setRevokingId(id);
    try {
      await revokeMachineCredential(project.id, id);
      await reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Failed to revoke credential");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Project · machine access"
        title="Connections"
        description="Create least-privilege machine credentials and copy exact setup snippets for this deployment."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <ScopeCard label="Deployment host" value={host} />
        <ScopeCard label="Active project" value={`${project.name} · ${project.id}`} />
      </div>

      <Card>
        <CardHeader className="flex-col items-start gap-1 border-b border-rule-soft">
          <div className="eyebrow">Least privilege</div>
          <CardTitle>Create a machine credential</CardTitle>
          <CardDescription>
            Presets are frozen into explicit capabilities at creation. Machine credentials cannot access owner or
            project-management routes.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-5">
          <div className="grid gap-3 md:grid-cols-2">
            <PresetCard
              selected={preset === "ingest"}
              title="Ingest"
              capabilities="ingest · media:write"
              description="Send native, OTLP, or LangFuse traces and upload media. No trace reads or standalone score writes."
              onSelect={() => setPreset("ingest")}
            />
            <PresetCard
              selected={preset === "integration"}
              title="Integration"
              capabilities="traces:read · scores:write"
              description="Read settled project traces and submit evaluator scores. No ingest or media upload."
              onSelect={() => setPreset("integration")}
            />
          </div>

          {createdToken ? <OneTimeToken token={createdToken} onDismiss={() => setCreatedToken(null)} /> : null}
          {error ? <div className="text-[12px] text-error">{error}</div> : null}

          <form onSubmit={handleCreate} className="grid items-end gap-3 border-t border-rule-soft pt-4 md:grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)_auto]">
            <label className="flex flex-col gap-1.5">
              <span className="eyebrow">Credential name</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={preset === "ingest" ? "e.g. production-api" : "e.g. nightly-evaluator"}
                disabled={creating || createdToken !== null}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="eyebrow">Expires (optional)</span>
              <Input
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                disabled={creating || createdToken !== null}
              />
            </label>
            <Button type="submit" variant="primary" disabled={creating || createdToken !== null || !name.trim()}>
              {creating ? "Creating…" : `Create ${preset}`}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-col items-start gap-1 border-b border-rule-soft">
          <div className="eyebrow">Lifecycle</div>
          <CardTitle>Project credentials</CardTitle>
          <CardDescription>
            Plaintext is never returned here. Revocation takes effect immediately, including credentials already cached by the API.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          {credentials === null ? (
            <div className="text-[12.5px] text-ink-3">Loading…</div>
          ) : credentials.length === 0 ? (
            <div className="text-[12.5px] text-ink-3">No credentials yet.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {credentials.map((credential) => (
                <CredentialRow
                  key={credential.id}
                  credential={credential}
                  revoking={revokingId === credential.id}
                  onRevoke={handleRevoke}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <PageHeader
          eyebrow="Copy and connect"
          title="Connection snippets"
          description="Set IRONSIDE_API_KEY to the one-time token, then use the matching protocol example. The credential itself selects the project."
        />
        <SnippetGroup title="Ingest preset" snippets={snippets.filter((snippet) => snippet.preset === "ingest")} />
        <SnippetGroup title="Integration preset" snippets={snippets.filter((snippet) => snippet.preset === "integration")} />
      </div>
    </div>
  );
}

function ScopeCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-rule-soft bg-card px-4 py-3 shadow-[var(--shadow-card)]">
      <div className="eyebrow">{label}</div>
      <div className="mt-1 break-all font-mono text-[11px] text-ink-2">{value}</div>
    </div>
  );
}

function PresetCard({
  selected,
  title,
  capabilities,
  description,
  onSelect
}: {
  selected: boolean;
  title: string;
  capabilities: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`cursor-pointer rounded-sm border p-4 text-left transition-colors ${
        selected ? "border-signal bg-signal-wash" : "border-rule-soft bg-card-2 hover:border-rule"
      }`}
      aria-pressed={selected}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium">{title}</span>
        {selected ? <Badge variant="signal">Selected</Badge> : null}
      </div>
      <div className="mt-1 font-mono text-[10px] text-ink-4">{capabilities}</div>
      <p className="mt-2 text-[12px] leading-5 text-ink-3">{description}</p>
    </button>
  );
}

function OneTimeToken({ token, onDismiss }: { token: string; onDismiss: () => void }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  return (
    <div className="rounded-sm border border-signal-tint bg-signal-wash p-3">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-signal">
        Copy this now — it will not be shown again
      </div>
      <div className="mt-2 break-all font-mono text-[12px]">{token}</div>
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => void copyText(token).then((copied) => setCopyState(copied ? "copied" : "failed"))}
        >
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy token"}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onDismiss}>Dismiss</Button>
      </div>
    </div>
  );
}

function credentialStatus(credential: MachineCredentialSummary): "active" | "expired" | "revoked" {
  if (credential.revokedAt) return "revoked";
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) return "expired";
  return "active";
}

function CredentialRow({
  credential,
  revoking,
  onRevoke
}: {
  credential: MachineCredentialSummary;
  revoking: boolean;
  onRevoke: (id: string) => Promise<void>;
}) {
  const status = credentialStatus(credential);
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-rule-soft bg-card-2 px-3 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[12.5px] font-medium">{credential.name}</span>
          <Badge variant={status === "active" ? "ok" : status === "expired" ? "warn" : "error"}>{status}</Badge>
          <Badge>{credential.preset}</Badge>
        </div>
        <div className="mt-1 font-mono text-[10px] text-ink-4">
          {credential.tokenPrefix}… · {credential.capabilities.join(" · ")}
        </div>
        <div className="mt-1 text-[10.5px] text-ink-4">
          Created {formatTimestamp(credential.createdAt)}
          {credential.createdBy ? ` by ${credential.createdBy.username}` : " before owner attribution"}
          {credential.expiresAt ? ` · expires ${formatTimestamp(credential.expiresAt)}` : " · no expiry"}
          {credential.lastUsedAt ? ` · last used ${formatTimestamp(credential.lastUsedAt)}` : " · never used"}
          {credential.revokedBy ? ` · revoked by ${credential.revokedBy.username}` : ""}
        </div>
      </div>
      {status === "active" ? (
        <Button
          type="button"
          variant="destructive"
          size="xs"
          disabled={revoking}
          onClick={() => void onRevoke(credential.id)}
        >
          {revoking ? "Revoking…" : "Revoke"}
        </Button>
      ) : null}
    </div>
  );
}

function SnippetGroup({ title, snippets }: { title: string; snippets: ConnectionSnippet[] }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="eyebrow">{title}</div>
      <div className="grid gap-4 xl:grid-cols-2">
        {snippets.map((snippet) => <SnippetCard key={snippet.id} snippet={snippet} />)}
      </div>
    </section>
  );
}

function SnippetCard({ snippet }: { snippet: ConnectionSnippet }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  return (
    <Card>
      <CardHeader className="border-b border-rule-soft">
        <div className="min-w-0">
          <CardTitle>{snippet.title}</CardTitle>
          <CardDescription className="mt-1">{snippet.description}</CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => void copyText(snippet.code).then((copied) => setCopyState(copied ? "copied" : "failed"))}
        >
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
        </Button>
      </CardHeader>
      <CardContent className="pt-4">
        <pre className="overflow-x-auto whitespace-pre rounded-sm border border-rule-soft bg-paper-2 p-3 font-mono text-[10.5px] leading-5 text-ink-2">
          <code>{snippet.code}</code>
        </pre>
      </CardContent>
    </Card>
  );
}
