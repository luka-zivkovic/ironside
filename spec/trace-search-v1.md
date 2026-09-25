# Trace search and filters v1

Status: implemented. Owner: `packages/clickhouse/src/queries.ts` (`buildTraceConditions`, `listTraceMetrics`), `packages/shared/src/query.ts`, `apps/api/src/routes/traces.ts`, `apps/web/src/lib/trace-filters.ts`, `apps/web/src/screens/traces.tsx`.

## Contract

`GET /api/v1/projects/:projectId/traces` and `GET /api/v1/projects/:projectId/traces/aggregates` accept the same filters, and the aggregates always describe exactly the traces the list returns. Filters combine with AND.

| Parameter | Matches traces that… |
| --- | --- |
| `search` (≤ 200 chars) | have the text, case-insensitively, in the trace's name, input or output, or in any observation's name, input or output; or whose id equals it exactly |
| `level` (`debug`, `default`, `warning`, `error`) | have at least one observation at that level |
| `model` | have at least one observation with exactly that model |
| `minDurationMs` (integer ≥ 0) | have a duration of at least this many milliseconds |
| `minCost` (≥ 0, USD) | have a total cost of at least this |

The existing `from`, `to`, `userId`, `sessionId`, `environment`, `tags` and `metadataKey`/`metadataValue` filters are unchanged. An empty or blank value (`?minCost=`) leaves a filter unset; an invalid value is a `400`. The explorer's inputs keep values within these limits, and it cuts search and model text from a shared link to the limit; other hand-edited URL values can still be rejected.

Inputs and outputs are searched as their stored JSON text. A search for text that JSON escapes (a quote, a backslash, a line break) must be written in its escaped form.

### Per-trace figures

Each listed trace carries figures computed from its observations, with the same rules the filters use:

- `durationMs`: the first observation start to the last observation end. `null` when no observation has ended, so `minDurationMs` never matches such a trace. This is the definition the latency percentiles in the aggregates use.
- `totalCost`: the sum over observations of each observation's `total` cost, or the sum of its cost components when it has no `total`. The sum is exact (ClickHouse `Decimal`), so a trace costing exactly the `minCost` floor matches it. `null` when no observation reports a cost.
- `totalTokens`: the sum over observations of each observation's `total_tokens`, or its `input_tokens` plus `output_tokens`. Other usage keys, such as cache reads, can overlap those and are not added. `null` when no observation reports any of the three.
- `errorCount`: observations at level `error`.
- `models`: the distinct models of the observations, sorted.

A trace with no observations has `null` figures, an `errorCount` of 0 and no models.

The aggregates' `tokenTotals` and `costTotals` stay per-key sums across all observations. The explorer's summary tiles collapse those with their own key rules, so a tile can differ from the sum of the rows when observations in the set report different keys.

## Viewer

The trace explorer shows a search box and level, model, minimum latency (seconds) and minimum cost (USD) filters beside the existing ones, and adds latency, cost, tokens and models columns plus an error badge on the name. Filters live in the URL (`q`, `level`, `model`, `minLatency`, `minCost`), so a filtered view can be shared. Only valid floors are written to the URL. The model field suggests the models seen on the current page.

## Cost

The observation-based filters read the project's observations. Observations are keyed by their own start time rather than the trace's timestamp, and an observation can start on another day or month than its trace, so the time range cannot bound them directly. When any trace-level condition applies (time range, user, session, environment, tags or metadata), each observation filter reads only the observations of the traces those conditions select, as `prewhere trace_id in (select id from traces final where ...)`:

- Only `trace_id` is read across the project's history; the filtered columns (names, inputs and outputs for search; start, end and cost for the duration and cost floors) are read only for those traces.
- The results are exact, since the outer query requires the same conditions.
- The PREWHERE runs before FINAL, which is safe because `trace_id` is part of the observations' sort key: every version of an observation, deletions included, has the same `trace_id` and is kept or dropped together.
- The `trace_id` skip index does not help here: with thousands of traces in range, every granule may contain one of them.

With no trace-level condition ("All time" and nothing else), the filters read all of the project's observations, as the question requires.

Measured on a synthetic project of 400,000 traces and 4 million observations over 90 days (ClickHouse 25.3, laptop, median of three list requests):

| Filter | List before | List after | Aggregates before | Aggregates after |
| --- | --- | --- | --- | --- |
| Last 24 hours + search in observation inputs | 302 ms | 56 ms | 1,387 ms | 201 ms |
| Last 24 hours + model | 154 ms | 46 ms | 538 ms | 292 ms |
| Last 24 hours + minimum duration | 259 ms | 34 ms | 690 ms | 299 ms |
| Last 24 hours + minimum cost | 236 ms | 37 ms | 734 ms | 262 ms |
| Last 7 days + model + level | 239 ms | 114 ms | 840 ms | 376 ms |
| One user (all time) + model | 199 ms | 100 ms | 689 ms | 437 ms |
| All time + model | 212 ms | 217 ms | 882 ms | 840 ms |

For the 24-hour search, bytes read dropped from 2.45 GiB to 189 MiB. The saving grows with the project's history, since the rows outside the range cost only their `trace_id`. The page figures are one grouped query over at most 100 trace ids, using the observations' `trace_id` skip index.

## Verified

`packages/clickhouse/test/trace-filter-scope.test.ts` checks each observation filter, alone and combined, with a time range or a user: it matches traces whose observations start months before or after the range, leaves out a trace outside the range whose observation falls inside it, and uses only an observation's latest version (changed, deleted, or moved to another day). Without a trace-level condition, every trace matches. `apps/api/test/trace-search.test.ts` runs the list and aggregates routes against real ClickHouse and Postgres. It covers each filter alone and combined, with the aggregates counting the same traces as the list, the per-trace figures (including traces with no observations and no ended observation), an exact decimal cost floor, blank values leaving filters unset, and invalid values returning 400. `apps/web/test/trace-filters.test.ts` covers the URL round trip, floor parsing and limits, the conversion to API units, and clearing. The explorer was also checked in a browser against a seeded project: the columns, a search combined with the level filter, and the summary tiles following the filters.
