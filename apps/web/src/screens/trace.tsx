import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ObservationNode, TraceTreeResponse } from "@ironside/shared/browser";
import { ApiError, MEDIA_REF_PATTERN, fetchMediaBlob, fetchTraceTree } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { PayloadViewer } from "@/components/payload-viewer";
import { formatJsonText } from "@/lib/json-text";
import {
  MAX_TREE_SHARE,
  MIN_TREE_SHARE,
  clampTreeShare,
  preferredTreeShare,
  treeShareFromPointer
} from "@/lib/trace-layout";
import { flattenVisibleObservations, traceTreeCommand } from "@/lib/trace-tree-nav";
import { cn, formatDurationMs, formatTimestamp } from "@/lib/utils";
import { useActiveProject } from "@/lib/projects";

export function TraceScreen() {
  const { project } = useActiveProject();
  const { id } = useParams<{ id: string }>();
  const [trace, setTrace] = useState<TraceTreeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setTrace(null);
    setError(null);
    fetchTraceTree(project.id, id)
      .then((response) => {
        if (!cancelled) setTrace(response);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Failed to load trace");
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, id]);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Card className="p-6 text-[12.5px] text-error">{error}</Card>
      </div>
    );
  }

  if (!trace) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Card className="p-6 text-[12.5px] text-ink-3">Loading trace…</Card>
      </div>
    );
  }

  return <TraceRecordView trace={trace} />;
}

