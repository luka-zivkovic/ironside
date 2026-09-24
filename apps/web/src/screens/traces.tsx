import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, RefreshCcw, Search } from "lucide-react";
import {
  MAX_TRACE_FILTER_TEXT_LENGTH,
  type AggregatesResponse,
  type TraceSummary
} from "@ironside/shared/browser";
import { ApiError, fetchAggregates, fetchTraces, getApiBaseUrl } from "@/lib/api";
import { buildNativeIngestCurl } from "@/lib/connection-snippets";
import {
  TIME_RANGE_OPTIONS,
  formatCompactNumber,
  formatLatency,
  formatTraceCost,
  parseTimeRange,
  summaryTiles,
  type SummaryTile,
  type TimeRange
} from "@/lib/trace-analytics";
import {
  LEVEL_OPTIONS,
  clearLocalFilters,
  filtersFromSearchParams,
  hasFilters,
  parseCostFloor,
  parseLatencyFloor,
  searchParamsFromFilters,
  toParams,
  type Filters,
  type LevelFilter
} from "@/lib/trace-filters";
import { useActiveProject } from "@/lib/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { cn, formatTimestamp } from "@/lib/utils";

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

const SELECT_CLASS =
  "h-8 w-full rounded-sm border border-rule bg-card px-2 text-[12.5px] text-ink outline-none focus-visible:border-signal sm:w-[150px]";

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
  const [aggregates, setAggregates] = useState<AggregatesResponse | null>(null);
  const [aggregatesError, setAggregatesError] = useState<string | null>(null);

  const showFirstTraceOnboarding =
    traces?.length === 0 && !hasFilters(filters) && currentCursor === null;
  const localFiltersActive = hasFilters({ ...filters, environment: "" });
  const pageModels = useMemo(
    () => [...new Set((traces ?? []).flatMap((trace) => trace.models))].sort(),
    [traces]
  );

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

  // The summary covers the whole filtered set, not the current page, so it
  // ignores the cursor and refreshes only when filters change or on demand.
  useEffect(() => {
    let cancelled = false;
    setAggregatesError(null);
    const { limit: _limit, cursor: _cursor, ...params } = toParams(filters, null);
    fetchAggregates(project.id, params)
      .then((response) => {
        if (!cancelled) setAggregates(response);
      })
      .catch((err) => {
        if (cancelled) return;
        setAggregatesError(err instanceof ApiError ? err.message : "Failed to load summary");
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, filters, refreshVersion]);

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

  function applyFilters(changes: Partial<Filters> = {}) {
    setSearchParams(searchParamsFromFilters({ ...pendingFilters, ...changes }));
  }

  function clearFilters() {
    const cleared = clearLocalFilters(filters);
    setPendingFilters(cleared);
    setSearchParams(searchParamsFromFilters(cleared));
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
          <CardDescription>
            Search what traces and their steps said, or filter by what was attached and measured at ingest.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              applyFilters();
            }}
          >
            <Field label="Search">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-4"
                  aria-hidden
                />
                <Input
                  type="search"
                  value={pendingFilters.search}
                  onChange={(e) => setPendingFilters((f) => ({ ...f, search: e.target.value }))}
                  placeholder="Text in a name, input or output, or an exact trace ID"
                  maxLength={MAX_TRACE_FILTER_TEXT_LENGTH}
                  className="pl-8"
                />
              </div>
            </Field>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Time range">
                <select
                  value={filters.range}
                  onChange={(e) => applyFilters({ range: parseTimeRange(e.target.value) })}
                  className={SELECT_CLASS}
                  aria-label="Time range"
                >
                  {TIME_RANGE_OPTIONS.map((option) => (
                    <option key={option.value || "all"} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Level">
                <select
                  value={filters.level}
                  onChange={(e) => applyFilters({ level: e.target.value as LevelFilter })}
                  className={SELECT_CLASS}
                  aria-label="Level"
                >
                  {LEVEL_OPTIONS.map((option) => (
                    <option key={option.value || "any"} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model">
                <Input
                  value={pendingFilters.model}
                  onChange={(e) => setPendingFilters((f) => ({ ...f, model: e.target.value }))}
                  placeholder="gpt-4o"
                  maxLength={MAX_TRACE_FILTER_TEXT_LENGTH}
                  list="trace-models"
                  className="w-full sm:w-[160px]"
                />
                <datalist id="trace-models">
                  {pageModels.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </Field>
              <Field label="Min latency (s)">
                <FloorInput
                  value={pendingFilters.minLatencySeconds}
                  onChange={(value) => setPendingFilters((f) => ({ ...f, minLatencySeconds: value }))}
                  parse={parseLatencyFloor}
                  placeholder="2"
                />
              </Field>
              <Field label="Min cost ($)">
                <FloorInput
                  value={pendingFilters.minCost}
                  onChange={(value) => setPendingFilters((f) => ({ ...f, minCost: value }))}
                  parse={parseCostFloor}
                  placeholder="0.05"
                />
              </Field>
              <Field label="User ID">
                <Input
                  value={pendingFilters.userId}
                  onChange={(e) => setPendingFilters((f) => ({ ...f, userId: e.target.value }))}
                  placeholder="user_123"
                  className="w-full sm:w-[160px]"
                />
              </Field>
              <Field label="Session ID">
                <Input
                  value={pendingFilters.sessionId}
                  onChange={(e) => setPendingFilters((f) => ({ ...f, sessionId: e.target.value }))}
                  placeholder="session_abc"
                  className="w-full sm:w-[160px]"
                />
              </Field>
              <Field label="Tags (comma-separated)">
                <Input
                  value={pendingFilters.tags}
                  onChange={(e) => setPendingFilters((f) => ({ ...f, tags: e.target.value }))}
                  placeholder="prod, checkout"
                  className="w-full sm:w-[200px]"
                />
              </Field>
              <Button type="submit" variant="primary" size="sm">
                <Search />
                Apply filters
              </Button>
              {localFiltersActive ? (
                <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      {showFirstTraceOnboarding ? null : (
        <SummaryStrip aggregates={aggregates} error={aggregatesError} range={filters.range} />
      )}

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
            <table className="ledger min-w-[1040px]">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Timestamp</th>
                  <th className="text-right">Latency</th>
                  <th className="text-right">Cost</th>
                  <th className="text-right">Tokens</th>
                  <th>Models</th>
                  <th>User · Session</th>
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
                      {trace.errorCount > 0 ? (
                        <Badge variant="error" className="ml-2">
                          {trace.errorCount === 1 ? "1 error" : `${formatCompactNumber(trace.errorCount)} errors`}
                        </Badge>
                      ) : null}
                    </td>
                    <td className="font-mono text-[11.5px] text-ink-3">{formatTimestamp(trace.timestamp)}</td>
                    <td className="text-right font-mono text-[11.5px] text-ink-2">{formatLatency(trace.durationMs)}</td>
                    <td className="text-right font-mono text-[11.5px] text-ink-2">
                      {trace.totalCost === null ? "—" : formatTraceCost(trace.totalCost)}
                    </td>
                    <td className="text-right font-mono text-[11.5px] text-ink-2">
                      {trace.totalTokens === null ? "—" : formatCompactNumber(trace.totalTokens)}
                    </td>
                    <td className="text-ink-2">{trace.models.length > 0 ? trace.models.join(", ") : "—"}</td>
                    <td>
                      <div className="text-ink-2">{trace.userId ?? "—"}</div>
                      {trace.sessionId ? (
                        <div className="mt-0.5 font-mono text-[10.5px] text-ink-4">{trace.sessionId}</div>
                      ) : null}
                    </td>
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

function SummaryStrip({
  aggregates,
  error,
  range
}: {
  aggregates: AggregatesResponse | null;
  error: string | null;
  range: TimeRange;
}) {
  const rangeLabel = TIME_RANGE_OPTIONS.find((option) => option.value === range)?.label ?? "All time";
  const tiles: SummaryTile[] | null = aggregates ? summaryTiles(aggregates) : null;
  return (
    <section aria-label="Trace summary" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">Summary · {rangeLabel.toLowerCase()}</span>
        {error ? <span className="text-[11.5px] text-error">{error}</span> : null}
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-rule-soft bg-rule-soft lg:grid-cols-4">
        {(tiles ?? PLACEHOLDER_TILES).map((tile) => (
          <div key={tile.label} className="flex min-w-0 flex-col gap-1 bg-card px-4 py-3">
            <span className="text-[11.5px] text-ink-3">{tile.label}</span>
            <span
              className={cn(
                "font-sans text-[22px] font-semibold leading-none tracking-[-0.01em] text-ink",
                tiles === null && "text-ink-4"
              )}
            >
              {tile.value}
            </span>
            <span className="min-h-[14px] truncate font-mono text-[10.5px] text-ink-4">{tile.detail ?? ""}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const PLACEHOLDER_TILES: SummaryTile[] = [
  { label: "Traces", value: "—" },
  { label: "Tokens", value: "—" },
  { label: "Cost", value: "—" },
  { label: "Latency p50", value: "—" }
];

/** A non-negative number field; an invalid value is marked and left out of the request. */
function FloorInput({
  value,
  onChange,
  parse,
  placeholder
}: {
  value: string;
  onChange: (value: string) => void;
  parse: (value: string) => number | undefined;
  placeholder: string;
}) {
  const invalid = value.trim() !== "" && parse(value) === undefined;
  return (
    <Input
      type="number"
      inputMode="decimal"
      min={0}
      step="any"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-invalid={invalid}
      className={cn("w-full sm:w-[110px]", invalid && "border-error")}
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex w-full flex-col gap-1 sm:w-auto">
      <span className="eyebrow">{label}</span>
      {children}
    </label>
  );
}
