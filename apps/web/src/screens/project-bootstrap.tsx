import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { createProject } from "@/lib/api";
import { useProjects } from "@/lib/projects";
import { setLastProjectId } from "@/lib/project-storage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { IronsideBrand } from "@/components/ironside-brand";

export function ProjectBootstrapScreen() {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ projectId: string; token: string } | null>(null);
  const { refresh } = useProjects();
  const navigate = useNavigate();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const projectName = name.trim();
    if (!projectName || creating) return;
    setCreating(true);
    setError(null);
    try {
      const response = await createProject(projectName);
      setLastProjectId(response.project.id);
      setCreated({ projectId: response.project.id, token: response.initialCredential.token });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create project");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center px-5 py-12">
      <Card className="w-full max-w-[620px] shadow-[var(--shadow-elev)]">
        <CardHeader className="flex-col items-start gap-1 border-b border-rule-soft">
          <IronsideBrand
            className="mb-2"
            markClassName="size-6"
            nameClassName="font-serif text-[17px] font-medium tracking-[-0.02em] text-ink"
          />
          <div className="eyebrow">First project</div>
          <CardTitle>Create the first data boundary</CardTitle>
          <CardDescription>
            Projects isolate traces, credentials, retention, and quotas. This creates the project and one initial
            data-plane credential in a single transaction.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-5">
          {created ? (
            <>
              <div className="rounded-sm border border-signal-tint bg-signal-wash p-3">
                <div className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-signal">
                  Copy this credential now — it will not be shown again
                </div>
                <div className="mt-2 break-all font-mono text-[12px]">{created.token}</div>
              </div>
              <p className="text-[12px] leading-5 text-ink-3">
                Use it for initial ingest, then rotate it from Connections. Any credential previously pasted
                into the old browser UI should also be revoked and replaced.
              </p>
              {error ? <div className="text-[12px] text-error">{error}</div> : null}
              <Button variant="primary" onClick={() => {
                setCreating(true);
                void refresh()
                  .then(() => navigate(`/projects/${encodeURIComponent(created.projectId)}/connections`, { replace: true }))
                  .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not open project"))
                  .finally(() => setCreating(false));
              }} disabled={creating}>
                Open Connections
              </Button>
            </>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="eyebrow">Project name</span>
                <Input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. production"
                  disabled={creating}
                />
              </label>
              {error ? <div className="text-[12px] text-error">{error}</div> : null}
              <Button type="submit" variant="primary" disabled={creating || !name.trim()}>
                {creating ? "Creating…" : "Create project"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
