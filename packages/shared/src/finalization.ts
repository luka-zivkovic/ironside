/**
 * Platform default for the trace quiet-period watermark. Five minutes is
 * long enough to cover normal SDK batching/retry lag without making scheduled
 * consumers wait an operationally significant amount of time.
 */
export const DEFAULT_TRACE_QUIET_PERIOD_SECONDS = 5 * 60;

/** Returns the latest activity instant eligible for settled-only consumers. */
export function traceSettledBefore(
  quietPeriodSeconds: number,
  now: Date = new Date()
): string {
  return new Date(now.getTime() - quietPeriodSeconds * 1000).toISOString();
}
