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

The existing `from`, `to`, `userId`, `sessionId`, `environment`, `tags` and `metadataKey`/`metadataValue` filters are unchanged. An empty or blank value (`?minCost=`) leaves a filter unset; an invalid value is a `400`. The explorer never sends a value the API would reject.

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

The observation-based filters scan the project's observations. Observations are partitioned by their own start time rather than the trace's timestamp, so the time range does not prune that scan. The page figures are one grouped query over at most 100 trace ids, using the observations' `trace_id` skip index.
