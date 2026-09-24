# Web app v1

Status: implemented. Owner: `apps/web/src/`, `apps/web/vite.config.ts`, `apps/web/nginx.conf`, `apps/api/src/app.ts` (CORS).

## Purpose

`apps/web` is the operator's browser interface to a deployment: sign in as the owner, choose a project, explore and inspect its traces, and manage its machine credentials and configuration. It is a React 19 single-page app built with Vite, Tailwind CSS 4, Radix primitives and React Router 7.

## Access model

The browser authenticates only with the HttpOnly owner-session cookie; every API call is sent with `credentials: "include"`. The project is explicit in every URL (`/projects/:projectId/...`) and validated against the owner's project list. Machine credentials are created on the Connections page, shown once, and never stored by the app. Contracts: `spec/owner-auth-v1.md`, `spec/project-session-routing-v1.md`, `spec/scoped-machine-credentials-v1.md`.

- Before mounting, the app calls `GET /health`; if the API is unreachable it shows a retryable unavailable screen.
- `/setup`, `/login` and `/recover` are the owner-auth screens. Every other route requires a session; without one the app redirects to `/login` (or `/setup` before the owner exists) with a safe `next` path back.
- A `401` from any API call refreshes the session state and returns to `/login` with the current path as `next`.
- `/`, `/connections`, `/settings` and the legacy `/traces/:id` redirect to the same page in the last-used project (`ironside.lastProjectId` in local storage, a non-secret hint checked against the project list) or the first project. With no projects, the app shows the create-first-project screen.
- A project id the owner cannot see shows "Project not found".

## Screens

Canonical routes are `/projects/:projectId/traces`, `/projects/:projectId/traces/:traceId`, `/projects/:projectId/connections` and `/projects/:projectId/settings`. The sidebar's project switcher navigates to the chosen project's trace explorer, and the top bar's environment selector sets a project-wide `environment` URL filter (`spec/environments-v1.md`).

- **Trace explorer** (`screens/traces.tsx`), backed by `GET /api/v1/projects/:projectId/traces` and `/traces/aggregates`. Filters live in the URL so a filtered view can be shared. Text fields apply on submit (the button or Enter) rather than on every keystroke; selects apply at once. Search, the level, model, latency and cost filters, the per-trace columns and the summary tiles are specified in [`trace-search-v1.md`](./trace-search-v1.md); the summary covers the whole filtered set, not the current page. Pagination uses the API's opaque keyset cursor: the list returns only `nextCursor`, so the screen keeps a stack of visited cursors and "Previous" pops it. Cursors are not written to the URL. With no traces and no filters, the screen shows first-trace onboarding and polls every 3 seconds, up to 40 times, because ingest is queued and a trace appears only after the worker writes it.
- **Trace detail** (`screens/trace.tsx`), at the deep-linkable `/projects/:projectId/traces/:traceId`. It renders the observation tree with expand/collapse and depth-first keyboard navigation (arrow keys, Home, End), a type badge per observation and its duration (`endTime - startTime`). A resizable detail pane shows the selected observation's, or the trace's, input, output, usage, cost and metadata. String payloads render as readable source, lossless pretty JSON, or bounded sanitized Markdown depending on content, with the exact API value available as raw JSON; structured messages keep their interpreted view ([`markdown-payload-rendering-v1.md`](./markdown-payload-rendering-v1.md)). `ironside://media/<id>` references load through the owner-session media route (`spec/media-v1.md`). When the API has `IRONSIDE_RUBRIST_URL`, `GET /api/v1/viewer-config` returns it and the header shows "Open in Rubrist" ([`evaluator-integration-v1.md`](./evaluator-integration-v1.md#viewer-deep-links)).
- **Connections** (`screens/connections.tsx`): create Ingest or Integration credentials with optional expiry, reveal the token once, list and revoke credentials, and copy connection snippets.
- **Configuration** (`screens/settings.tsx`): list the organization's projects and create one (its initial Ingest credential is shown once), show or hide observed environments, edit per-project model prices (`spec/cost-pricing-v1.md`), and sign the owner out. Project quotas have no screen.

## API origin and CORS

The app calls the API with relative paths unless `VITE_API_URL` is set at build time. In development, the Vite server (port 5174) proxies `/api`, `/v1` and `/health` to `http://localhost:8788`; in the container, nginx proxies the same paths to the `api` service (`spec/self-host-release-v1.md`). Both are same-origin, so CORS applies only when the app is served from a different origin than the API.

The API's CORS middleware (`hono/cors`) allows exactly the origins in `WEB_ORIGINS` (comma-separated, default `http://localhost:5174`), with credentials, the `Content-Type` and `Authorization` headers, the `GET`, `POST`, `PATCH`, `DELETE` and `OPTIONS` methods, and a 600-second preflight cache. Each origin must be an exact `http(s)` origin with no path or wildcard; the API refuses to start otherwise. Owner-session mutations additionally require an allowed `Origin` and reject cross-site Fetch Metadata (`spec/owner-auth-v1.md`).

## Design tokens

`src/styles.css` maps design tokens into Tailwind v4 through `@theme inline`. Ironside shares Rubrist's paper and ink tokens, geometry, typography (Geist Sans and Geist Mono) and component rhythm, and uses a steel-blue `signal` accent to distinguish the data plane from Rubrist's judgment layer. The light theme is the default; a `.dark` class supplies the dark palette, toggled from the sidebar and top bar.

## Verified

`apps/web/test` covers the pure logic and server-rendered components: project URL context and shareable filters (`project-context.test.ts`, `trace-filters.test.ts`), tree keyboard navigation (`trace-tree-nav.test.ts`), the split layout (`trace-layout.test.ts`), the trace record view and its Rubrist link (`trace-record-view.test.ts`), payload and Markdown rendering, connection snippets, and the owner setup screen. On the API side, `apps/api/test/contract.test.ts` checks that the trace list, tree and aggregates responses parse with the schemas the web app uses, including observation nesting, and `apps/api/test/projects.test.ts` covers the owner-session boundary: `401` without a session, the same `404` for foreign and unknown projects, removed flat routes, rejected cross-site mutations, and `viewer-config`.

## History

- M7-01 built the first read-only trace list and tree viewer. The browser then sent a project API key, and CORS was added without credentials. Project and key management screens came later.
- #63–#65 moved the app to owner sessions, project-explicit URLs and scoped machine credentials; CORS now allows credentials for the configured origins only.
- #66 added the project-wide environment selector and observed-environment management (`spec/environments-v1.md`). Media rendering, safe Markdown payload rendering, Rubrist deep links, model prices, and trace search with its summary tiles were added by their own specs.
- The first design used a separate graphite palette with dark mode as the default. The app now shares Rubrist's paper and ink tokens with its own steel-blue accent, and defaults to light.
- The M7-01 check verified the wire contract against a live stack but not browser rendering, because no browser tool was available. The trace explorer has since been checked in a real browser as part of the search and filters work (`spec/trace-search-v1.md`).
- Still open: no automated full-browser end-to-end suite drives owner setup, project creation, ingestion, filtering and trace navigation in one scenario.
