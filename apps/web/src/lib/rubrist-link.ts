// Shared cross-product deep-link contract with Rubrist. Rubrist resolves the
// trace through the same identity it reads from `ironside/evaluator/v1`:
// the Ironside project id, trace id, and (when known) publication version.
// See spec/evaluator-integration-v1.md "Viewer deep links".
export interface RubristTraceLinkInput {
  projectId: string;
  traceId: string;
  traceVersion?: string | null;
}

export function rubristTraceLink(rubristUrl: string, input: RubristTraceLinkInput): string {
  const search = new URLSearchParams({
    source: "ironside",
    project: input.projectId,
    trace: input.traceId
  });
  if (input.traceVersion) search.set("version", input.traceVersion);
  return `${rubristUrl.replace(/\/+$/, "")}/links/trace?${search.toString()}`;
}

/** Stable Ironside viewer path for one trace, relative to the web app's origin. */
export function ironsideTracePath(projectId: string, traceId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}`;
}
