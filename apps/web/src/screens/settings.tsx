import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { ModelPriceOverride, Project } from "@ironside/shared/browser";
import { ApiError, createProject, fetchModelPrices, fetchProjects, getApiBaseUrl, replaceModelPrices } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page-header";
import { useOwnerSession } from "@/lib/owner-session";
import { useActiveProject, useProjects } from "@/lib/projects";
import { setLastProjectId } from "@/lib/project-storage";
import { useEnvironmentRegistry } from "@/lib/environment-registry";
import { formatTimestamp } from "@/lib/utils";

export function SettingsScreen() {
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const { state: ownerState, signOut } = useOwnerSession();
  const { project } = useActiveProject();
  const navigate = useNavigate();

  async function disconnectOwner() {
    setOwnerError(null);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (error) {
      setOwnerError(error instanceof Error ? error.message : "Could not sign out");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="System · access and tenancy"
        title="Configuration"
        description="Manage projects and owner access for this self-hosted deployment."
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,720px)_minmax(300px,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <ProjectsSection />
          <EnvironmentsSection />
          <ModelPricesSection />
        </div>

        <Card className="xl:sticky xl:top-[68px]">
          <CardHeader className="flex-col items-start gap-1 border-b border-rule-soft">
            <div className="eyebrow">Current scope</div>
            <CardTitle>This browser</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 pt-4">
            <CardDescription>
              Human access uses the HttpOnly owner session. Machine credentials are never stored in this browser.
            </CardDescription>
            {ownerState.status === "authenticated" ? (
              <div className="rounded-sm border border-rule-soft bg-card-2 p-2.5">
                <div className="text-[12px] font-medium">{ownerState.session.username}</div>
                <div className="font-mono text-[10px] text-ink-4">Owner · {ownerState.session.organizationName}</div>
              </div>
            ) : null}
            <div className="rounded-sm border border-rule-soft bg-card-2 p-2.5">
              <div className="text-[12px] font-medium">{project.name}</div>
              <div className="font-mono text-[10px] text-ink-4">{project.id}</div>
            </div>
            <div className="rounded-sm border border-rule-soft bg-card-2 p-2.5">
              <div className="text-[12px] font-medium">Deployment</div>
              <div className="break-all font-mono text-[10px] text-ink-4">{getApiBaseUrl()}</div>
            </div>
            <Button variant="outline" size="sm" className="w-fit" onClick={() => void disconnectOwner()}>
              Sign out owner
            </Button>
            {ownerError ? <div className="text-[12px] text-error">{ownerError}</div> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ProjectsSection() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdCredential, setCreatedCredential] = useState<{ projectId: string; token: string } | null>(null);
  const { refresh: refreshProjectContext } = useProjects();
  const { project: activeProject } = useActiveProject();
  const navigate = useNavigate();

  function reload() {
    return fetchProjects()
      .then((res) => setProjects(res.projects))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load projects"));
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createProject(name);
      setCreatedCredential({ projectId: created.project.id, token: created.initialCredential.token });
      setNewProjectName("");
      await Promise.all([reload(), refreshProjectContext()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-col items-start gap-1 border-b border-rule-soft">
        <div className="eyebrow">Tenancy</div>
        <CardTitle>Projects in this organization</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <CardDescription>
          Project selection is part of the URL and owner session. Creating one also mints its first data-plane
          credential atomically; copy it once, then rotate it after initial setup.
        </CardDescription>

        {createdCredential ? (
          <div className="rounded-sm border border-signal-tint bg-signal-wash p-3 flex flex-col gap-2">
            <div className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-signal">
              Copy this initial credential now — it will not be shown again
            </div>
            <div className="break-all font-mono text-[12px]">{createdCredential.token}</div>
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => {
                setLastProjectId(createdCredential.projectId);
                navigate(`/projects/${encodeURIComponent(createdCredential.projectId)}/connections`);
              }}
            >
              Open Connections
            </Button>
          </div>
        ) : null}

        {error ? <div className="text-[12px] text-error">{error}</div> : null}

        {projects === null ? (
          <div className="text-[12.5px] text-ink-3">Loading…</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {projects.map((p) => (
              <div key={p.id} className="flex items-center gap-3 rounded-sm border border-rule-soft bg-card-2 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium">{p.name}{p.id === activeProject.id ? " · active" : ""}</div>
                  <div className="font-mono text-[10.5px] text-ink-4">{p.id}</div>
                </div>
                {p.id !== activeProject.id ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="ml-auto"
                    onClick={() => navigate(`/projects/${encodeURIComponent(p.id)}/settings`)}
                  >
                    Open
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-2 border-t border-rule-soft pt-4">
          <div className="flex flex-1 flex-col gap-1">
            <span className="eyebrow">New project name</span>
            <Input
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="e.g. customer-api"
              disabled={creating}
              className="min-w-[220px]"
            />
          </div>
          <Button type="submit" variant="primary" size="sm" disabled={creating || !newProjectName.trim()}>
            {creating ? "Creating…" : "Create project"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// Prices are edited per million tokens (how providers publish them) and
// stored per token (how the worker multiplies them).
const PER_MILLION = 1_000_000;

interface PriceRowDraft {
  key: string;
  pattern: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

function perMillionText(perToken: number | null): string {
  return perToken === null ? "" : String(Number((perToken * PER_MILLION).toPrecision(10)));
}

function perTokenValue(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value / PER_MILLION : Number.NaN;
}

function draftFromOverride(override: ModelPriceOverride): PriceRowDraft {
  return {
    key: override.id,
    pattern: override.pattern,
    input: perMillionText(override.inputCostPerToken),
    output: perMillionText(override.outputCostPerToken),
    cacheRead: perMillionText(override.cacheReadInputTokenCost),
    cacheWrite: perMillionText(override.cacheWriteInputTokenCost)
  };
}

function ModelPricesSection() {
  const { project } = useActiveProject();
  const [rows, setRows] = useState<PriceRowDraft[] | null>(null);
  const [table, setTable] = useState<{ syncedAt: string; modelCount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    fetchModelPrices(project.id)
      .then((response) => {
        if (cancelled) return;
        setRows(response.overrides.map(draftFromOverride));
        setTable({ syncedAt: response.table.syncedAt, modelCount: response.table.modelCount });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Failed to load model prices");
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  function updateRow(key: string, patch: Partial<PriceRowDraft>) {
    setSaved(false);
    setRows((current) => current?.map((row) => (row.key === key ? { ...row, ...patch } : row)) ?? current);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!rows) return;
    setError(null);
    setSaved(false);
    const overrides = [];
    for (const row of rows) {
      const prices = {
        inputCostPerToken: perTokenValue(row.input),
        outputCostPerToken: perTokenValue(row.output),
        cacheReadInputTokenCost: perTokenValue(row.cacheRead),
        cacheWriteInputTokenCost: perTokenValue(row.cacheWrite)
      };
      if (!row.pattern.trim()) {
        setError("Every rule needs a model pattern.");
        return;
      }
      if (Object.values(prices).some((value) => Number.isNaN(value))) {
        setError(`Prices for "${row.pattern}" must be numbers (USD per million tokens).`);
        return;
      }
      if (Object.values(prices).every((value) => value === null)) {
        setError(`Rule "${row.pattern}" needs at least one price.`);
        return;
      }
      overrides.push({ pattern: row.pattern.trim(), ...prices });
    }
    setSaving(true);
    try {
      const response = await replaceModelPrices(project.id, overrides);
      setRows(response.overrides.map(draftFromOverride));
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save model prices");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-col items-start gap-1 border-b border-rule-soft">
        <div className="eyebrow">Cost</div>
        <CardTitle>Model prices</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <CardDescription>
          When an observation reports token usage and a model but no cost, the worker derives cost at ingest. Rules
          below are checked in order first; anything unmatched falls back to the bundled price table
          {table ? ` (${table.modelCount.toLocaleString()} models, synced ${table.syncedAt})` : ""}. Cost a client
          sends is always kept as is.
        </CardDescription>

        {error ? <div className="text-[12px] text-error">{error}</div> : null}

        {rows === null ? (
          <div className="text-[12.5px] text-ink-3">Loading…</div>
        ) : (
          <form onSubmit={save} className="flex flex-col gap-3">
            {rows.length === 0 ? (
              <div className="rounded-sm border border-dashed border-rule-soft px-3 py-4 text-center text-[12px] text-ink-4">
                No project rules. Add one for private, fine-tuned, or newly released models.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="ledger min-w-[640px]">
                  <thead>
                    <tr>
                      <th>Model pattern (regex)</th>
                      <th>Input $/1M</th>
                      <th>Output $/1M</th>
                      <th>Cache read $/1M</th>
                      <th>Cache write $/1M</th>
                      <th aria-label="Remove" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key}>
                        <td>
                          <Input
                            value={row.pattern}
                            onChange={(e) => updateRow(row.key, { pattern: e.target.value })}
                            placeholder="^my-finetune-"
                            className="min-w-[150px] font-mono text-[11.5px]"
                            aria-label="Model pattern"
                          />
                        </td>
                        {(["input", "output", "cacheRead", "cacheWrite"] as const).map((field) => (
                          <td key={field}>
                            <Input
                              value={row[field]}
                              onChange={(e) => updateRow(row.key, { [field]: e.target.value })}
                              inputMode="decimal"
                              placeholder="—"
                              className="w-[80px] font-mono text-[11.5px]"
                              aria-label={`${field} price per million tokens`}
                            />
                          </td>
                        ))}
                        <td>
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => {
                              setSaved(false);
                              setRows((current) => current?.filter((r) => r.key !== row.key) ?? current);
                            }}
                          >
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-rule-soft pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setSaved(false);
                  setRows((current) => [
                    ...(current ?? []),
                    { key: `new_${Date.now()}`, pattern: "", input: "", output: "", cacheRead: "", cacheWrite: "" }
                  ]);
                }}
              >
                Add rule
              </Button>
              <Button type="submit" variant="primary" size="sm" disabled={saving}>
                {saving ? "Saving…" : "Save rules"}
              </Button>
              {saved ? <span className="text-[11.5px] text-ink-4">Saved. Applies to traces ingested from now on.</span> : null}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function EnvironmentsSection() {
  const registry = useEnvironmentRegistry();
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(name: string, hidden: boolean) {
    setUpdating(name);
    setError(null);
    try {
      await registry.setHidden(name, hidden);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update environment");
    } finally {
      setUpdating(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-col items-start gap-1 border-b border-rule-soft">
        <div className="eyebrow">Discovery</div>
        <CardTitle>Observed environments</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <CardDescription>
          Environments are automatically observed trace attributes within this project. Hiding one only removes it
          from the picker; it never deletes or excludes traces.
        </CardDescription>
        {registry.overflowed ? (
          <div className="rounded-sm border border-warn/30 bg-warn/5 p-3 text-[12px] text-warn">
            This project reached the {registry.limit}-environment discovery limit. Additional values remain
            queryable by an exact URL filter but are not listed here.
          </div>
        ) : null}
        {registry.error || error ? (
          <div className="text-[12px] text-error">{error ?? registry.error}</div>
        ) : null}
        {registry.loading ? (
          <div className="text-[12.5px] text-ink-3">Loading environments…</div>
        ) : registry.environments.length === 0 ? (
          <div className="rounded-sm border border-rule-soft bg-card-2 p-3 text-[12.5px] text-ink-3">
            No environments have been observed yet. New valid values appear after their traces are processed.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {registry.environments.map((environment) => (
              <div
                key={environment.name}
                className="flex flex-wrap items-center gap-3 rounded-sm border border-rule-soft bg-card-2 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-medium">
                    {environment.name}{environment.hidden ? " · hidden" : ""}
                  </div>
                  <div className="font-mono text-[9.5px] text-ink-4">
                    {formatTimestamp(environment.firstSeenAt)} → {formatTimestamp(environment.lastSeenAt)}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={updating === environment.name}
                  onClick={() => void toggle(environment.name, !environment.hidden)}
                >
                  {updating === environment.name
                    ? "Saving…"
                    : environment.hidden
                      ? "Show"
                      : "Hide"}
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11.5px] leading-5 text-ink-4">
          Use environments when access, retention, quotas, and credentials are shared. Use a separate project when
          any of those policies must differ.
        </p>
      </CardContent>
    </Card>
  );
}
