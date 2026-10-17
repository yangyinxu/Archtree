# Local run

1. Install dependencies:
   - `npm install`
2. Configure `.env`.
3. Start server:
   - `npm run dev`

To develop the listener with hot reload, keep the server running and start a
second process with `npm run dev:web`, then open
`http://localhost:5173/finitude/`. For a production-style local run, use
`npm run build` first; Express then serves the generated `web/dist` bundle at
`/finitude` and supports listener deep links. Requests to the legacy `/listen`
prefix permanently redirect to the equivalent `/finitude` path. The Web build
measures every initial route's unique compressed JavaScript and fails if any
route exceeds the reviewed 150 KiB gzip budget. It also caps the complete
emitted stylesheet payload at 32 KiB gzip, emitted fonts at 128 KiB, bundled
images at 256 KiB total, and any one bundled image at 128 KiB. Catalog artwork
continues to load through listener DTOs rather than being bundled into the app.
Production CSS Modules use compact scoped identifiers; development and test
builds retain readable defaults. Exported module keys and style declarations are
unchanged.

To test MediaTrack replacement locally, sign in as an administrator at
`http://localhost:8080/content/manage`, create or select a MediaTrack, and use
the rendered **Replace with Audio** or **Replace with Video** form. Video input
must be a progressive MP4 with H.264/AVC video and AAC audio. The upload URLs
are multipart `POST` endpoints and are not pages to open directly in the
address bar. If Express is intentionally running on a port other than 8080,
either test the built single-origin `/finitude` bundle on that port or update
the Vite development proxy target to the same origin.

Finitude uses its custom shared controls in the page and temporarily exposes
browser-native controls on the same Video element in fullscreen, so playback
position remains adjustable without creating another player.
The same media element stays connected in an app-owned hidden parking host for
Audio and moves into the visible theater for Video. This prevents presentation
teardown from cancelling natural or explicit mixed-kind queue advancement.

Install the version-matched browser runtimes once before running the local
browser gate:

```bash
npx playwright install chromium
npm run typecheck:e2e --workspace @archtree/finitude-web
CI=1 npm run test:e2e --workspace @archtree/finitude-web -- --update-snapshots=none
```

There are no pixel-snapshot tests; layout is checked through behavior and
accessibility assertions.

The listener reads browser-safe content from `/api/listener/v1`. The versioned
namespace provides Home, Search, Album, Artist, Track, authenticated Library,
and page-scoped Grid/List responses without exposing storage lifecycle fields.
`GET /api/listener/v1/pages/:slug/items/:itemId?limit=&cursor=` resolves one
attached manual Grid or List. `home` is public; `library` requires the same
authenticated current-viewer fence as the parent Library. The default page is
20 items and the server caps requested pages at 100. Responses contain ordered
content references, allowlisted ready Album/MediaTrack DTOs under `included`,
and a tamper-evident opaque `nextCursor`. Each cursor binds the stable Page-item
and collection identities, Page/item/collection snapshots, ready-content
visibility, and—where applicable—the authenticated viewer. Malformed cursors
return `400`, while cross-scope, lifecycle-changed, or stale cursors return
`409`. Anonymous Home collection pages may use the public catalog cache;
authenticated Home and Library collection pages remain private and
non-cacheable so account-viewer identity headers never enter a shared cache.
Device-local Downloaded Grid/List definitions return
`collection_source_not_server_backed` and are never populated from server
catalog data. Public media streaming is limited to database-confirmed `ready`
MediaTracks and preserves HTTP Range seeking.

Finitude Web keeps Carousel compatibility in the parent Home response, but
loads each attached Grid/List through the page-scoped endpoint above. The Web
client preserves returned reference order, requests later pages only from the
opaque `nextCursor`, and offers an explicit first-page retry when a cursor is
malformed, mismatched, or stale. Authenticated Home and Library collection
requests send the current viewer fence; Web remains streaming-only. The
versioned Listener API does not yet expose a Library parent-page descriptor,
so Web Library collection discovery remains blocked rather than falling back
to the legacy expanded-page response.
Legacy native-client reads under `/content` and `/feed` also remain available
without authentication. Their Artist, Album, MediaTrack, Page, Carousel,
Grid/List, and Feed Post responses use explicit public projections rather than
raw MongoDB documents. MediaTrack list, search, Album relationship, personalized
section, and expanded-page queries require a published (or legacy) Track with
`uploadStatus: ready` and an S3 key bound to that Track ID before applying item
limits or pagination. Public responses do
not expose `createdBy`, `updatedBy`, `coverArtId`, object keys, upload errors,
original filenames, or lifecycle timestamps. Feed Posts retain only their
existing opaque author reference; it cannot be used to read private account or
avatar data.
Every playable MediaTrack exposes exactly one `mediaType` (`audio` or `video`)
and one `streamUrl`. Both kinds use `HEAD`/`GET
/content/mediaTrack/stream/:mediaTrackId`, including full `200`, exact
single-range `206`, and invalid-range `416` behavior; clients never receive an
S3 URL or object key. Content Manager replaces the current object in place and
retains the old object as cleanup evidence until S3 deletion is confirmed.
Legacy `audioTrack` names and Audio-only stream aliases remain compatibility
details during client migration; a Video MediaTrack is never served through
the legacy Audio stream alias.
The root `/video` GridFS route is isolated legacy compatibility only: it is not
returned by catalog DTOs and must not receive new MediaTrack media. Remove it
only after production files and consumers have been inventoried and either
mapped to an owned MediaTrack lifecycle or confirmed unused.
Finitude Web is streaming-only and exposes no Download action, Download filter,
offline state, or browser-local media lifecycle; native-client downloads remain
a separate product capability.
Public artwork resolution similarly permits only ready Artist, Album, and
MediaTrack image assets that their current owner still references; account
avatars remain private behind `/auth/avatar`. Finitude Web derives responsive
96, 192, 320, 480, 640, 960, and 1280 px square WebP responses from
`/content/images/:imageId/v1/:width.webp`. They are versioned, revalidated,
CPU-concurrency bounded responses and never create extra S3 objects; the
original image route remains the fallback and native-client contract.
The shared Web artwork component keeps both its bordered frame and decoded image
square, including in WebKit; Artist portraits retain their circular crop.