export function TraceRecordView({ trace }: { trace: TraceTreeResponse }) {
  const [selected, setSelected] = useState<ObservationNode | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const splitRef = useRef<HTMLDivElement>(null);
  const treeItemRefs = useRef(new Map<string, HTMLDivElement>());
  const manuallyResizedRef = useRef(false);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [treeShare, setTreeShare] = useState(() =>
    preferredTreeShare(trace.input !== null || trace.output !== null)
  );
  const visibleObservations = useMemo(
    () => flattenVisibleObservations(trace.observations, collapsedIds),
    [collapsedIds, trace.observations]
  );
  const firstVisibleId = visibleObservations[0]?.node.id ?? null;

  const detailHasPayload = selected
    ? selected.input !== null || selected.output !== null
    : trace.input !== null || trace.output !== null;

  useEffect(() => {
    if (!manuallyResizedRef.current) {
      setTreeShare(preferredTreeShare(detailHasPayload));
    }
  }, [detailHasPayload, selected?.id]);

  function updateTreeShare(clientX: number) {
    const bounds = splitRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setTreeShare(treeShareFromPointer(clientX, bounds.left, bounds.width));
  }

  function finishResize() {
    draggingRef.current = false;
    setDragging(false);
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const containerWidth = splitRef.current?.clientWidth ?? 1_200;
    let nextShare: number | null = null;

    if (event.key === "ArrowLeft") nextShare = treeShare - 2;
    if (event.key === "ArrowRight") nextShare = treeShare + 2;
    if (event.key === "Home") nextShare = MIN_TREE_SHARE;
    if (event.key === "End") nextShare = MAX_TREE_SHARE;
    if (nextShare === null) return;

    event.preventDefault();
    manuallyResizedRef.current = true;
    setTreeShare(clampTreeShare(nextShare, containerWidth));
  }

  function focusObservation(id: string) {
    const entry = visibleObservations.find(({ node }) => node.id === id);
    if (!entry) return;
    setSelected(entry.node);

    const moveFocus = () => {
      const element = treeItemRefs.current.get(id);
      element?.focus();
      element?.scrollIntoView({ block: "nearest" });
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(moveFocus);
    else moveFocus();
  }

  function toggleObservation(id: string) {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleObservationKeyDown(event: KeyboardEvent<HTMLDivElement>, node: ObservationNode) {
    // Nested treeitems bubble keyboard events through their ancestors. Only
    // the item that owns DOM focus should interpret the command.
    if (event.target !== event.currentTarget) return;
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
    }

    const command = traceTreeCommand(event.key, node.id, visibleObservations, collapsedIds);
    if (!command) return;
    if (command.type === "focus") {
      focusObservation(command.id);
      return;
    }
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (command.type === "expand") next.delete(command.id);
      else next.add(command.id);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <BackLink />
      <PageHeader
        eyebrow="Trace record · reconstructed"
        title={trace.name ?? <span className="text-ink-4 italic">unnamed trace</span>}
        description={<span className="font-mono text-[11px]">{trace.id}</span>}
      />

      <div
        ref={splitRef}
        className={cn("trace-record-split min-w-0 items-start", dragging && "trace-record-split--dragging")}
        style={{ "--trace-tree-share": `${treeShare}%` } as CSSProperties}
      >
        <Card className="min-w-0">
          <CardHeader className="flex-col items-start gap-1 border-b border-rule-soft">
            <div className="eyebrow">Execution path</div>
            <CardTitle>Observation tree</CardTitle>
          </CardHeader>
          <CardContent className="p-2">
            {trace.observations.length === 0 ? (
              <div className="p-4 text-[12.5px] text-ink-3">This trace has no observations.</div>
            ) : (
              <div className="flex flex-col" role="tree" aria-label="Observation tree">
                {trace.observations.map((node) => (
                  <TreeNode
                    key={node.id}
                    node={node}
                    depth={0}
                    selectedId={selected?.id ?? null}
                    firstVisibleId={firstVisibleId}
                    collapsedIds={collapsedIds}
                    itemRefs={treeItemRefs.current}
                    onSelect={setSelected}
                    onFocusObservation={focusObservation}
                    onToggle={toggleObservation}
                    onKeyDown={handleObservationKeyDown}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div
          className="trace-record-resizer"
          role="separator"
          aria-label="Resize observation tree and record inspector"
          aria-orientation="vertical"
          aria-valuemin={MIN_TREE_SHARE}
          aria-valuemax={MAX_TREE_SHARE}
          aria-valuenow={Math.round(treeShare)}
          tabIndex={0}
          title="Drag to resize. Double-click to restore the default split."
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            manuallyResizedRef.current = true;
            draggingRef.current = true;
            setDragging(true);
            event.currentTarget.setPointerCapture(event.pointerId);
            updateTreeShare(event.clientX);
          }}
          onPointerMove={(event) => {
            if (!draggingRef.current) return;
            event.preventDefault();
            updateTreeShare(event.clientX);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            finishResize();
          }}
          onPointerCancel={finishResize}
          onDoubleClick={() => {
            manuallyResizedRef.current = false;
            setTreeShare(preferredTreeShare(detailHasPayload));
          }}
          onKeyDown={handleResizeKeyDown}
        >
          <span aria-hidden="true" />
        </div>

        <Card className="trace-record-inspector min-w-0">
          <CardHeader className="flex-col items-start gap-1 border-b border-rule-soft">
            <div className="eyebrow">Record inspector</div>
            <CardTitle>{selected ? "Observation" : "Trace"} detail</CardTitle>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-3">
            {selected ? <ObservationDetail node={selected} /> : <TraceDetail trace={trace} />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function BackLink() {
  const { project } = useActiveProject();
  const location = useLocation();
  return (
    <Link
      to={`/projects/${encodeURIComponent(project.id)}/traces${location.search}`}
      className="w-fit font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3 hover:text-signal"
    >
      ← Back to traces
    </Link>
  );
}

function TreeNode({
  node,
  depth,
  selectedId,
  firstVisibleId,
  collapsedIds,
  itemRefs,
  onSelect,
  onFocusObservation,
  onToggle,
  onKeyDown
}: {
  node: ObservationNode;
  depth: number;
  selectedId: string | null;
  firstVisibleId: string | null;
  collapsedIds: ReadonlySet<string>;
  itemRefs: Map<string, HTMLDivElement>;
  onSelect: (node: ObservationNode) => void;
  onFocusObservation: (id: string) => void;
  onToggle: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, node: ObservationNode) => void;
}) {
  const hasChildren = node.children.length > 0;
  const open = hasChildren && !collapsedIds.has(node.id);
  const selected = selectedId === node.id;
  const tabStop = selected || (selectedId === null && firstVisibleId === node.id);
  const durationMs =
    node.endTime && node.startTime
      ? new Date(node.endTime).getTime() - new Date(node.startTime).getTime()
      : null;

  return (
    <div
      ref={(element) => {
        if (element) itemRefs.set(node.id, element);
        else itemRefs.delete(node.id);
      }}
      role="treeitem"
      aria-label={`${node.name ?? "unnamed"}, ${node.type}${node.model ? `, ${node.model}` : ""}, ${formatDurationMs(durationMs)}`}
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={hasChildren ? open : undefined}
      tabIndex={tabStop ? 0 : -1}
      className="trace-tree-item outline-none"
      onFocus={(event) => {
        if (event.target === event.currentTarget) onSelect(node);
      }}
      onKeyDown={(event) => onKeyDown(event, node)}
    >
      <div
        className={cn(
          "trace-tree-row flex w-full cursor-pointer items-center gap-1.5 border-b border-rule-soft px-2 py-2 text-left text-[12.5px] transition-colors",
          selected
            ? "bg-signal-wash text-ink shadow-[inset_3px_0_0_var(--signal)] hover:bg-signal-wash"
            : "hover:bg-card-2"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onFocusObservation(node.id)}
      >
        {hasChildren ? (
          <span
            aria-hidden="true"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onFocusObservation(node.id);
              onToggle(node.id);
            }}
            className="flex min-h-6 min-w-6 shrink-0 cursor-pointer items-center justify-center text-ink-4 hover:text-ink"
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </span>
        ) : (
          <span className="w-6 shrink-0" />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <TypeBadge type={node.type} />
          <span className="truncate">{node.name ?? <span className="text-ink-4 italic">unnamed</span>}</span>
          {node.model ? <span className="ml-1 shrink-0 font-mono text-[10.5px] text-ink-4">{node.model}</span> : null}
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-4">{formatDurationMs(durationMs)}</span>
        </div>
      </div>
      {open ? (
        <div role="group">
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              firstVisibleId={firstVisibleId}
              collapsedIds={collapsedIds}
              itemRefs={itemRefs}
              onSelect={onSelect}
              onFocusObservation={onFocusObservation}
              onToggle={onToggle}
              onKeyDown={onKeyDown}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TypeBadge({ type }: { type: ObservationNode["type"] }) {
  const variant = type === "generation" ? "signal" : type === "event" ? "warn" : "default";
  return (
    <Badge variant={variant} className="shrink-0">
      {type}
    </Badge>
  );
}

function ObservationDetail({ node }: { node: ObservationNode }) {
  return (
    <>
      <DetailRow label="ID" value={node.id} mono />
      <DetailRow label="Type" value={node.type} />
      <DetailRow label="Start" value={formatTimestamp(node.startTime)} />
      <DetailRow label="End" value={node.endTime ? formatTimestamp(node.endTime) : "—"} />
      <DetailRow label="Model" value={node.model ?? "—"} />
      {Object.keys(node.usageDetails).length > 0 ? (
        <DetailBlock label="Usage" value={node.usageDetails} />
      ) : null}
      {Object.keys(node.costDetails).length > 0 ? <DetailBlock label="Cost" value={node.costDetails} /> : null}
      {node.input !== null ? <JsonBlock label="Input" value={node.input} /> : null}
      {node.output !== null ? <JsonBlock label="Output" value={node.output} /> : null}
      {Object.keys(node.metadata).length > 0 ? <DetailBlock label="Metadata" value={node.metadata} /> : null}
    </>
  );
}

function TraceDetail({ trace }: { trace: TraceTreeResponse }) {
  return (
    <>
      <DetailRow label="Timestamp" value={formatTimestamp(trace.timestamp)} />
      <DetailRow label="User" value={trace.userId ?? "—"} />
      <DetailRow label="Session" value={trace.sessionId ?? "—"} />
      {trace.tags.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="eyebrow">Tags</span>
          <div className="flex flex-wrap gap-1">
            {trace.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        </div>
      ) : null}
      {trace.input !== null ? <JsonBlock label="Input" value={trace.input} /> : null}
      {trace.output !== null ? <JsonBlock label="Output" value={trace.output} /> : null}
      {Object.keys(trace.metadata).length > 0 ? <DetailBlock label="Metadata" value={trace.metadata} /> : null}
    </>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="eyebrow">{label}</span>
      <span className={cn("text-[12.5px] break-all", mono && "font-mono text-[11.5px]")}>{value}</span>
    </div>
  );
}

const MAX_FORMATTED_METADATA_JSON_FIELDS = 8;
const MAX_FORMATTED_METADATA_JSON_SOURCE_LENGTH = 64_000;
const MAX_FORMATTED_METADATA_JSON_OUTPUT_LENGTH = 100_000;

function DetailBlock({ label, value }: { label: string; value: Record<string, number | string> }) {
  const rows = prepareDetailRows(value);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="eyebrow">{label}</span>
      <div className="min-w-0 overflow-hidden rounded-sm border border-rule-soft bg-card-2 p-2 font-mono text-[11px]">
        {rows.map(({ key, displayValue, formattedJson }) => {
          const isLongValue = formattedJson !== null || displayValue.length > 40;
          return (
            <div
              key={key}
              className={cn(
                "min-w-0",
                isLongValue
                  ? "flex flex-col gap-1 border-t border-rule-soft py-2 first:border-t-0 first:pt-0 last:pb-0"
                  : "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3"
              )}
            >
              {formattedJson !== null ? (
                <>
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="min-w-0 text-ink-3 [overflow-wrap:anywhere]">{key}</span>
                    <span className="shrink-0 text-[9.5px] uppercase tracking-[0.06em] text-ink-4">JSON</span>
                  </div>
                  <pre className="max-h-[280px] min-w-0 overflow-auto rounded-sm border border-rule-soft bg-paper-2 p-2 leading-[1.55] whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {formattedJson}
                  </pre>
                </>
              ) : (
                <>
                  <span className="min-w-0 text-ink-3 [overflow-wrap:anywhere]">{key}</span>
                  <span
                    className={cn(
                      "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]",
                      !isLongValue && "text-right"
                    )}
                  >
                    {displayValue}
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function prepareDetailRows(value: Record<string, number | string>) {
  let formattedFieldCount = 0;
  let remainingSourceLength = MAX_FORMATTED_METADATA_JSON_SOURCE_LENGTH;
  let remainingOutputLength = MAX_FORMATTED_METADATA_JSON_OUTPUT_LENGTH;

  return Object.entries(value).map(([key, rawValue]) => {
    const displayValue = String(rawValue);
    let formattedJson: string | null = null;
    if (
      typeof rawValue === "string" &&
      formattedFieldCount < MAX_FORMATTED_METADATA_JSON_FIELDS &&
      displayValue.length <= remainingSourceLength
    ) {
      remainingSourceLength -= displayValue.length;
      const candidate = formatJsonText(displayValue);
      if (candidate !== null && candidate.length <= remainingOutputLength) {
        formattedJson = candidate;
        formattedFieldCount += 1;
        remainingOutputLength -= candidate.length;
      }
    }
    return { key, displayValue, formattedJson };
  });
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const mediaIds = extractMediaIds(value);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="eyebrow">{label}</span>
      <PayloadViewer value={value} />
      {mediaIds.map((mediaId) => (
        <MediaPreview key={mediaId} mediaId={mediaId} />
      ))}
    </div>
  );
}

// Media refs ("ironside://media/<ulid>") embedded anywhere in the JSON —
// string scan over the serialized value, so refs nested at any depth are
// found without walking the object shape.
function extractMediaIds(value: unknown): string[] {
  const text = JSON.stringify(value);
  if (!text || !text.includes("ironside://media/")) return [];
  return [...new Set([...text.matchAll(MEDIA_REF_PATTERN)].map((match) => match[1]!))];
}

function MediaPreview({ mediaId }: { mediaId: string }) {
  const { project } = useActiveProject();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [contentType, setContentType] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    fetchMediaBlob(project.id, mediaId)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
        setContentType(blob.type);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [project.id, mediaId]);

  if (failed) {
    return (
      <span className="font-mono text-[10px] text-ink-4">
        media {mediaId}: unavailable
      </span>
    );
  }
  if (!objectUrl) return null;

  if (contentType?.startsWith("image/")) {
    return (
      <img
        src={objectUrl}
        alt={`media ${mediaId}`}
        className="max-h-[240px] max-w-full self-start rounded-sm border border-rule-soft object-contain"
      />
    );
  }
  return (
    <a
      href={objectUrl}
      download={mediaId}
      className="font-mono text-[11px] text-ink-2 underline underline-offset-2"
    >
      download media ({contentType || "unknown type"})
    </a>
  );
}
