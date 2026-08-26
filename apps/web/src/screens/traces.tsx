import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, RefreshCcw, Search } from "lucide-react";
import type { TraceSummary } from "@ironside/shared/browser";
import { ApiError, fetchTraces, getApiBaseUrl, type ListTracesParams } from "@/lib/api";
import { buildNativeIngestCurl } from "@/lib/connection-snippets";
import { useActiveProject } from "@/lib/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { formatTimestamp } from "@/lib/utils";

interface Filters {
  userId: string;
  sessionId: string;
  tags: string;
  environment: string;
}

const EMPTY_FILTERS: Filters = { userId: "", sessionId: "", tags: "", environment: "" };
const EMPTY_STATE_REFRESH_INTERVAL_MS = 3_000;
const EMPTY_STATE_MAX_AUTO_REFRESHES = 40;

function firstTraceCurl(): string {
  const payload = JSON.stringify({
    events: [
      {
        type: "trace-upsert",
        body: {
          id: `trace_${Date.now().toString(36)}`,
          timestamp: new Date().toISOString(),
          name: "first-trace"
        }
      }
    ]
  });
  return buildNativeIngestCurl(getApiBaseUrl(), payload);
}

function hasFilters(filters: Filters): boolean {
  return Boolean(
    filters.userId.trim() ||
      filters.sessionId.trim() ||
      filters.tags.trim() ||
      filters.environment.trim()
  );
}

function toParams(filters: Filters, cursor: string | null): ListTracesParams {
  const tags = filters.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    limit: 30,
    ...(filters.userId.trim() && { userId: filters.userId.trim() }),
    ...(filters.sessionId.trim() && { sessionId: filters.sessionId.trim() }),
    ...(filters.environment.trim() && { environment: filters.environment.trim() }),
    ...(tags.length > 0 && { tags }),
    ...(cursor && { cursor })
  };
}

