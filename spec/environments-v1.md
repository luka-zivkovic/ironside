# Observed environments v1

Issue #66 implements the environment decision from #61. An environment is a
case-sensitive trace attribute inside one project. It is never an
authorization, credential, retention, quota, destination, or configuration
boundary. Use environments when those policies are shared; use separate
projects when any policy or isolation boundary differs.

## Canonical value

Every supported source uses `normalizeEnvironment` from
`packages/shared/src/environment.ts`:

1. accept a string only;
2. normalize Unicode to NFC;
3. trim surrounding Unicode whitespace;
4. preserve case;
5. reject empty values, unpaired UTF-16 surrogates, and control/format characters;
6. reject values longer than 64 Unicode code points.

Values are never lowercased, truncated, slugged, or replaced with a synthetic
`default`/`other` value. An invalid optional source value is omitted while the
otherwise-valid trace remains ingestible; the immutable raw envelope still
contains the original source evidence. Filter inputs use the strict schema and
return 400 when invalid.

Source precedence is fixed:

- native trace input: `environment`;
- OTLP root-span resource: `deployment.environment.name`, with deprecated
  `deployment.environment` used only when the current attribute is absent;
- LangFuse-compatible ingestion and LangFuse historical detail: their explicit
  `environment` field;
- LangSmith: no environment is inferred from metadata, session, tags, project,
  host, or credential.

If the current OTLP attribute is present but invalid, the legacy attribute does
not silently override it.

## Truth, discovery, and capacity

`traces.environment` in ClickHouse is authoritative. Postgres
`project_environments` is an eventually consistent, rebuildable discovery
projection containing a retained trace-time range and one `hidden` preference.
Normal `GET .../environments` requests read only Postgres; they never execute
`DISTINCT ... FINAL` against ClickHouse.

The worker observes environments only after successful ClickHouse trace writes.
At-least-once updates use `least(first_seen_at)`/`greatest(last_seen_at)`.
Admission, hide/show, and rebuild finalization share one project advisory lock.
The registry admits at most 100 names per project:

- known names continue updating at capacity;
- a novel overflow value stays on its trace and is exactly queryable, but is
  omitted from discovery;
- hiding does not free capacity;
- overflow is recorded in project registry state and
  `ironside_environment_registry_overflow_total{source="live"|"rebuild"}`;
- project ids and raw environment values are never metric labels.

`firstSeenAt`/`lastSeenAt` mean the earliest/latest retained trace timestamps,
not lifetime history. A successful rebuild removes a name with no retained
trace and forgets its hide preference; if it later reappears, it is visible.

## Rebuild

The separately claimable worker scheduler lane and the operator command use a
bounded keyset scan of `traces FINAL`, ordered by `(timestamp, id)` descending.
Each chunk reads at most 2,000 rows and checkpoints its cursor plus at most 100
candidate names in Postgres. Encountering candidate 101 proves overflow and
ends discovery without another checkpoint. Only the selected 100 names plus at
most 100 registry names observed after the scan watermark enter a bounded exact
`min(timestamp)`/`max(timestamp)` query.

Finalization acquires the project advisory lock before that exact ClickHouse
stats query and holds it through the Postgres swap. It adds live registry names
whose trace-observation watermark is newer than the rebuild watermark,
preserves hide state for retained names, and advances the daily schedule. This
makes the returned ranges retention-accurate without a stats-to-swap race: an
ingest that reaches Postgres before the lock is included in exact stats; one
that arrives later waits and applies after commit. Visibility changes do not
advance the observation watermark. A failed or limited ClickHouse scan leaves
the old registry intact and retries later.

Manual repair:

```bash
docker compose exec -e ENVIRONMENT_REGISTRY_PROJECT_ID=proj_... worker \
  node apps/worker/dist/src/scripts/environment-registry-rebuild.js
```

Normalization is forward-only. Old stored values whose canonical spelling
would differ are not silently rewritten or falsely registered under an exact
filter that cannot match them; an operator may perform a deliberate data
maintenance migration after auditing retained values.

## API and UI

Owner-session routes:

- `GET /api/v1/projects/:projectId/environments`
- `PATCH /api/v1/projects/:projectId/environments/visibility`
  with `{ "environment": "production", "hidden": true }`

PATCH updates an existing observed row or returns 404; it cannot manually create
an environment. Machine credentials cannot mutate discovery preferences.

Native list and aggregate queries accept one exact `environment` parameter and
always combine it with the mandatory project predicate. The registry is never
joined into those queries. Hidden and overflow-only names therefore remain
directly queryable, and an unfiltered query still includes every environment.

The SPA stores the global selection as `?environment=...`, preserves it across
project-local navigation and trace detail/back links, and clears it on project
switch. The selector shows visible registry names plus a synthetic selected
option for a hidden, overflow-only, or not-yet-observed deep link. Applying or
clearing user/session/tag filters does not erase the environment parameter.

## Verification

Tests cover normalization boundaries and Unicode, native/OTLP/LangFuse mapping,
OTLP precedence, exact list/aggregate agreement, project isolation, concurrent
100-row admission, updates at capacity, owner-only visibility, no manual
creation, worker observation ordering, resumable retained-data rebuilds,
hide-preserving deletion of expired names, 101-value overflow, bounded metrics,
and URL/deep-link preservation. The existing Node-only web test setup still
does not provide browser component interaction tests; pure URL/option helpers
and the full TypeScript build pin that state contract.
