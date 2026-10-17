# Archtree documentation

Start with the [architecture standards](architecture/standards.md) for where
code and documents belong. Product behavior shared with Finitude iOS and Android
is canonical in [business-rules.md](business-rules.md).

## Product

- [Business rules](business-rules.md) — canonical behavior for the backend and every Finitude client.
- [Product opportunities](product/opportunities.md) — ranked candidate work and decision principles.
- [Plans](plans/) — temporary staged plans; each is deleted when its work completes.

## Architecture

- [Architecture standards](architecture/standards.md) — layout, layers, dependency rules, naming, catalogs.
- [Social identity and relationships](architecture/social.md) — social API routes, reports, shares, listening status, transactions.
- [Shared playback rooms](architecture/rooms.md) — room API, protocol, synchronization, safety, operations.
- [Catalog](architecture/catalog.md) — application boundaries, deletion recovery, reference audits.
- [Listener and browser](architecture/listener.md) — public listener contracts, browser modules, session recovery.
- [Runtime reliability and capacity](architecture/runtime.md) — database constraints, startup/shutdown, diagnostics, capacity.

## Features

- [Authentication and content management](features/auth-and-content-management.md) — browser auth, passkeys, email links, the Content Manager.
- [MediaTrack audio and video lifecycle](features/media-lifecycle.md) — upload, replacement, delivery, cleanup.
- [Administrator workbench](features/admin-workbench.md) — catalog review, imports, device-local MP3 conversion.
- [Social backend and listening rooms](features/social-and-rooms.md) — social API usage, rooms, the local demonstration, room audio backfill.
- [Localization](features/localization.md) — the cross-platform localization contract and public API.
- [Naruto Mobile integration](features/naruto.md) — the private analysis proxy and hosted browser distribution.

## Development

- [Development environment](development/environment.md) — Node, MongoDB, FFmpeg, platform gates.
- [Configuration](development/configuration.md) — environment variables.
- [Local run](development/local-run.md) — running the server and listener, browser gates, media load checks.
- [Engineering Guide](development/engineering-guide.md) — the `/engineering` guide and its local preview.
- [Troubleshooting](development/troubleshooting.md) — common failures and where to look.

## Deployment

- [AWS CodeBuild and Elastic Beanstalk](deployment/aws.md) — build, HTTPS, swap, OOTD co-hosting, room audio decoder.
- [Deployment TODOs](deployment/todos.md) — outstanding production configuration work.
- [Finitude Web rollout](deployment/finitude-web-rollout-runbook.md), [social rollout](deployment/social-rollout-runbook.md), and [catalog credit rollout](deployment/catalog-credit-rollout-runbook.md) runbooks.
- [Low-cost production deployment](deployment/low-cost-production-deployment.md) and [t4g.micro capacity screen](deployment/t4g-micro-capacity-screen.md) — sizing evidence.

## Testing and design

- [Finitude Web release matrix](testing/finitude-web-release-matrix.md) — browser and accessibility release gate.
- [Finitude Web listener visual system](design/finitude-web-listener-visual-system.md) — tokens, shell, components, motion.