export function TracesScreen() {
  const { project } = useActiveProject();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchKey = searchParams.toString();
  const filters = useMemo(() => filtersFromSearchParams(new URLSearchParams(searchKey)), [searchKey]);
  const [pendingFilters, setPendingFilters] = useState<Filters>(filters);
  const [traces, setTraces] = useState<TraceSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [autoRefreshCount, setAutoRefreshCount] = useState(0);

  const showFirstTraceOnboarding =
    traces?.length === 0 && !hasFilters(filters) && currentCursor === null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTraces(project.id, toParams(filters, currentCursor))
      .then((response) => {
        if (cancelled) return;
        setTraces(response.traces);
        setNextCursor(response.nextCursor);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Failed to load traces");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, filters, currentCursor, refreshVersion]);

  useEffect(() => {
    setPendingFilters(filters);
    setCursorStack([]);
    setCurrentCursor(null);
  }, [filters]);

  // Native ingest is queued, so a successful curl returns before the worker
  // writes the trace. Poll briefly while this onboarding state is visible so
  // the first trace appears without requiring a page reload.
  useEffect(() => {
    if (loading || !showFirstTraceOnboarding || autoRefreshCount >= EMPTY_STATE_MAX_AUTO_REFRESHES) return;
    const timeout = window.setTimeout(() => {
      setAutoRefreshCount((count) => count + 1);
      setRefreshVersion((version) => version + 1);
    }, EMPTY_STATE_REFRESH_INTERVAL_MS);
    return () => window.clearTimeout(timeout);
  }, [loading, showFirstTraceOnboarding, autoRefreshCount]);

  function applyFilters() {
    setSearchParams(searchParamsFromFilters(pendingFilters));
  }

  function goNext() {
    if (!nextCursor) return;
    setCursorStack((stack) => [...stack, currentCursor]);
    setCurrentCursor(nextCursor);
  }

  function goPrev() {
    setCursorStack((stack) => {
      if (stack.length === 0) return stack;
      const copy = [...stack];
      const prev = copy.pop() ?? null;
      setCurrentCursor(prev);
      return copy;
    });
  }

  function refreshTraces() {
    setAutoRefreshCount(0);
    setRefreshVersion((version) => version + 1);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Record · every interaction"
        title="Trace explorer"
        description="Find a request, reconstruct its path, and inspect the stored trace record for this project."
        actions={
          <Button variant="outline" size="sm" onClick={refreshTraces} disabled={loading}>
            <RefreshCcw className={loading ? "animate-spin motion-reduce:animate-none" : undefined} />
            Refresh
          </Button>
        }
      />

      <Card>
        <CardHeader className="flex-col items-start gap-1 border-b border-rule-soft pb-3">
          <CardTitle>Narrow the record</CardTitle>
          <CardDescription>Filter by the identifiers attached at ingest.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <Field label="User ID">
            <Input
              value={pendingFilters.userId}
              onChange={(e) => setPendingFilters((f) => ({ ...f, userId: e.target.value }))}
              placeholder="user_123"
              className="w-full sm:w-[180px]"
            />
          </Field>
          <Field label="Session ID">
            <Input
              value={pendingFilters.sessionId}
              onChange={(e) => setPendingFilters((f) => ({ ...f, sessionId: e.target.value }))}
              placeholder="session_abc"
              className="w-full sm:w-[180px]"
            />
          </Field>
          <Field label="Tags (comma-separated)">
            <Input
              value={pendingFilters.tags}
              onChange={(e) => setPendingFilters((f) => ({ ...f, tags: e.target.value }))}
              placeholder="prod, checkout"
              className="w-full sm:w-[220px]"
            />
          </Field>
          <Button variant="primary" size="sm" onClick={applyFilters}>
            <Search />
            Apply filters
          </Button>
          {filters.userId || filters.sessionId || filters.tags ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPendingFilters({
                  ...EMPTY_FILTERS,
                  environment: filters.environment
                });
                setSearchParams(
                  searchParamsFromFilters({
                    ...EMPTY_FILTERS,
                    environment: filters.environment
                  })
                );
              }}
            >
              Clear
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {error ? (
        <Card className="p-6 text-[12.5px] text-error">{error}</Card>
      ) : loading && !traces ? (
        <Card className="p-6 text-[12.5px] text-ink-3">Loading traces…</Card>
      ) : showFirstTraceOnboarding ? (
        <FirstTraceOnboarding loading={loading} onRefresh={refreshTraces} />
      ) : traces && traces.length === 0 ? (
        <Card className="p-10 text-center text-[12.5px] text-ink-3">
          No traces match these filters yet.
        </Card>
      ) : traces ? (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-rule-soft px-4 py-3">
            <div>
              <div className="font-serif text-[14.5px] font-medium">Recorded traces</div>
              <div className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-4">
                {traces.length} on this page
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="ledger min-w-[820px]">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Timestamp</th>
                  <th>User</th>
                  <th>Session</th>
                  <th>Environment</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {traces.map((trace) => (
                  <tr
                    key={trace.id}
                    onClick={() => navigate(`${location.pathname}/${encodeURIComponent(trace.id)}${location.search}`)}
                    className="group cursor-pointer select-none transition-colors hover:bg-signal-wash focus-within:bg-signal-wash"
                    title={`Open ${trace.name ?? "unnamed trace"}`}
                  >
                    <td>
                      <Link
                        to={`${location.pathname}/${encodeURIComponent(trace.id)}${location.search}`}
                        onClick={(event) => event.stopPropagation()}
                        className="inline-flex min-h-6 items-center gap-1.5 font-medium text-ink outline-none transition-colors group-hover:text-signal focus-visible:text-signal focus-visible:underline"
                      >
                        {trace.name ?? <span className="text-ink-4 italic">unnamed</span>}
                        <ArrowRight className="h-3 w-3 shrink-0 text-ink-4 transition-transform group-hover:translate-x-0.5 group-hover:text-signal" aria-hidden />
                      </Link>
                    </td>
                    <td className="font-mono text-[11.5px] text-ink-3">{formatTimestamp(trace.timestamp)}</td>
                    <td className="text-ink-2">{trace.userId ?? "—"}</td>
                    <td className="text-ink-2">{trace.sessionId ?? "—"}</td>
                    <td className="text-ink-2">{trace.environment ?? "—"}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {trace.tags.map((tag) => (
                          <Badge key={tag}>{tag}</Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <div className="flex items-center justify-between gap-2 border-t border-rule-soft pt-4">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-4">
          {cursorStack.length === 0 ? "First page" : `Page ${cursorStack.length + 1}`}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={goPrev} disabled={cursorStack.length === 0 || loading}>
            Previous
          </Button>
          <Button variant="outline" size="sm" onClick={goNext} disabled={!nextCursor || loading}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

function FirstTraceOnboarding({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  const [command] = useState(firstTraceCurl);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "selected" | "failed">("idle");
  const commandRef = useRef<HTMLElement>(null);

  function selectCommand(): boolean {
    const node = commandRef.current;
    const selection = window.getSelection();
    if (!node || !selection) return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  async function copyCommand() {
    setCopyStatus("idle");
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(command);
        setCopyStatus("copied");
        return;
      } catch {
        // Fall through to selection + the legacy copy path for insecure origins.
      }
    }

    const selected = selectCommand();
    if (selected) {
      try {
        if (document.execCommand("copy")) {
          setCopyStatus("copied");
          return;
        }
      } catch {
        // The selected command remains available for a manual Ctrl/Cmd+C.
      }
    }
    setCopyStatus(selected ? "selected" : "failed");
  }

  return (
    <Card className="p-6 shadow-[var(--shadow-card)]">
      <div className="max-w-[860px]">
        <div className="eyebrow">First record</div>
        <h2 className="type-h2 mt-1.5 text-ink">Send your first trace</h2>
        <p className="mt-1 text-[12.5px] leading-5 text-ink-3">
          Create or copy a data-plane credential from project settings, replace the placeholder below, and run this
          single-line command in Bash, zsh, or PowerShell.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-sm border border-rule-soft bg-paper-2 p-4 font-mono text-[11px] leading-5 text-ink-2">
          <code ref={commandRef}>{command}</code>
        </pre>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" onClick={copyCommand}>
            {copyStatus === "copied" ? "Copied" : "Copy command"}
          </Button>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
            {loading ? "Checking…" : "Refresh traces"}
          </Button>
          <span className="text-[11.5px] text-ink-4">This page also checks automatically for two minutes.</span>
        </div>
        {copyStatus === "selected" ? (
          <p role="alert" className="mt-2 text-[11.5px] text-warn">
            Automatic copy is unavailable. Press Ctrl+C (or ⌘C on macOS) to copy the selected command.
          </p>
        ) : copyStatus === "failed" ? (
          <p role="alert" className="mt-2 text-[11.5px] text-warn">
            Automatic copy is unavailable. Select the command above and copy it manually.
          </p>
        ) : null}
        <p className="mt-3 font-mono text-[10.5px] text-ink-4">
          Set IRONSIDE_API_KEY to an Ingest credential and treat it as a secret.
        </p>
      </div>
    </Card>
  );
}

export function filtersFromSearchParams(search: URLSearchParams): Filters {
  return {
    userId: search.get("userId") ?? "",
    sessionId: search.get("sessionId") ?? "",
    tags: search.getAll("tags").join(", "),
    environment: search.get("environment") ?? ""
  };
}

export function searchParamsFromFilters(filters: Filters): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.userId.trim()) search.set("userId", filters.userId.trim());
  if (filters.sessionId.trim()) search.set("sessionId", filters.sessionId.trim());
  if (filters.environment.trim()) search.set("environment", filters.environment.trim());
  for (const tag of filters.tags.split(",").map((value) => value.trim()).filter(Boolean)) {
    search.append("tags", tag);
  }
  return search;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex w-full flex-col gap-1 sm:w-auto">
      <span className="eyebrow">{label}</span>
      {children}
    </label>
  );
}
