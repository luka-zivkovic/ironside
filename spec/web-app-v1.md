# Web app v1 (M7-01)

> Issue #66 subsequently added the project-global URL environment selector and observed-value management described in `spec/environments-v1.md`.

Status: implemented; authentication and project routing updated by issues #63–#65.

## Purpose

The first slice of `apps/web`: a React 19 + Vite + Tailwind 4 + Radix SPA (mirroring coeval's stack and conventions) that gives an operator a place to browse traces without curling the API directly. Scoped to the read-only trace-viewing DoD item first; project/API-key CRUD screens are a separate follow-up batch since no API routes exist yet to back them (see "Not yet done" below).

## Auth model

The browser uses only the HttpOnly owner-session cookie. Project context is
explicit in `/projects/:projectId/...` URLs and validated against the owner's
organization. Machine credentials are created on the Connections page,
displayed once, and never persisted by the SPA. See
`spec/project-session-routing-v1.md`.

## CORS

Ironside's API previously had zero CORS configuration (`apps/api/src/app.ts`) — never needed, since every prior consumer (SDKs, importers, curl) is server-to-server. A browser SPA changes that: without CORS headers, the browser blocks the response before the page's JS ever sees it, regardless of whether the `Authorization` header was correct. Added `hono/cors` (already bundled with the installed `hono` version, no new dependency) with an explicit allowed-origin list from `Config.webOrigins` (env `WEB_ORIGINS`, comma-separated, defaults to `http://localhost:5174`) rather than a wildcard — `credentials` is not enabled since there are no cookies to protect, but an explicit origin list is still the correct default over `*` for a self-hosted product where the operator's actual web app origin is knowable.

In dev, this mostly doesn't matter in practice: `apps/web/vite.config.ts` proxies `/api` and `/health` to the API's port 8788, so the browser sees same-origin requests and CORS never triggers — same pattern as coeval's dev proxy. CORS becomes load-bearing once the web app is served from a different origin than the API (e.g. a production self-host where they're on different ports/hosts, or a Docker Compose setup that doesn't front both behind one reverse proxy).

## Design tokens — deliberately not a copy of coeval's

Coeval's `apps/web` uses a bespoke "paper & ink" warm/editorial palette (custom CSS variables: `--paper`, `--ink`, `--signal` orange, serif headers). Ironside's `src/styles.css` mirrors the *mechanical* structure exactly (Tailwind v4 `@theme inline` mapping, light/dark via `.dark` class, the same token-naming scheme: `ink-*`/`paper-*`/`rule-*`/`signal`) but with Ironside's own distinct palette: cool graphite/slate base, wire-blue signal accent, monospace-forward (no serif) — an infra/observability tool's aesthetic, not an editorial one, and dark-mode-default rather than light-mode-default since this is a tool engineers live in while debugging traces. Reusing coeval's exact palette would make the two products visually indistinguishable, which is wrong for two separate products in the same author's suite.

## Screens

- `screens/traces.tsx` — the trace list. Filters apply on a button click (not on every keystroke, to avoid a request per character), backed by the owner-session `GET /api/v1/projects/:projectId/traces` route. Pagination uses the API's opaque keyset cursor: a `cursorStack` of previously-visited cursors makes "Previous" possible (the list API only returns a `nextCursor`, not a `prevCursor`) by popping the last-pushed cursor rather than re-deriving it.
- `screens/trace.tsx` — the tree viewer. Recursively renders `ObservationNode.children` with accessible expand/collapse and depth-first keyboard navigation, a type badge (span/generation/event), computed duration (`endTime - startTime`), and a resizable detail pane showing the selected node's (or the trace's, if nothing selected) input/output/usage/cost/metadata. String payloads default to readable source, losslessly pretty JSON, or bounded sanitized Markdown according to content, with the exact API value available as Raw JSON; structured messages retain their interpreted view. The rendering modes and untrusted-content boundary are specified in [`markdown-payload-rendering-v1.md`](./markdown-payload-rendering-v1.md).
- `screens/connections.tsx` / `screens/settings.tsx` — scoped machine credential management, project quotas, and environment discovery preferences.

## Verified against a real, running stack — not just a build check

The current application is covered by repository build, typecheck, API contract, and web rendering tests. The live flow starts with owner setup, creates a project plus its one-time Ingest credential, sends traces with that machine credential, and reads them through the HttpOnly owner session and explicit project route. The contract checks prove that:
- The CORS preflight (`OPTIONS` with `Origin: http://localhost:5174`) returns the correct `Access-Control-Allow-*` headers, and a request from an untrusted origin gets no `Access-Control-Allow-Origin` header at all (rejected).
- `GET /api/v1/projects/:projectId/traces` and `GET /api/v1/projects/:projectId/traces/:id` return exactly the JSON shape `listTracesResponseSchema`/`traceTreeResponseSchema` expect the frontend to `.parse()` — including correct parent/child observation nesting.
- A missing or invalid owner session gets a real `401`, foreign projects are non-enumerating `404`s, and the Vite dev proxy correctly forwards both `/health` and `/api/v1/*` to the API server same-origin.
- `checkHealth()`'s target (`GET /health`) is reachable and reports all four stores healthy.

This is real proof the wire contract the frontend was built against is correct, not an assumption. What this does NOT cover: actual browser rendering (the Claude-in-Chrome browser tool was unavailable in this environment — extension not connected), so visual layout, click interactions, and React state transitions were verified by careful code re-reading (cursor pagination push/pop logic, the `cancelled` race guard in `traces.tsx`'s fetch effect, the `onUnauthorized` 401 handler wiring) rather than by driving an actual browser. This is a real gap, flagged rather than glossed over.

## Remaining test gap

There is still no automated full-browser end-to-end suite that drives owner setup, project creation, ingestion, filtering, and trace navigation in one scenario. Component/SSR tests, API integration tests, schema validation, and typechecking cover the individual boundaries meanwhile.
