Product behavior remains defined in [business-rules.md](../business-rules.md).

# Social identity and relationship API

The Stage 2 backend is implemented in `src/application/social/socialService.ts`,
`src/contracts/socialV1.ts` and `src/routes/socialRoutes.ts`. This is additive to
listener-v1 and private account APIs. `FINITUDE_SOCIAL_ENABLED` defaults to false;
setting it to exactly `true` enables admission. Disabling it retains reads and
safety actions, including changing an existing profile to undiscoverable without
changing its handle/alias or losing friends. No room endpoint or delivery worker
is enabled by this flag.

<!-- @catalog -->
**Contents**

- [Routes and projections](#routes-and-projections)
- [Reports and administrator suspension](#reports-and-administrator-suspension)
- [Direct music share API](#direct-music-share-api)
- [Friend listening status API](#friend-listening-status-api)
- [Transactions, budgets and lifecycle](#transactions-budgets-and-lifecycle)
<!-- @end-catalog -->

## Routes and projections

All routes below are relative to `/api/social/v1`. They require a current revocable
session; native Bearer and current-viewer-bound browser cookie requests use the
existing authentication and same-origin policies. The router authenticates before
its strict 4 KiB JSON parser. It returns private/no-store responses and never raw
database documents. Unknown JSON/query fields and repeated query values fail.

| Method and path | Input | Response |
| --- | --- | --- |
| `POST /mutation-scopes` | Empty JSON object | `{scopeToken, expiresAt}` |
| `POST /mutation-outcomes` | `{scopeToken, commandId}` | `{outcome: SocialOutcome or null}`; expired signed scopes may query retained outcomes |
| `GET /me/profile` | No query | `{profile: SocialOwnProfile or null}` |
| `GET /me/changes` | No query | `{revision}`; the account's opaque change counter, compared for inequality only |
| `PATCH /me/profile` | Mutation identity plus `handle`, `alias`, `discoverable`, `expectedRevision` | `SocialOutcome`; creates with revision 0 or updates/reactivates the observed revision |
| `POST /me/deactivate` | Mutation identity | `SocialOutcome` |
| `GET /profiles?handle=...` | Exact normalized handle | `{profile: SocialCard or null}`; hidden/missing/bilaterally blocked are identical |
| `GET /relationships?kind=...` | `kind`: friends/incoming/outgoing/blocks; optional limit 1–50 (default 20), signed cursor | `{items, nextCursor}`; no total count |
| `GET /relationships/:socialId` | No query | `{relationship: {socialId,state,revision} or null}`; state is none/incoming/outgoing/friends/own blocked |
| `POST /friend-requests` | Mutation identity plus `targetSocialId`, `expectedRevision` | `SocialOutcome` |
| `POST /relationships/:socialId/:action` | Mutation identity and observed `expectedRevision`; block omits revision | `SocialOutcome`; action is accept/decline/cancel/remove/block/unblock |
| `POST /reports` | Mutation identity plus `targetSocialId`; optional `reason` and `note` | `SocialOutcome`; see [reports and suspension](#reports-and-administrator-suspension) |

A mutation identity is `{scopeToken, commandId}`. Command IDs contain 16–80 ASCII
letters, digits, underscores or hyphens. The server normalizes a handle to lower
case, trims/NFC-normalizes aliases, rejects control/format characters, and checks
all fields before capturing immutable intent. Scope tokens are authenticated,
account-bound, expire after 24 hours and are never accepted in a query string.
They are domain-separated from both access tokens and list cursors. A signing-key
rotation invalidates scopes/cursors rather than weakening verification.

The closed-beta name policy in `src/application/social/socialNamePolicy.ts` holds
the reserved-term lists and look-alike folding described in the business rules.
The parser deliberately accepts reserved names; the profile plan checks a handle
only when it is first claimed and a nickname only when it differs from the stored
one, so profiles created earlier keep saving unchanged values. A violation is a
durable `rejected` outcome with code `handle_reserved` or `alias_reserved`, and
it writes no profile or handle row. There is no staff provisioning path for
official accounts; one would need a separate, role-guarded change.

`SocialCard` contains exactly `socialId`, `handle`, `alias`, and `iconSeed`.
Finitude Web colors its generated icon from `iconSeed` (a stable hash to an
OKLCH hue behind the alias initial); clients must treat the seed as opaque.
`SocialOwnProfile` additionally contains `active`, `discoverable`, and `revision`,
plus `suspended: true` only while an administrator suspension is in effect; the
key is absent otherwise, so strict clients written before suspension keep parsing
every unsuspended profile.
List rows contain `socialId`, a permitted `profile` card or null, and the
relationship `revision`. Block-list cards are always null: retaining a private
block reference never grants current profile access. A peer's private block is
not disclosed by pair-state or unblock precondition errors. Existing friends and
pending-request participants may read their relationship despite discovery opt-out;
an unrelated hidden or inactive target returns null.

Completed mutation attempts return HTTP 200 with
`{commandId, outcome: applied|noop|rejected, code?, replayed}`. A rejected domain
outcome is durable and must be handled explicitly. The social router's errors use
HTTP 400/401/404/409/410/413/415/429/503 for invalid schema, session, missing route,
idempotency conflict, expired scope, body/type, admission budget or infrastructure
failures, with generic `{code,message}` bodies. Shared authentication, viewer,
Origin, TLS and concurrency guards retain their existing HTTP status and error
envelopes, which may contain only `message` (including 403 and 426). Clients must
handle the status even when a social error code is absent. A successful HTTP
response alone does not mean that the requested relationship was applied.

Web Social reads are serialized per viewer and account epoch. A GET 429 can cool
subsequent GET dispatches using a positive integer `Retry-After`, capped at 60
seconds; malformed, overflowing and HTTP-date hints are ignored. A known,
message-only HTTP concurrency denial can recover when its safe delay fits the
read's original active deadline. This recovery shares the existing three-attempt
budget with transient-domain-503 GET recovery; waiting between those attempts
counts toward the original 30 seconds. Quota, coded, unknown, and malformed
admission failures, or delays that exceed the active deadline, remain terminal. Cooling uses a
monotonic deadline, survives an idle read queue, retains at most 16 short-lived
viewer entries, and clears on expiry or account transition. Cancellation settles
a waiting caller immediately without dispatching with replacement credentials;
the 30-second transport deadline starts after the initial admission waiting. POST listening
status queries and durable mutations do not install or consult this GET cooling.
Production quotas remain unchanged.

After cancel/decline/remove/unblock, the pair may remain as a positive-revision
`none` tombstone. Before an explicit new request, read the authorized pair-state
endpoint and capture its revision; do not guess 0 or automatically rebase a failed
command. Revision 0 denotes a currently absent pair. These numbers can skip: they
are mutation preconditions, not item counts or continuous client event sequences.
Cursor signatures bind the viewer and list kind for 15 minutes. Each page freshly
projects visible rows in opaque social-ID order; it is not a retained list snapshot.

A request that would create a pending row spends three UTC-day budgets in the
same transaction. The pair row's `requestDay`/`requestCounts` (aligned with
`accountIds`) allow 3 requests per direction; the sender's
`socialBudgets.outgoingDay/outgoing` allows 50; the recipient's
`incomingDay/incoming` allows 100 and is charged only by the sender's first
request to that recipient that day. Cancel, decline and later transitions keep
the pair counters, and a `none` tombstone expires 25 hours after its last change,
so it outlives the day it counts. Account deletion removes both the pair rows and
the budget row. An exhausted budget is a durable `rejected` `social_limit` that
writes no pair or budget change; a noop repeat and a rejected request spend
nothing.

## Reports and administrator suspension

`POST /reports` captures `{action: 'report', targetSocialId, reason, note}`.
`reason` is one of `impersonation`, `harassment`, `spam`, `inappropriate` or
`other` (the default when omitted). `note` is optional, trimmed, NFC-normalized,
CRLF-folded and at most 500 characters; line feeds are the only control
characters kept. Defaults are applied before the receipt digest, so a retry with
or without the optional keys is the same intent. The command is a safety action:
it is accepted while admission is disabled and may use the reserved safety
receipt capacity.

The plan in `socialService.ts` requires the reporter to own a social profile in
any state and the target profile to exist and differ from the reporter. Missing
and self targets are a durable `rejected` `profile_unavailable`. One
`socialReports` row per reporter, target and UTC day is enforced by a unique
SHA-256 `dedupeKey`; a repeat that day is a `noop` that spends no allowance. A
new report spends the durable `socialBudgets.reportDay/reports` allowance of 10
per day, or is rejected with `social_limit`. The row keeps the reporter and
target account and social IDs, the target's handle and nickname at report time,
the reason, the note and `createdAt`. The transaction fences both accounts (so a
concurrent deletion cannot orphan a row) but writes no outbox signal, receipt,
profile or relationship for the target, and wakes no realtime delivery.

`src/application/social/socialModerationService.ts` and
`src/routes/socialModerationRoutes.ts` implement administrator moderation under
`/admin/social`. The router installs `requireAuth` and `requireAdmin` before any
route; cookie POSTs also pass the application's same-origin mutation guard.
Responses are `private, no-store`. GET responses are JSON unless the browser
prefers HTML; forms post back and redirect with a fixed `notice` code, so no
listener identity or caller text is placed in a redirect URL.

| Method and path | Input | Response |
| --- | --- | --- |
| `GET /admin/social/reports` | `state=open\|resolved` (default open), `limit` 1–100 (default 50), `cursor` | `{items, nextCursor}`; open oldest first, resolved newest first. HTML adds the suspended list and a `handle` lookup |
| `GET /admin/social/profiles` | `handle=...` or `suspended=true` | `{items: SocialModerationProfile[]}` |
| `POST /admin/social/reports/:reportId/resolve` | `{resolution: 'dismissed' \| 'actioned'}` | `{outcome: applied\|noop, value: SocialModerationReport}` |
| `POST /admin/social/profiles/:socialId/suspend` | Empty body | `{outcome, value: SocialModerationProfile}` |
| `POST /admin/social/profiles/:socialId/unsuspend` | Empty body | `{outcome, value: SocialModerationProfile}` |

A moderation profile contains `socialId`, `handle`, `alias`, `status`
(`active`, `inactive` or `suspended`), the listener's own `discoverable` choice,
`suspendedAt` and its open report count. A moderation report contains its ID,
reason, note, state, timestamps, resolution, the reported snapshot with the
current moderation profile (or null), and the reporter's social ID and current
handle (or null once anonymized). Neither contains email, account IDs or avatars.

Every moderation change is idempotent by state, so an administrator may retry a
`mutation_outcome_unknown` result. Resolution is a single-document transition
that stamps `resolvedAt`, `resolvedBy` (the administrator account ID) and a TTL
`expiresAt` 90 days later. Suspension runs in a snapshot transaction that fences
the target, every relationship peer, room co-members and live music-share peers
in sorted order, then: moves pending edges to `none` under a fresh relationship
revision; stores `suspension {suspendedAt, suspendedBy, restoreActive,
restoreDiscoverable}` while holding `active` and `discoverable` false; applies
the deactivation room safety change, music-share deletion and listening reset;
resolves open reports about the target as `suspended`; and invalidates the
target and peers. Because every read and admission path already requires an
active profile, the inactive profile is hidden without new read predicates. The
profile plan rejects any profile command from a suspended profile with
`social_suspended` (403). Unsuspension restores the stored choices, removes the
suspension and invalidates the target and retained peers. Accepted edges and
blocks are untouched by both.

Account deletion deletes reports whose `targetAccountId` is the account and
anonymizes reports it wrote by removing `reporterAccountId`, `reporterSocialId`
and `note`, stamping `anonymizedAt` and replacing `dedupeKey` with
`anonymized:<reportId>`, in the same transaction. Startup requires the unique
`dedupeKey` index and the `reporterAccountId` and `targetAccountId,state` cleanup
indexes; the triage sort, TTL and sparse suspension indexes are optional.

## Direct music share API

`src/contracts/socialMusicV1.ts` defines a separate private projection. These
routes reuse social-v1 authentication, viewer fencing, 4 KiB JSON limits,
mutation scopes, status-only receipts and payload-free `socialChanged` delivery.

| Endpoint under `/api/social/v1` | Contract |
| --- | --- |
| `GET /music-shares?direction=incoming\|outgoing&limit=20&cursor=...` | `{ items, nextCursor }`; default page 20, maximum 50; signed cursor binds account, direction and descending creation time/share identity for 15 minutes |
| `POST /music-shares` | Original mutation identity, `targetSocialId`, observed friendship `expectedRevision`, `contentType: audioTrack\|album` and catalog `contentId` |
| `POST /music-shares/:shareId/dismiss` | Original mutation identity; only the recipient removes this share incarnation |
| `POST /music-shares/:shareId/withdraw` | Original mutation identity; only the sender removes this share incarnation |

Items contain only opaque `shareId`, the peer's current social card, catalog
type/identity, creation/expiry timestamps, and current allowlisted content
(`id`, `contentType`, `title`, `artworkUrl`, `artistNames`) or null. No stream URL,
account ID, saved state, read/play receipt or historical identity is retained.
Reads recheck both active profiles, current friendship, blocking and ready
catalog visibility. Replacements resolve current catalog identity. Deleted or
non-ready content returns null until indexed idempotent cleanup removes its rows.

The `socialMusicShares` collection bounds each account to 100 live incoming and
100 live outgoing rows, with a durable 50-new-incoming/day budget and 30-day
logical expiry. Current duplicate sender/recipient/content shares are noops.
Account fences serialize quota, friendship and catalog-reference admission with
the existing transaction executor. Removal/block/deactivation/account deletion
clear the affected bounded rows and invalidate surviving peers. Catalog deletion
reclaims indexed references in bounded retryable batches before final metadata
removal. TTL only reclaims expired rows and never grants visibility.

Web's lazy `/finitude/social/shares` route and share dialog use the existing player
and private Save API. Their shared operation session retains an uncertain command
across route/dialog changes, blocks a new share until explicit recovery, and
fences late callbacks to the captured account epoch. Acknowledged writes remain
acknowledged even if the subsequent list refresh fails.

## Friend listening status API

`src/contracts/listeningV1.ts` adds an independent opt-in Audio projection under
the same live session, current viewer, exact JSON and cookie protections.

| Endpoint under `/api/social/v1` | Contract |
| --- | --- |
| `GET /me/listening` | `{ listening: { enabled, revision, publisherRevision, serverTimeMs } }`; absent preference is off at revision 0 |
| `PATCH /me/listening` | Original social mutation identity, `enabled`, observed `expectedRevision` |
| `POST /listening-publications/claim` | Original social mutation identity, document `clientId`, `expectedPreferenceRevision`, `expectedPublisherRevision`; status-only receipt, no public playback |
| `POST /listening-publications/report` | Exact publisher identity, expected preference/publisher versions and increasing `sequence`; `playing` carries `observedAtMs` and captured playback; `stopped` carries its captured `occurrenceId` and `playbackSequence` |
| `POST /listening-status/query` | `{ socialIds }`, 1–50 unique already-observed opaque IDs; `{ items }` contains only current friend cards, ready Audio metadata and expiry |
| `GET /listening-status/friends` | Optional `limit` (default 20, at most 50) and opaque `cursor`; `{ items, nextCursor }` lists every currently listening friend in opaque social-ID order with the same item projection. Only friends with a fresh visible publication are candidates, so a poll does not re-check every friend. The signed cursor is bound to the account and expires after 15 minutes |

The durable `socialListeningStates` account row keeps the preference and publisher
clock. One `socialListeningPublications` row per account holds the current session,
document client, claim command ID, sequences, loaded-source fingerprint, playback
occurrence and expiring display. A claim advances the clock and publishes nothing.
Reports update an existing exact lease and never upsert. TTL can reclaim the
publication without removing the durable clock or allowing an old receipt/report
to recreate it. The claim's `commandId` is its private publication identity.

Playing reports include `sourceId`, `occurrenceId`, `mediaTrackId`, `positionMs`
and nullable room evidence (`roomId`, epoch, member/controller, playback generation,
entry and pinned media revision). The per-document client matches the room client.
Ordinary Audio uses the current ready source without requiring room WAV analysis.
The source ID survives pause/buffering recovery; a new actual run changes the
occurrence. Same-source resumes retain the source fingerprint, preventing an old
loaded source from rebinding to replaced media inside its lease. The fingerprint
hashes only the active object key, which every replacement mints anew, so
room-audio analysis of unchanged bytes keeps the status and lease; room reports
compare the pinned representation revision separately. Room reads and
reports also verify current authority, admission, controller, readiness and the
exact playing timeline. These private fields never enter friend projections.

Native `playing` establishes source-matched proof; only fresh advancing native
media time can renew it. An observer remounted during continuing Audio can also
recover after a new explicit gesture and two fresh, advancing, source-matched
native observations. A source change retires that recovery gesture. The lazy
observer does not trust UI status, readiness or the `play()` promise.
Client monotonic observations are mapped to server time from
owner reads. Delayed responses cannot rewind the established clock estimate;
preference and publisher revisions are still applied, and clock advances recheck
the existing lease expiry. Reports more than five seconds old or two seconds ahead are rejected;
expiry is bounded by observation time plus 25 seconds. Same-occurrence renewals
extend at most every ten seconds; valid early/nonadvancing reports may acknowledge
their sequence while retaining the previous expiry. The playing-report budget is
60 per account per minute; captured safety stops remain available after that
budget is exhausted. Existing IP/session protections still apply.

The Web panel reads `GET /listening-status/friends` when Together opens, so its
rows are laid out before the listener scrolls to it or to the profile controls
below it, and then every five seconds while it is in view (immediately on
returning to it after a longer gap), refetching each page it has loaded (20
listening friends each, more on explicit Load more), so friends beyond the first
page of the friend list stay visible. It
reuses the account publisher's monotonic server clock, expires rows locally and
hides failed reads. Claims and reports do not fan out generic social invalidations. Current
friendship, active profiles, opt-in, unblocked relationships, publishing session
and ready source are rechecked on each read. Source replacement is an immediate
visibility/renewal barrier; indexed cleanup before final source deletion uses
bounded batches rather than an unbounded publication update in the source
transaction. Session revocation includes ordinary publishers that never joined
a room. Opt-out/deactivation invalidate publication and retain clocks; final
account deletion removes both private records. Disabled social admission hides
status while preserving setting reads and safety cleanup.

The Web account singleton retains uncertain preference/claim identities across
route changes. A new explicit gesture freshly verifies the publisher; automatic
progress, reconnect and polling cannot reclaim another device's ownership. Stops
capture their original lease, sequence and occurrence. Account transitions
synchronously detach observations, and late callbacks cannot publish for a new
viewer. Creating a paused room and inviting a friend are separate explicit,
recoverable mutations with no automatic playback.

A stop records the sequence of the playing report it cancels, below its own
sequence. This lets a stop arriving before that playing report suppress both the
pending occurrence and older display, without allowing a delayed old-occurrence
stop to clear newer playback. A room member's confirmed local pause/disconnection
also clears its matching publication and blocks the retired actual occurrence;
readiness recovery alone cannot restore that display.

## Transactions, budgets and lifecycle

Social reads/writes verify the actor's account-bound, unrevoked and unexpired
`authSessions` row inside their transaction. A conditional session-row increment
serializes with revocation. Involved account rows are fenced in sorted order before
reading the final domain state. Each write commits the domain state, status-only
receipt and payload-free invalidation together. Production transaction bodies
perform no external dispatches. Known-aborted transient conflicts have at most three
attempts with short backoff; a commit with an unknown result returns
`mutation_outcome_unknown` and is never automatically rerun.

Receipts are keyed by account, signed scope ID and command ID; a canonical digest
detects changed intent. Identical retries are deduplicated before stale revision
checks and return only the recorded status, never old profile/relationship data.
Explicit same-identity retry resolves an uncertain commit. Receipt expiry is one
hour after scope expiry. Expiry is checked logically, even if TTL has not run or
the receipt was already removed. A failed outcome lookup does not authorize a
new-scope replay.

Durable budgets are 24 scopes/day, 30 new mutation attempts/minute and 120 reads/minute
per account, plus 100 newly received requests/day. Profile deactivation cannot reset
these counters. A 120 requests/minute HTTP window per authenticated account (per IP
for unauthenticated requests, including revoked or expired tokens) and per-account
mutation concurrency limits (four per account, 32 per process) provide additional
request protection. Retained
receipts permit 1,000 admission attempts plus 128 safety receipts and a final
reserved deactivation receipt; admission exhaustion therefore cannot consume the
privacy-exit reserve. Retries consume no new receipt.
Short request-rate limits still apply to safety operations.

Each canonical pair stores both account/social IDs, independent directional
blocks, request direction, state and revision. Friends/pending/blocks/pair bounds
are checked under both account fences. Unblocked `none` tombstones have a 25-hour
expiry. Durable per-account relationship clocks survive their cleanup, ensuring
a recreated pair never reuses a previous request revision. Those clocks also
advance during deactivation. They are internal fields, not public profile data.

The social outbox is one coalesced row per account: account ID, invalidation
revision and update time. It retains no peer, alias or relationship payload and
has no TTL that could erase pending recovery work. The room gateway reauthorizes
delivery from these current-state markers. Scope receipts likewise contain no
peer reference or private projection, so deleting a target cannot leave cached
identity payload in another account's receipt.

`GET /me/changes` exposes the same revision for clients without the room socket,
for example when rooms are disabled. It is a missing-row-means-zero counter with
no payload. Unlike other social reads it skips the transactional read fence: a
read-only check of the current session replaces the session, account and read
budget writes, so an idle poll never writes to MongoDB. The router's 120-per-minute
account window still bounds it. Account deletion removes every session, so a valid
session also implies a live account.

Account deletion keeps the existing synchronous transaction and all avatar/shared
provenance preconditions. `socialAccountLifecycleService.ts` removes the deleted
account's profile, both-sided relationships, receipts, budget, outbox and the
reports about it (anonymizing the reports it wrote), fences existing peers before
their invalidation, and removes the owner identifier from the 30-day handle
reservation. Concurrent peer deletion cannot recreate orphaned
outbox data. A failure rolls back the entire cleanup; no S3 object is touched.
Deactivation retains the profile/handle, blocks, receipts and clocks so later
reactivation cannot restore an old intent or relationship.

Startup migration `required-indexes-v4-social-participation` (now verified as part of
`required-indexes-v9-administrator-conversions`, after the email-link, social-report,
Artist Follow and administrator lifecycle additions) adds mandatory unique constraints
and required nonunique cleanup indexes. A sparse, partial, hidden, wrong-key or
wrong-uniqueness substitute is rejected. TTL is opportunistic reclamation and is
never an authorization or admission decision. See the active plan for actual
verification and the remaining client/room rollout stages.
