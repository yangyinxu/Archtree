# Finitude Admin Content Access Plan

## Status

Complete as of 2026-08-03. Stages 0–5 are complete. All Archtree and related
iOS checks pass.

This document sequences implementation work. Canonical product behavior lives
in `../business-rules.md`; endpoint and operational details belong in the
README and code.

## Objective

Make Finitude's shared catalog and presentation globally readable but
administrator-managed:

- signed-out visitors and every account role can browse all database-confirmed
  ready/published public content;
- only an `admin` account can open Content Manager or mutate shared catalog,
  Feed Post, asset, relationship, or page-composition data;
- ordinary users retain their own Save, Library, Recently Played, avatar,
  account, device-download, and Playlist mutations;
- the product has only `admin` and ordinary `user` authorization classes;
  `createdBy` remains provenance and never grants permission;
- public registration always creates a `user`, while an operator may promote a
  selected account by changing its database role to the exact value `admin`.

## Confirmed decisions

| Area | Decision |
| --- | --- |
| Public catalog reads | Available to signed-out visitors, users, and admins |
| Public lifecycle boundary | Only ready/published records and safe public fields |
| Shared catalog writes | Admin only |
| Feed Post writes | Admin only |
| Content Manager | Hidden from non-admin UI and protected against direct access |
| Personal state | Owner remains able to mutate Save, activity, profile, account, downloads, and Playlists |
| Account roles | `admin` and `user`; legacy/unknown values fail closed as `user` |
| Content provenance | Preserve `createdBy`; it does not create a creator role or write permission |
| Admin provisioning | Controlled manual database update; no public promotion endpoint |
| iOS management UI | None in this release; backend remains the authority |

## Non-goals

- Implementing user Playlists, Private Playlists, user search, public profiles,
  public avatars, social discovery, or moderation.
- Adding an admin-role management UI or public role-promotion endpoint.
- Automatically transferring or deleting legacy catalog ownership.
- Exposing pending, failed, deleting, orphaned, private-account, MongoDB, or S3
  lifecycle data through public APIs.

## Permission matrix

| Surface | Signed out | User | Admin |
| --- | --- | --- | --- |
| Ready public Catalog/Home/Search/Feed/stream/artwork | Read | Read | Read |
| Content Manager pages and inventory | Login prompt | `403` | Read/write |
| Catalog, asset, relationship, Feed Post, and composition mutations | `401` | `403` | Allowed |
| Save, Library, Recently Played, avatar, account, own Playlist | Sign-in-required behavior | Own data | Own data |
| Storage and reconciliation audit | `401` | `403` | Read-only audit |

## Baseline findings before implementation

- Content Manager routes require authentication but not admin role.
- JSON Catalog, Soundtrack, Page, Carousel, Content Collection, and Feed Post
  mutations require authentication and then allow owner-or-admin behavior.
- The landing page shows Content Manager actions to every signed-in account.
- Content Manager inventories are scoped to the current `createdBy`, so an
  admin cannot discover all legacy content from the summary lists.
- Listener endpoints already provide safe public projections, but several
  legacy `/content/*` reads expose raw records or non-ready Soundtracks.
- Authentication reloads the current database role on each request, allowing
  promotion and demotion to take effect without trusting stale JWT role claims.

## Stage 0 — Canonical contract and implementation inventory

**Status: Complete**

- Update `docs/business-rules.md` with the confirmed role, public-read,
  admin-write, Content Manager, Feed Post, and personal-state boundaries.
- Remove role-like uses of “creator” from shared behavior while preserving the
  word only where it means artist/author attribution.
- Record the complete route inventory and verification matrix in this plan.
- Confirm the iOS client has no shared-content management surface. Audit its
  public DTO requirements before changing legacy responses.

**Exit gate:** canonical rules and this plan agree, and no unresolved product
decision remains.

## Stage 1 — Authoritative role and guard foundation

**Status: Complete**

- Define the supported `admin`/`user` role contract and normalize every unknown
  or legacy database value to `user`.
- Keep database-backed role lookup authoritative for every request.
- Add a Web-specific admin guard that returns a safe `403` after authentication.
- Keep public registration and federated account creation fixed to `user`.
- Document controlled manual admin promotion and demotion without exposing a
  public role-management endpoint.

**Exit gate:** forged or stale role claims cannot grant admin access, a database
role change applies on the next request, and non-admin roles fail closed.

## Stage 2 — Enforce admin-only shared mutations

**Status: Complete**

- Protect Content Manager and all shared-content writes before application JSON
  or form parsing, route-specific multipart decoding, temporary-file creation,
  upload rate work, or controller mutation.