The homepage (`/`) is the kashewt.com portfolio. It lists the public projects
from `src/portfolio/projectCatalog.ts` (Finitude, its iOS and Android clients,
Naruto Mobile, and OOTD) in the order stored in the single `portfolioSettings`
document. Project names, descriptions, and links change in that file; a project
added there appears last with its default visibility. If the settings cannot be
read, the homepage falls back to the catalog defaults. Log in, Create account,
and Log out stay in the header, and administrators also see shortcuts to the
projects console, Content Manager, MediaTracks, and the Engineering Guide.

Administrators manage the homepage at `/admin/projects`: move a project up or
down and switch it between public and hidden. Each form posts the settings
revision the page was rendered from, so a change made from a stale page is
refused with a notice instead of overwriting a newer order.

`POST /api/listener/v1/telemetry` accepts only same-origin JSON envelopes of
one to ten bounded anonymous events. It has an independent 16 KiB body limit,
rate/concurrency protection, no cookie requirement, no retry contract, and no
fields for identity, credentials, content/search text, URLs, or raw errors.
`GET /health` is `no-store` and exposes process-local, identity-free media
admission and stream outcomes split across playback, download, artwork,
avatar, and video. The shared 40/8 process/client ceiling reserves 16/2 slots
from non-playback traffic so artwork-heavy pages cannot consume all audio or
video playback capacity.
The response also includes identity-free `rooms` diagnostics: current admission
enablement, authority state and its change count, time since the last successful
sweep, open realtime sockets and rooms, and five bounded failure counters. Room
diagnostics do not change HTTP readiness; see
[the health contract](../architecture/runtime.md#database-constraints-and-additive-migrations).
Each process also logs a minutely `ops_summary` line plus room lifecycle, room
authority and capacity lines for CloudWatch metric filters; the
[social rollout runbook](../deployment/social-rollout-runbook.md#signals)
describes the fields and suggested alarms.

<!-- @catalog -->
**Contents**

- [Verify media Range behavior under bounded load](#verify-media-range-behavior-under-bounded-load)
<!-- @end-catalog -->

## Verify media Range behavior under bounded load

For a synthetic local memory screen without MongoDB or AWS access, run
`node --max-old-space-size=384 --import tsx scripts/capacity-screen.ts` with
Node 24. This measures application-process RSS, not a total-machine memory
limit or AWS throughput. See [the t4g.micro screening report](../deployment/t4g-micro-capacity-screen.md)
for workloads, reproduction details, observed limits, and remaining release checks.
That screen predates social features and exercises no sockets or MongoDB. The
database operations each room sweep, socket refresh and controller heartbeat cost
are counted against an isolated `mongod` by `test/rooms/roomCapacityBudget.integration.ts`
(part of `npm run test:integration`); the report's room budget derives the shipped
capacity limits from those counts.

The media load command targets `http://127.0.0.1:8081` by default and requires
one or more database-confirmed ready Audio MediaTrack ObjectIds. Optional
`MEDIA_LOAD_VIDEO_TRACK_IDS` adds ready Video MediaTracks for mixed playback
load. Both lists use the canonical MediaTrack stream endpoint. It checks `HEAD`,
bounded, open-ended, and suffix ranges, invalid ranges,
overlapping seek cancellation, concurrent fixed-width WebP artwork (including
its type, validator, size, and revalidation contract), and `/health`
recovery.
The command enforces maximums of 32 simulated clients and 1,000 total requests
and emits only one aggregate JSON result; it does not print URLs, content IDs,
ETags, or Range values.

For a production-equivalent staging target, remote traffic requires both an
explicit opt-in and an exact hostname allowlist:

```bash
MEDIA_LOAD_BASE_URL=https://staging.example.com \
MEDIA_LOAD_ALLOWED_HOSTS=staging.example.com \
ALLOW_REMOTE_MEDIA_LOAD=1 \
MEDIA_LOAD_TRACK_IDS=<ready-audio-media-track-object-id> \
MEDIA_LOAD_VIDEO_TRACK_IDS=<ready-video-media-track-object-id> \
MEDIA_LOAD_ARTWORK_IDS=<public-artwork-object-id> \
MEDIA_LOAD_CLIENTS=12 \
MEDIA_LOAD_ARTWORK_CONCURRENCY=4 \
npm run test:media-load
```

Run this only in an environment approved for load testing. The harness models
concurrent clients from one runner; release evidence still needs approved
multi-source staging traffic against the real media store.
