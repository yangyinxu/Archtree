# Architecture standards

These rules decide where code, tests, and documents live in this repository and
which modules may depend on which. They apply to every new file and to every file
a change moves. When a change needs to break a rule, update this document in the
same change and say why.

Product behavior is defined in [business-rules.md](../business-rules.md); the
topic documents in this folder describe how specific subsystems implement it.

<!-- @catalog -->
**Contents**

- [Repository layout](#repository-layout)
- [Server layers](#server-layers)
  - [Service domains](#service-domains)
  - [Dependency rules](#dependency-rules)
- [Web client (web/src)](#web-client-websrc)
- [Tests](#tests)
- [Naming](#naming)
- [File size and catalogs](#file-size-and-catalogs)
- [Documentation layout](#documentation-layout)
<!-- @end-catalog -->

## Repository layout

| Path | Contains |
| --- | --- |
| `src/` | Express + TypeScript server (runs through `tsx`; no emitted build). |
| `web/` | Finitude Web listener and administrator workbench (React + Vite workspace). |
| `test/` | Server tests run by `node:test`, grouped by domain. |
| `scripts/` | Repository tooling invoked from `package.json`: builds, checks, migrations, release staging. |
| `docs/` | Durable documentation; see [Documentation layout](#documentation-layout). |
| `contracts/` | Versioned cross-client wire fixtures shared with the native apps. |
| `localization/` | Canonical locale sources and the generated runtime bundles. |
| `engineering/` | Engineering Guide renderer assets; its content lives in `docs/engineering/`. |
| `.platform/`, `.ebextensions/`, `buildspec.yml` | Elastic Beanstalk and CodeBuild configuration. These paths are fixed by AWS. |
| `.github/workflows/` | The release gate for `develop`/`main`. |

Do not add new top-level directories or top-level Markdown files without
updating this table.

## Server layers

A request flows from the edge inward:

```
routes ─▶ controllers ─▶ application ─▶ services / models / repositories ─▶ infrastructure
           │                                   ▲
           └──▶ views (server-rendered HTML)   └── utils, contracts, config (usable from any layer)
```

| Folder | Responsibility | Must not |
| --- | --- | --- |
| `src/app.ts`, `src/server.ts` | Composition root: builds the Express app, mounts routers, starts and stops the process. | Hold business logic. |
| `src/routes/` | Route tables: paths, HTTP methods, middleware order, and the controller each route calls. Feature subfolders (`routes/content/`) group large route families. | Read the database or build responses. |
| `src/controllers/` | HTTP adapters: validate untrusted input, resolve the authenticated viewer, call application/service code, and map results to allowlisted DTOs. | Be imported by anything except routes and other controllers. |
| `src/middleware/` | Cross-cutting request handling: authentication, uploads, request protection, security headers, media delivery. | Contain domain rules beyond request admission. |
| `src/application/<domain>/` | Use cases that coordinate several services in one transaction or lifecycle (rooms, social graph, catalog publication). | Know about HTTP request or response objects. |
| `src/services/<domain>/` | Domain logic and lifecycles: storage, reconciliation, reference fences, projections. One folder per domain (below). | Import controllers, routes, or views. |
| `src/models/` | MongoDB collection names, record types, and record-level persistence helpers for each collection. | Format HTTP responses. |
| `src/repositories/<domain>/` | Document shapes and queries for domains whose persistence is separated from their use cases. | Contain lifecycle decisions. |
| `src/contracts/` | Versioned public wire types (`listenerV1`, `roomV1`, …). Changing one is an API change; see [listener.md](listener.md#compatibility-policy). | Import server internals. |
| `src/infrastructure/` | Database and S3 clients, indexes, topology, readiness, diagnostics. | Depend on domain services; database startup arming avatar-mutation recovery is the one exception. |
| `src/config/` | Environment-derived rollout switches and capacity limits, read once at the edge of each feature. | Perform I/O. |
| `src/realtime/` | The WebSocket room gateway, tickets, seats, and wind-down. | Bypass `application/rooms` for room state changes. |
| `src/administration/` | Administrator workbench backend, grouped as `catalog/`, `import/`, and `conversion/`, with shared admin flags at its root. | Be reachable without an administrator role guard. |
| `src/views/` | Server-rendered HTML for the account, content-manager, admin, and portfolio pages. | Query the database directly. |
| `src/public/` | Static browser assets for the server-rendered pages (CSS, small scripts, fonts). | Hold Finitude Web code, which belongs in `web/`. |
| `src/utils/` | Pure helpers (keys, pagination, text encoding) without I/O. | Read the environment or the database. |
| `src/narutoMobile/`, `src/portfolio/` | Self-contained hosted sub-products with their own routes and stores. | Share state with Finitude modules. |

### Service domains

`src/services/` contains only domain folders; a new service goes into the folder
of the domain it changes, not into the root.

| Domain | Owns |
| --- | --- |
| `account/` | Account deletion, device sessions, account reference fences, social account cleanup. |
| `auth/` | Credentials, sessions, cookies, email links and verification, federated identity, passkey capabilities, security audit events. |
| `avatar/` | Profile avatar storage and mutation lifecycle. |
| `audio/` | Audio object storage, metadata, publication recovery, reconciliation, remediation. |
| `image/` | Cover-art storage, variants, image object lifecycle and reconciliation. |
| `media/` | MediaTrack representations, byte-range delivery, video metadata, S3 usage summaries. |
| `catalog/` | Albums, Artists, Organizations, credits, visibility, search backfill, deletion leases, and their reference fences. |
| `content/` | Pages, page items, and content-reference reconciliation. |
| `listener/` | Listener content projections, telemetry, artist follows, followed-artist releases. |
| `playlists/` | Playlist feature flag, lifecycle, and projections. |
| `roomAudio/` | Room audio inspection and loudness analysis. |
| `platform/` | Process lifecycle, operational summaries, runtime resources, localization delivery. |

If a service fits no domain, add a new domain folder and a row here rather than
placing it in a neighbor that does not own it.

### Dependency rules

- Only `routes/`, `app.ts`, and `server.ts` import `controllers/`; only `app.ts`
  and `server.ts` import `routes/`; only the HTTP edge imports `views/`.
- Server code never imports from `test/` or `web/`. `web/src` may import only
  `src/contracts` types; browser-test harnesses under `web/e2e*/support/` may
  start server modules.
- Imports between service domains are allowed when one domain fences or cleans
  up another's records; keep such calls one-directional and explain the
  relationship in a comment at the call site.
- `test/platform/architectureBoundaries.test.ts` enforces the first two rules and
  the domain-folder placement. Its exception list documents the one existing
  violation; remove exceptions, never add them.

## Web client (`web/src`)

| Folder | Contains |
| --- | --- |
| `app/` | Shell, router, session coordination, layout preferences. |
| `api/` | Typed HTTP clients and zod response schemas, one module per server API area. |
| `features/<feature>/` | Route pages and feature-specific components, hooks, and CSS Modules (`account`, `admin`, `catalog`, `home`, `library`, `playback`, `playlists`, `search`, `social`). |
| `components/` | Reusable presentational components shared by two or more features. |
| `player/` | The single audio/video player store and playback recovery. |
| `localization/`, `telemetry/`, `artwork/`, `styles/` | Cross-cutting client concerns. |
| `test/` | Vitest setup and shared test helpers. |

A component starts inside its feature folder and moves to `components/` only when
a second feature uses it. Unit tests sit next to the module they test
(`Foo.tsx` + `Foo.test.tsx`); browser tests live in `web/e2e/` (listener release
gate) and `web/e2e-social/` (social and rooms gate).

## Tests

- Server tests live in `test/<domain>/`, using the same domain names as
  `src/services/` plus `administration`, `rooms`, `social`, `naruto`, `portfolio`,
  and `deployment` (platform hooks and release artifacts). A Web-facing gate for
  `web/` stays in `web/`.
- Suffixes select the runner: `*.test.ts` (unit, `npm test`), `*.integration.ts`
  (disposable MongoDB replica set, `npm run test:integration`), and
  `*.linux.test.ts` (Linux-only platform checks).
- Shared harnesses go in `test/support/`; binary and JSON fixtures go in
  `test/fixtures/`. Neither contains test cases.

## Naming

- Server modules use `camelCase.ts`, named after their main export
  (`imageStorageService.ts`, `roomGateway.ts`). Suffixes describe the role:
  `*Service`, `*Controller`, `*Routes`, `*Middleware`, `*View`, `*Repository`.
- React components and their CSS Modules use `PascalCase.tsx` and
  `PascalCase.module.css`.
- Scripts use `kebab-case.mjs` (or `.ts` when they import server code).
- Documents use `kebab-case.md`.

## File size and catalogs

- Every hand-written source, stylesheet, script, workflow, and Markdown file
  longer than 100 lines starts with a generated catalog: exports, internal
  declarations, and test titles for code; classes, custom properties, and
  breakpoints for CSS; functions for shell scripts; a linked contents list for
  Markdown. Vendored, generated, fixture, and JSON files are exempt.
- Run `npm run catalog:generate` after editing such a file. `npm test` runs
  `npm run catalog:check` and fails on a missing or stale catalog. Never edit a
  catalog by hand. Both commands accept CRLF (Windows) and LF working copies,
  keep each file's line endings, and write nothing if any file fails to parse.
- A catalog is a navigation aid, not permission to grow a file. Split a module
  when it passes roughly 800 lines or mixes responsibilities, along the
  boundaries its catalog already shows.

## Documentation layout

| Path | Contains |
| --- | --- |
| `README.md` | What Archtree is, the repository map, quick start, and the script list. |
| `AGENTS.md` | Working rules for coding agents. |
| `docs/README.md` | Index of every document below. |
| `docs/business-rules.md` | Canonical product behavior shared with Finitude iOS and Android. Its path is referenced by those repositories and must not change. |
| `docs/architecture/` | This standard and the implementation contracts of each subsystem. |
| `docs/features/` | How each feature works and is operated: endpoints, flows, limits. |
| `docs/development/` | Local environment, configuration, running, troubleshooting, the Engineering Guide. |
| `docs/deployment/` | AWS setup, rollout runbooks, deployment TODOs, and capacity evidence. |
| `docs/testing/` | Release test matrices. |
| `docs/design/` | Visual system references. |
| `docs/product/` | Product opportunity ranking. |
| `docs/plans/` | Temporary staged plans; delete each when its work is complete. |
| `docs/engineering/` | Source content and translations for the `/engineering` guide. |

Add a document to the folder that matches its reader, link it from
`docs/README.md`, and prefer extending an existing document over adding one.