- Add admin guards to JSON Artist, Album, Soundtrack, audio upload, Page,
  Carousel, Content Collection, relationship, and Feed Post mutations.
- Protect management-only Carousel and Content Collection inventory reads.
- Preserve ordinary-user access to `/content/me/*`, account/avatar/session
  operations, downloads, playback activity, and future own-Playlist routes.
- Replace controller owner/provenance checks with exact admin defense in depth
  and administrator-only denial language.

**Exit gate:** every shared write has the `401`/`403`/admin matrix, and rejected
multipart requests create no temporary file, S3 object, or database mutation.

## Stage 3 — Admin-only UI and global management inventory

**Status: Complete**

- Make landing actions role-aware and show Content Manager links only to admins.
- Ensure direct non-admin requests to every Manager GET, search, and POST route
  receive `403` rather than rendered management data.
- Replace “My Content/My Audio Tracks” semantics with a global administrator
  inventory that includes legacy records regardless of `createdBy`.
- Add bounded pagination or equivalent complete discovery for Artist, Album,
  Soundtrack, Page, Carousel, and Content Collection records.
- Preserve `createdBy` in internal management/audit data without treating it as
  an authorization role.

**Exit gate:** an admin can discover and manage every shared record, while a
user sees neither entry points nor Manager content through a direct URL.

## Stage 4 — Public-read safety and role-independent visibility

**Status: Complete**

- Keep Home, Search, Artist, Album, ready Soundtrack metadata/streaming,
  artwork, and Feed reads available without authentication.
- Replace raw legacy Catalog responses with allowlisted public projections
  compatible with existing Web and iOS consumers.
- Apply ready/published filtering consistently to list, search, detail, HEAD,
  GET, and expanded-page paths.
- Prove that public results do not vary by `createdBy` or viewer role, apart
  from documented personalized carousels and account-owned Library state.
- Keep private avatars, saves, activity, sessions, account data, lifecycle
  errors, object keys, and storage metadata out of public responses.
- Hydrate allowlisted Posts referenced by an expanded public Page independently
  of the Feed pagination window. Keep `included.posts` optional in iOS and
  merge it by ID with Feed results for compatibility with older servers.
- Preserve declared Album Soundtrack order without reverse-appending tracks;
  give each legacy Album with no declarations its own bounded 500-track ready
  fallback. Filter dynamic Artist Carousel tracks before applying its limit.

**Exit gate:** signed-out, user, and admin viewers receive the same safe public
catalog, while non-ready and private data remain inaccessible.

## Stage 5 — Documentation, regression suite, and rollout readiness

**Status: Complete**

- Update README authorization, Content Manager, public read, audio lifecycle,
  Feed Post, and manual admin-provisioning guidance.
- Add route-matrix tests for signed-out, user, legacy/unknown role, and admin.
- Add landing/direct-URL, guard-order, zero-side-effect upload, global inventory,
  database role-change, public DTO, readiness, and cross-owner visibility tests.
- Run server/Web tests and builds, relevant integration tests, Listener E2E
  gates, `git diff --check`, and final documentation review.
- Record any environment-dependent checks that could not run and why.

**Exit gate:** documentation matches implementation, relevant automated checks
pass, and every plan stage is marked `Complete` or has an explicit blocker.

### Verification record

- `npm test`: Server 138/138 and Web 103/103 passed.
- `npm run build`: Server type-check and production Web build passed.
- `npm run test:integration`: 29/29 MongoDB integration tests passed.
- `npm run test:e2e:chromium`: 13/13 Listener Chromium tests passed.
- Finitude iOS `./scripts/check-quality.sh`: passed.
- Finitude iOS unit suite: 106/106 passed, including the new regression that a
  page-referenced Post absent from the Feed window still renders from
  `included.posts`.
- Finitude iOS UI suite: 10/10 passed. The independently diagnosed mini-player
  title failure was fixed in the sibling repository by binding the expanded
  player surface to the active queue item.
- `git diff --check` passed in both Archtree and Finitude iOS.

## Definition of done

- Only an exact database-backed `admin` role can mutate shared Finitude content
  or access Content Manager.
- Every non-admin account is an ordinary user regardless of legacy role text.
- All ready/published public content is readable while signed out and is never
  owner-filtered.
- Personal state remains owner-scoped and writable by the owning user.
- Admin inventory is global and does not strand legacy `createdBy` records.
- Public APIs expose allowlisted fields and lifecycle-safe content only.
- Business rules, README, tests, and stage statuses are synchronized.
