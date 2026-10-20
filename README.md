# Archtree

Archtree is an Express + TypeScript service for authentication, content
management, and media upload/streaming. It hosts the React-based Finitude Web
listener under `/finitude`, the administrator workbench, the `/engineering`
guide, and the kashewt portfolio homepage.

- Product behavior shared with the Finitude iOS and Android clients is canonical
  in [`docs/business-rules.md`](docs/business-rules.md).
- Every other document is indexed in [`docs/README.md`](docs/README.md).
- Where code, tests, and documents belong is defined in the
  [architecture standards](docs/architecture/standards.md).

## Repository map

| Path | Contains |
| --- | --- |
| [`src/`](src) | Express server: `routes/` → `controllers/` → `application/` and `services/<domain>/` → `models/`, `repositories/`, `infrastructure/`. |
| [`web/`](web) | Finitude Web listener and administrator workbench (React + Vite workspace). |
| [`test/`](test) | Server tests grouped by domain (`*.test.ts` unit, `*.integration.ts` MongoDB). |
| [`scripts/`](scripts) | Build, check, migration, and release tooling run from `package.json`. |
| [`docs/`](docs/README.md) | Business rules, architecture, features, development, deployment. |
| [`contracts/`](contracts) | Cross-client wire fixtures shared with the native apps. |
| [`localization/`](localization) | Canonical locale sources and generated runtime bundles. |
| [`engineering/`](engineering) | Engineering Guide renderer assets (content lives in `docs/engineering/`). |
| `.platform/`, `.ebextensions/`, `buildspec.yml` | Elastic Beanstalk and CodeBuild configuration. |

## Quick start

```bash
npm ci
npm run doctor
npm run dev
```

`npm run dev` needs a private `.env` (see [configuration](docs/development/configuration.md));
`npm run doctor` checks Node 24, MongoDB, and FFmpeg as described in the
[development environment](docs/development/environment.md). Run the listener with
hot reload through `npm run dev:web`; [local run](docs/development/local-run.md)
covers production-style bundles and browser gates.

## Tech Stack

- Node.js 24
- Express
- TypeScript (runtime via tsx)
- React + Vite
- MongoDB
- AWS S3 (one Audio or Video object per MediaTrack)

## Scripts

- `npm run doctor`: check Node 24 and the isolated MongoDB test executable
- `npm run doctor:release`: also require the Linux/Bash release environment
- `npm run dev`: start development server
- `npm run demo:social`: start the isolated two-account Audio room demonstration
- `npm run dev:web`: start the listener Vite server at `/finitude/`; run the
  Express development server separately so API requests can be proxied
- `npm start`: start production-mode server
- `npm run build`: type-check the server and build the listener and engineering guide
- `npm run build:engineering`: validate and build the static engineering guide
- `npm run preview:engineering`: build and serve the guide on loopback port 4174
- `npm test`: run server and listener unit/component tests
- `npm run test:server:linux`: explicitly run the Linux platform-hook and artifact
  tests; these also run automatically as part of `npm test` on Linux
- `npm run test:e2e`: run the production listener bundle in Chromium with
  accessibility checks (`test:e2e:chromium` is an alias)
- `npm run typecheck:e2e --workspace @archtree/finitude-web`: type-check the
  Playwright configuration, fixtures, and browser specs without launching a
  browser
- `npm run test:integration`: run transactional authentication, account,
  Playlist, storage, and content-reference lifecycle tests against a disposable
  single-node MongoDB replica set
- `npm run test:media-load`: run the bounded audio/video Range, seek/abort,
  artwork, and health-recovery workload against an explicitly authorized
  environment
- `npm run profile:search`: inspect the current substring-search predicate on
  10000 synthetic records in a disposable local MongoDB replica set
- `npm run localization:check`: validate canonical locale files, ICU variable
  contracts, and checked-in generated runtime output without modifying files
- `npm run catalog:generate`: regenerate the catalogs at the top of files longer
  than 100 lines (`npm run catalog:check` verifies them and runs in `npm test`)
- `npm run localization:generate`: validate locale sources and atomically
  regenerate the public manifest and runtime bundles
- `npm run record:metadata-lookup-fixtures -- --live`: re-record the trimmed
  public lookup fixtures from the live services (never run by tests or CI)
- `npm run stage:eb-artifact`: validate and stage the exact allowlisted Elastic
  Beanstalk runtime tree in `elastic-beanstalk-artifact`

The integration suite and the application's MongoDB requirements are described
in [the development environment](docs/development/environment.md#mongodb-requirements).

## Code Documentation

Classes, types, and functions should have concise comments describing their
responsibility or non-obvious constraints. Comments should explain intent
rather than repeat the code and must stay synchronized with behavior. Files
longer than 100 lines also carry a generated catalog; see
[file size and catalogs](docs/architecture/standards.md#file-size-and-catalogs).
