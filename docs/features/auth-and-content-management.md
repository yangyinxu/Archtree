# Browser Auth and Content Management

<!-- @catalog -->
**Contents**

- [Web auth endpoints](#web-auth-endpoints)
- [Public Listener capability discovery](#public-listener-capability-discovery)
- [App session endpoints](#app-session-endpoints)
- [Recipient-domain check for authentication email](#recipient-domain-check-for-authentication-email)
- [Account roles](#account-roles)
- [Shared-content authorization](#shared-content-authorization)
- [Web content management](#web-content-management)
- [Artist carousels](#artist-carousels)
- [Personalized Library](#personalized-library)
- [User Playlists](#user-playlists)
- [Session behavior](#session-behavior)
<!-- @end-catalog -->

## Web auth endpoints

- `GET /auth/signup-web` and `POST /auth/signup-web`: `303` to
  `/account/register` without any account work (the POST body is ignored)
- `GET /auth/login-web`
- `POST /auth/login-web`
- `POST /auth/logout-web`

`GET /auth/login-web` renders the Kashewt-branded login surface, with links to
Kashewt sign-up and password recovery. `?notice=registered|verified|password_reset`
shows a fixed confirmation after those flows; any other value shows nothing. Its script
holds the shared origin-wide Web Lock while calling `POST /auth/browser/login`;
an HTML-only `POST /auth/login-web` fails closed with `409` and never installs
credentials or redirects to Finitude. An already-authenticated GET redirects
to its allowlisted `returnTo` destination.

Archtree logout forms use the same Web Lock to call
`POST /auth/browser/logout`, clear the departing account's local search
history, and return to `/`. The HTML-only `POST /auth/logout-web` remains
revoke-only and redirects to `/?sessionTransition=logout` for Archtree-side
completion; neither path redirects through Finitude.

Listener browser-session endpoints (HttpOnly cookies; credentials are never
returned to JavaScript):

- `GET /auth/browser/capabilities`
- `POST /auth/browser/registration/request`
- `POST /auth/browser/registration/inspect`
- `POST /auth/browser/registration/complete`
- `POST /auth/browser/email-verification/request`
- `POST /auth/browser/email-verification/inspect`
- `POST /auth/browser/email-verification/confirm`
- `POST /auth/browser/password/forgot`
- `POST /auth/browser/password/reset`
- `POST /auth/browser/login`
- `POST /auth/browser/refresh`
- `GET /auth/browser/session`
- `POST /auth/browser/logout`

## Public Listener capability discovery

- `GET /api/listener/v1/capabilities` returns only deploy-safe feature
  availability. The Web client uses its `playlists` boolean to hide Playlist
  routes and controls when the server-side rollout switch is off, and its
  `social: { enabled, rooms }` object (from `FINITUDE_SOCIAL_ENABLED` and
  `FINITUDE_ROOMS_ENABLED`; rooms is never true without social) to hide the
  Together navigation, Share, Listen together and room reminders. A missing
  object hides them too. Any `503 social_disabled`/`rooms_disabled` response
  makes the open page re-read these switches.

Email registration happens only on the Web, by emailed link:

- `POST /auth/browser/registration/request` takes `{ "email" }` and answers
  `202 {"message":"Check your email for the next step."}` for every account
  state. An address without an account, or with an unverified record from the
  earlier code-based sign-up, receives a single-use registration link
  (`AUTH_LINK_ORIGIN/account/register/complete#token=...`, 30 minutes). An
  address with an account receives an "already registered" notice with Log in
  and password-reset links, and nothing changes. An address whose domain
  cannot receive mail gets `422 {"code":"email_domain_undeliverable"}` instead
  (see the recipient-domain check below).
- `POST /auth/browser/registration/inspect` takes `{ "token" }` and does not
  consume it: `200 {"email"}`, `409 {"code":"email_already_registered"}` when
  the address now has an account, or `400 {"code":"link_invalid"}`.
- `POST /auth/browser/registration/complete` takes
  `{ "token", "password", "displayName" }` (display name 1 to 80 characters
  after trimming, no control characters). It returns `201 {"email"}` after it
  creates a verified account or completely replaces the address's unverified
  record (password, name, sessions, provider identities, passkeys, pending
  enrollments, codes and links). Errors are `400 link_invalid`,
  `409 email_already_registered`, and `422` with `code` `invalid_password` or
  `invalid_display_name`. It installs no session; the listener logs in next.
- `POST /auth/browser/email-verification/request` takes `{ "email" }` and
  answers `202` for every account state, or
  `422 {"code":"email_domain_undeliverable"}` when the domain cannot receive
  mail. Only an account created before verification existed (no
  `emailVerified` field and no linked identity with the same email) receives a
  verification link (`AUTH_LINK_ORIGIN/account/verify-email#token=...`).
- `POST /auth/browser/email-verification/inspect` takes `{ "token" }` and
  returns `200 {"email"}` or `400 link_invalid` without consuming it.
  `POST /auth/browser/email-verification/confirm` returns `204` after it
  verifies the email. It does not change the password or end other sessions.

Link tokens travel only in the URL fragment, so they never reach server logs,
proxies or `Referer`; pages read them with the non-consuming `inspect` calls,
and verification requires an explicit confirm request. All three link emails
(registration link, already-registered notice, verification link) share a
budget of three per normalized address per 15 minutes; requests over it get
the same response and send nothing (`auth_link_email_suppressed`).

Kashewt account pages (`src/routes/accountPageRoutes.ts`,
`src/views/account/accountViews.ts`, `src/public/account-forms.js`). Accounts
are Kashewt accounts shared by Finitude, Naruto Mobile and other projects, so
sign-up, emailed links and password recovery live here rather than in any one
app. The pages are static, `no-store` shells under the strict CSP; their
script calls the same `/auth/browser/*` endpoints:

- `/account/register` asks only for an email and shows the same "check your
  email" page for every address, with where the link went and **Use a
  different email**. It reads `GET /auth/browser/capabilities` and shows an
  unavailable notice when email registration is off.
- `/account/register/complete#token=...` reads the fragment once, removes it
  from the address bar and history entry, and inspects the link. It then shows
  the address and asks for a display name and password; success returns to
  `/auth/login-web?notice=registered` and never signs in. Invalid, expired or
  used links offer a new link, and an address that now has an account links
  to Log in and password recovery.
- `/account/verify-email#token=...` shows the address and verifies it only
  after **Verify email** is selected, then returns to
  `/auth/login-web?notice=verified`. Without a token, or after an unusable
  link, it offers a non-enumerating request for a new verification link.
- `/account/forgot-password` requests the six-digit code, and
  `/account/reset-password` applies it with a new password, then returns to
  `/auth/login-web?notice=password_reset`.
- Email fields show `422 email_domain_undeliverable` on the field, which
  receives focus, and keep the generic error for every other failure. While
  the listener types, a domain within a small Damerau-Levenshtein distance of a
  popular provider (`src/public/email-suggestion.js`, covered by
  `test/account/accountPages.test.ts`) gets a "Did you mean ...?" button that replaces
  the address only when selected.

Finitude Web has no account lifecycle pages of its own. The server answers
`/finitude/register`, `/finitude/register/complete`, `/finitude/verify-email`,
`/finitude/forgot-password` and `/finitude/reset-password` with a `303`
redirect to the matching `/account/*` page (browsers keep a `#token=`
fragment across it). That keeps the iOS and Android **Create Account on the
Web** buttons, which open `/finitude/register`, and links from older emails
working. Finitude's Log in (`/finitude/login`) keeps its form and links to
**Forgot password?**, **Create account** and, after
`403 email_verification_required`, the verification-link request as
full-page links to those Kashewt pages; Account links an unverified address
to `/account/verify-email` the same way.

A sign-in that presents a valid credential (password through `/auth/login` or
`/auth/browser/login`, a passkey assertion, or a linked Apple or Google
identity) for an unverified account returns
`403 {"code":"email_verification_required","message":"Verify your email to sign in. ..."}`
and creates no session; the browser login leaves existing cookies untouched.
After responding, the server mails a verification link to an account created
before verification existed, or a registration link to an unverified record
from the earlier code-based sign-up, within the shared budget. A wrong
password still returns `401`. Sessions, refresh tokens and cookies that
existed before verification became mandatory keep working; `GET /auth/me` and
the browser session payload report `emailVerified: false` for them. Linking a
provider or enrolling a passkey from such a session returns `403` with the
same `code` and sends no email.

Browser authentication mutations require same-origin JSON. Registration,
verification-link, and recovery-request responses are deliberately generic
so account existence is not disclosed. They send the generic response before
the account lookup, token write and email delivery, so response latency does
not reveal account state either. The `422 email_domain_undeliverable`
rejection is decided from the domain's public DNS before any account lookup,
so it does not depend on account state either. The account work still runs
inside the tracked request: graceful shutdown waits for it, and a late failure
is recorded only as an opaque security event. Registration and
verification-link requests hash no password and take no concurrency slot, so
none of their `429` responses depend on account state.
Browser capability discovery reports only end-to-end browser methods;
native Apple, Google, or passkey configuration does not expose a nonfunctional
listener button.

## App session endpoints

- `GET /auth/capabilities`
- `POST /auth/login`
- `POST /auth/password/forgot`
- `POST /auth/password/reset`
- `POST /auth/password/change`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/logout-all`
- `GET /auth/me`
- `GET /auth/avatar`
- `PUT /auth/avatar` with `If-Match` and `Idempotency-Key`
- `DELETE /auth/avatar` with `If-Match` and `Idempotency-Key`
- `GET /auth/sessions`
- `DELETE /auth/sessions/:id`
- `DELETE /auth/identities/:provider`
- `DELETE /auth/activity/listening-history`
- `DELETE /auth/account`

Native authentication requests can declare `X-Finitude-Device-Type` as
`android-phone` or `android-tablet`. The older `phone` and `tablet` categories
remain iPhone and iPad for existing iOS clients. Archtree stores a fixed friendly
label for these allowlisted categories; arbitrary device names are ignored.
This applies to newly created sessions and does not rewrite older stored labels.

Retired code-based registration endpoints answer immediately, before
validation, rate limiting or any database access, with
`410 {"code":"email_registration_moved","message":"Email sign-up has moved to the Finitude website. Create your account there, then sign in."}`:
`POST /auth/signup`, `PUT /auth/signup`, `POST /auth/email/verify`,
`POST /auth/email/resend-verification`, `POST /auth/browser/register`,
`POST /auth/browser/email/verify`, and
`POST /auth/browser/email/resend-verification`.

Password recovery (`POST /auth/password/forgot` and
`POST /auth/browser/password/forgot`) takes `{ "email" }` and answers
`202 {"message":"If the account can use this action, an email has been sent."}`
for every account state, or `422 {"code":"email_domain_undeliverable"}` when
the domain cannot receive mail. A verified or legacy account receives a
six-digit reset code (15 minutes, voided by its fifth wrong submission). An
unverified record from the earlier code-based sign-up receives a registration
link instead, and `password/reset` never applies to it. A completed reset
revokes every session and sets `emailVerified: true`; on an account that was
not verified before, it also removes every provider identity, passkey and
passkey challenge.

## Recipient-domain check for authentication email

`src/services/auth/emailDomainDeliverability.ts` decides from the recipient
domain's MX records whether an address can receive mail:

- `deliverable`: at least one MX record that is not an RFC 7505 null MX (`.`).
- `undeliverable`: `ENOTFOUND` (NXDOMAIN), `ENODATA` (no MX records), only a
  null MX, or a domain that is not a valid hostname. There is deliberately no
  fallback to A/AAAA records (the RFC 5321 implicit MX): mistyped domains are
  often parked with only an A record.
- `unknown`: any other DNS failure (timeout, `SERVFAIL`, refused, network).

The verdict is applied at two points:

1. Before the response, on every route that emails a submitted address:
   `POST /auth/browser/registration/request`,
   `POST /auth/browser/email-verification/request`,
   `POST /auth/password/forgot` and `POST /auth/browser/password/forgot`.
   `rejectUndeliverableEmailDomain` runs after the per-IP limit and email
   validation, and before the per-account limit and any account lookup. An
   `undeliverable` verdict answers at once with
   `422 {"code":"email_domain_undeliverable","message":"This email domain cannot receive email. Check the address and try again."}`:
   nothing is looked up, prepared or sent, the per-account attempt limit and
   the link-email budget are not spent (the per-IP limit is), and the security
   event `auth_email_domain_rejected` records only `domain` and `reason`
   (`nxdomain`, `no_mx`, `null_mx` or `invalid_domain`). The verdict depends
   only on the domain, never on account state, so the `422` is identical for
   every account state. `deliverable` and `unknown` continue exactly as
   before, with the generic `202` and the account work after it. The response
   now waits for the domain lookup, whose latency also depends only on the
   domain. Invalid input keeps the generic validation `422` without a lookup.
2. Before sending, in `sendAuthEmail`, for every authentication email, as
   defense in depth: it covers the sign-in verification email, which goes to
   the account's stored address after a `403`, and a domain that was `unknown`
   when the request arrived. It runs before a link token or reset code is
   written, so a skipped email never voids a code that was already delivered.
   An `undeliverable` verdict skips the email, still spends the address's
   link-email budget like a failed delivery, and records
   `auth_email_undeliverable_domain` with `domain`, `emailKind`
   (`registration_link`, `already_registered_notice`, `verification_link` or
   `password_reset_code`) and `reason`. An `unknown` verdict fails open: the
   email is sent and `auth_email_domain_check_failed` records `domain`,
   `emailKind` and the DNS error code as `reason`. This check runs after the
   response, so it changes no status, body or latency.

No event records the address. Domains are trimmed, lowercased, stripped of one
trailing root dot and converted to punycode when internationalized. Only the
request check caches verdicts, in process for up to 1,000 domains, deliverable
ones for 1 hour and undeliverable ones for 10 minutes; `unknown` verdicts are
not cached. The send check reuses a cached verdict but never caches its own: it
runs only for the account states that receive an email, so a verdict it cached
(for example after the request check failed under flaky DNS) would make a later
request for any address at that domain answer sooner and reveal an account.
Each lookup is bounded at 3 seconds. Concurrent request checks for one domain
share one query, and a send check may join a request check's query but never
the reverse, so the request check and the later send check normally cost a
single lookup.

There is no configuration. Lookups use the host's system name servers through
`node:dns`, so the instance needs outbound DNS; without it each email request
waits up to the 3-second bound, then proceeds with the generic `202`, and every
email is still sent and logged as `auth_email_domain_check_failed`.
In local development, addresses at reserved domains such as `example.test` are
rejected with `422 email_domain_undeliverable`, so use a real mailbox domain to
receive email. Server tests preload a synthetic resolver
(`test/support/syntheticMxResolver.ts`) and never query real DNS. The listener
E2E server (`web/e2e/support/serveBuiltApp.ts`) installs
`web/e2e/support/syntheticMx.ts`, which treats only reserved `.invalid` domains
as undeliverable; the fake account routes in
`web/e2e/support/emailLinkAuth.ts` apply the same rule.

Auth attempts are limited per IP (20 per 15 minutes) and per account (10 per
15 minutes). Registration and verification-link requests and password
recovery and reset, in both their app and `/auth/browser/*` forms, key the
account limit on the submitted `email` after validation normalizes it, so
Gmail dots, `+tag` suffixes and `googlemail.com` count as one address and
extra `identifier` or `username` fields are ignored.
Password sign-in keys it on the submitted login identifier, and both kinds of
route draw from the same budget for the same address. A request rejected with
`422 email_domain_undeliverable` counts toward the per-IP limit only.

`POST /auth/refresh` does not use the sign-in buckets. It is limited per
presented refresh token (10 per 15 minutes, keyed by a SHA-256 digest; a
request without a usable token falls back to a per-IP bucket of the same size)
under a separate per-IP ceiling of 600 per 15 minutes, so failed sign-ins
cannot turn a valid refresh into `429` and refresh traffic cannot consume
sign-in attempts.

## Account roles

- Public registration and federated sign-in create ordinary `user` accounts.
- Only the exact database role `admin` grants shared-content management access;
  missing, legacy, or unknown role values are treated as `user`.
- There is no public role-promotion endpoint. An operator may promote or demote
  one verified account by updating that account's `users.role` field directly
  to `admin` or `user`, using an exact `_id` match and verifying that exactly
  one record matched.
- Authorization reloads the current database role for each request, so a role
  change applies without trusting a stale role claim from an access token.
- `createdBy` remains internal provenance. It does not grant an owner/creator
  role and never lets an ordinary user mutate shared content.

## Shared-content authorization

- Artist, Album, MediaTrack, media upload, Page, Carousel, Grid/List,
  relationship, and Feed Post mutations require authentication and the exact
  database-backed `admin` role.
- Authentication and admin authorization run before JSON/form parsing for
  shared mutations and before multipart decoding, temporary-file creation,
  upload throttling, or controller work.
- Public Catalog, Search, Home, Feed, artwork, and ready stream reads do not
  require authentication and do not filter by `createdBy` or viewer role.
- Personal `/content/me/*`, account, avatar, session, activity, Save, Library,
  download, and own-Playlist operations remain owner-scoped rather than
  administrator-only.

## Web content management

- Every Content Manager page, search, form, upload, and backing shared-content
  mutation is administrator-only. Anonymous browser requests are sent to login;
  an authenticated non-admin receives `403`.
- `GET /content/manage`
- `GET /content/manage/audio-tracks`
- `GET /content/manage/search`
- Administrator inventory is global rather than `createdBy`-scoped. Artist,
  Album, MediaTrack, Page, Carousel, and Grid/List sections use stable bounded
  pagination; internal provenance remains available for audit.
- Create/update/delete forms for Artists, Albums, and MediaTracks
- Content Manager is organized into Overview, Catalog, Page Layout, and
  Operations views. Artist workspaces manage named Album memberships without
  copying database IDs and can create a new Album already linked to the Artist.
- The Content Manager header uses the Archtree brand as its Home link and keeps
  session exit inside an administrator account disclosure. MediaTrack
  operations plus Audio and Image storage audits are grouped in Operations
  instead of competing with the active workspace as header actions.
- Catalog presents one global inventory type at a time through server-backed
  Artist, Organization, Album, MediaTrack, Page, Carousel, and Collection
  navigation. Linked records, creation forms, raw-ID access, and advanced
  relationship tools remain available through native disclosures instead of
  expanding the whole administration surface at once. An Artist, Album,
  MediaTrack, or Organization opened from Edit is promoted into a focused
  workspace and the inventory is removed until the administrator returns.
  Database IDs remain available through explicit copy actions instead of being
  primary labels.
- Page Layout leads with the current Page hierarchy. Page placement, Carousel
  configuration, and manual-item maintenance are grouped into collapsible
  tools; Page and Carousel reorder controls support both drag-and-drop and
  Move up/Move down buttons.
- Page attachment is confirmed only after its transaction succeeds. The
  administrator-only `POST /content/pages/:slug/items/carousel` and
  `POST /content/pages/:slug/items/collection` endpoints return
  `409 page_attachment_not_applied` when the Page reaches its 100-item limit
  or disappears after the initial lookup. Existing items remain unchanged;
  refresh the Page before retrying. The Carousel attachment form reports the
  same failure instead of showing a successful placement.
- Operations links the focused MediaTrack and storage-audit workspaces, shows
  the retained step status for each guided Artist release, links completed
  content back to its workspace, and only offers retry when an operation needs
  attention. MediaTracks can be filtered together by search, storage lifecycle
  status, and Album assignment.
- The guided Artist release setup creates or reuses an Artist, creates and
  links an Album, and can optionally create a dynamic Album Artist Carousel
  and attach it to Home or Library in one reviewed submission.
- Guided setup uses a retained, administrator-scoped operation record. Reusing
  the same setup token is idempotent; partial failures keep completed IDs and
  expose a retry action that resumes from the first incomplete step.
- Artist metadata and Artist–Album relationship actions use non-upload routes.
  Only file-capable endpoints consume shared upload concurrency capacity.
  Authenticated administrator shared-catalog uploads have no hourly
  request-count quota; concurrency responses still include `Retry-After`.
- Album and MediaTrack attribution is managed as ordered role-bearing Credits
  for Artist and Organization subjects. Compatibility `artistIds`, `albumIds`,
  and flattened bylines are projected by the server during client migration.
- The Content Manager Credit editor supports named subject search, role
  changes, ordering, removal, Organization-only attribution, and an explicit
  `Attribution not documented` state. Dynamic Artist Carousels can target
  Discography, Collaborations, Appears On, or all related Credits. Album
  carousels share the Artist detail classification and rollout switches, apply
  ready lifecycle and role precedence before the result limit, and use legacy
  relationships only for records without canonical Credits.
- A Credit may store a join phrase for server bylines. The Content Manager
  shows each Credit's phrase except the last one's and sets or clears it with
  `POST /content/manage/credits/update-join-phrase` (`ownerType`, `ownerId`,
  `creditId`, `joinPhrase`, `creditRevision`); an empty value clears it, and
  the same validation as the administrator catalog applies. The form carries
  the Credit revision it was rendered with, so a missing revision or any
  Credit change made after the page was drawn asks for a reload instead of
  attaching the phrase to a different next name. Role changes keep every
  phrase. Additions, removals, reordering and legacy artist-ID edits keep a
  phrase only while the same Credit still follows it, and every rebuild drops
  an invalid stored phrase. Disc Numbers are not editable in the Content
  Manager.
- Manual Carousel and Grid/List additions, reorder operations, and moves read
  their current contents inside the same MongoDB transaction as the reference
  fences and writes. Concurrent appends preserve both edits and the 500-item
  limit; positional edits return `409 manual_composition_changed` if transaction
  retry observes changed contents. Refresh the editor before resubmitting a
  positional edit. Adds rejected by the current size limit or a concurrently
  deleted definition also return that conflict rather than reporting success.
  Cross-Carousel moves commit both sides or neither.
- Single and bulk Content Manager Audio MediaTrack creation records original
  filenames and a pending upload state before sending files to S3. They accept
  Artist Credits, Organization Credits, inherited Album primary Artists, or an
  explicitly undocumented attribution state. Inherited primary Credits keep
  their Album order; each keeps its join phrase only when the next Album Credit
  is inherited too, so a phrase never introduces a name it was not written for.
- Single and bulk Content Manager Audio creation and the legacy
  `/content/audioTrack` endpoint store the file's embedded Track Number and,
  when the file carries a valid one (1–999), its Disc Number with
  `discNumberSource: 'embedded'`. A missing or invalid disc tag stores neither
  key, and Album order treats that MediaTrack as disc 1. Each bulk file is read
  independently, so one invalid tag never affects another file.
- The legacy `/content/audioTrack` creation endpoint continues to require an
  existing Artist during the compatibility window and can be disabled with
  the Catalog Credit legacy-write cutover switch.
- Artist responses no longer expose the legacy `audioTrackIds` field. Clients
  find an Artist's MediaTracks by querying the compatibility `audioTracks`
  resource whose `artistIds` contains the Artist ID.
- Content Manager reference fields validate IDs against the expected shared content type before saving.
- Artist, Album, and MediaTrack create/update forms accept optional JPG, PNG,
  or WebP cover art through the `coverArtFile` multipart field.
- Cover art is stored in the private S3 bucket and referenced by `coverArtId`. API responses derive `coverArtUrl` as `/content/images/:imageId`.
- New Artist/Album cover art reaches ready storage before the owner is inserted;
  the ready owner and exact `coverArtId` are then published in one insert, so a
  failed upload cannot expose a partially created catalog record.
- Replacing cover art attaches the new image before deleting the old object.
  For an existing owner, the post-S3 `pending` to `ready` transition rechecks
  owner readiness and commits with an exact lifecycle CAS in one short
  transaction. Deletion retains the owner and evidence while a Put is pending;
  whichever owner fence commits first determines whether deletion proceeds or
  the uploader removes the exact newly written key. A lost staging or
  finalization response proceeds only after an exact pending/ready lifecycle
  readback; otherwise it preserves the evidence and requires reconciliation.
  Deleting an Artist, Album, or MediaTrack retries every current or detached
  asset recorded for that owner before removing the owner; a storage failure
  keeps the owner and lifecycle evidence retryable.
- Existing MediaTracks support replacing the one active object with either an
  Audio file or a supported Video file.
- S3 bucket storage usage and an estimated monthly storage-only charge (requires the S3 `ListBucket` permission)

## Artist carousels

- Manual carousels keep an explicitly managed item list.
- Manual carousels can be renamed without changing their items.
- Carousels stored before the `mode` field existed (no or empty `mode`) are
  read as manual by the listener API and the content-reference report, and the
  cleanup of deleted Album, MediaTrack, and Feed Post references removes their
  items the same way. That cleanup also covers Grid/List definitions without a
  `mode`; it never changes dynamic definitions.
- Deleting a Feed Post first removes its items from every manual carousel and
  renumbers the remaining items, then deletes the Post. A failed cleanup keeps
  the Post so the delete can be retried; repeating the delete is idempotent.
- Artist carousels dynamically resolve either Albums or MediaTracks for one existing Artist.
- Album carousels use the Artist's `albumIds`; MediaTrack carousels query the
  compatibility `AudioTrack.artistIds` field.
- Dynamic results support newest-release or title sorting and a configurable limit from 1 to 100.
- Artist carousel items cannot be manually added, reordered, or moved between carousels.

## Personalized Library

- Finitude Web `/finitude/library` opens a personal overview with My Playlists
  (when the existing service capability is enabled), Saved music, and Recently
  played. `?section=playlists`, `?section=saved`, and `?section=recent` open
  those destinations. Save remains the existing single saved-content state.
- `GET /api/listener/v1/library` keeps its saved-content DTO, filters, sorting,
  and cursor pagination. Optional `q` is a literal case-insensitive title
  search, at most 100 characters, applied before pagination. Web All / Albums /
  Songs filters are mutually exclusive; the compatibility API still accepts
  multiple types. Change filters/search/sort with a fresh cursor.
- `GET /api/listener/v1/recently-played` accepts no query parameters and returns
  `{ items: [{ content, playedAt, saved }], limit: 20 }`. `content` is an
  allowlisted ready Album or MediaTrack summary. The response preserves the
  newest-first personal activity window and omits missing/non-ready content.
  It requires authentication and the current-account viewer fence, uses
  private/no-store caching, and never changes Save state. This read does not
  depend on administrator-configured Home carousels.
- Playlist availability remains controlled by `FINITUDE_PLAYLISTS_ENABLED`;
  production defaults to disabled until its existing rollout prerequisites
  pass. The Library does not override that deployment decision.

- Authenticated users can save and unsave Albums or MediaTracks through
  `/content/me/saves/:contentType/:contentId`.
- Both `/content/me/library` and `/api/listener/v1/library` return private,
  allowlisted DTOs rather than catalog storage/lifecycle records. Existing
  non-ready saves remain visible as unavailable, with no stream URL; the legacy
  native Album shape retains an empty `audioTrackIds` field and resolves detail
  order separately.
- `POST /content/me/saves/status` resolves saved state for up to 100 visible
  items, and `POST /content/me/recently-played` records explicit playback
  actions.
- Recently Saved and Recently Played carousels mix Albums and MediaTracks and
  resolve for the viewer requesting an expanded page.
- Artist Follow is a separate private relationship. `POST
  /content/me/artist-follows/status` accepts exactly `{ "artistIds": [...] }`
  with at most 100 hexadecimal IDs and returns input-ordered `items` containing
  `artistId`, `following` and nullable ISO `followedAt`. `PUT` and `DELETE
  /content/me/artist-follows/:artistId` return that same individual status.
  All routes require existing Bearer authentication or the cookie viewer fence,
  return `private, no-store`, and never accept a client-selected owner. Repeated
  Follow preserves the original timestamp; repeated Unfollow succeeds even for
  an unavailable/deleted Artist. Only ready Artists accept Follow. Account and
  Artist write fences serialize Follow against either deletion; account cleanup
  is transactional, and failed Artist cleanup retains lifecycle evidence.
- `GET /api/listener/v1/personalization-capabilities` is public and `no-store`:
  `{ "contractVersion": 1, "deterministicDiscovery": false, "artistFollows": false }`
  (the final Boolean reflects the independent flag). The old capability DTO is
  unchanged. This release does not implement deterministic Discovery.
- Administrators can configure a personalized Carousel with source
  `followedArtistReleases` and an integer limit of 1–20. Both Home projections
  require `X-Finitude-Personalization-Version: 1`, a signed-in viewer, the enabled
  flag and eligible results. Otherwise only this section is omitted; other
  configured sections retain their order. The shared resolver returns ready
  releases dated today through 89 previous UTC days, using canonical Artist
  Credit roles and independent Album-family qualification from the shared rules.
  Each contextual Home item may carry
  `{ "reason": { "code": "followedArtist", "artist": { "id": "...", "name": "..." } } }`;
  public content summaries and expanded `included` objects never gain this field.
- Startup revision `required-indexes-v12-catalog-cover-uploads` requires the
  unique `artistFollows(userId, artistId)` index, owner/follow-date and
  Artist/owner cleanup indexes, and the Album/MediaTrack descending
  calendar-date indexes. The resolver uses those date indexes, bounded equality
  joins and a 3-second database deadline per content class; it does not load an
  unlimited Follow ID list or add an arbitrary account Follow cap. Missing
  required indexes prevent readiness. Keep the feature disabled until the
  additive index rollout and both Home compatibility projections have been
  verified.
- Shared synthetic contract fixtures live in `test/fixtures/personalization/v1`.
  After updating the canonical files and their SHA-256 manifest, run
  `node scripts/sync-personalization-fixtures.mjs` to copy the exact corpus to
  sibling iOS/Android test resources. Run
  `node scripts/sync-personalization-fixtures.mjs --check` to verify canonical
  hashes and byte equality without writing files. These fixtures prove contract
  compatibility, not production enablement or real-account acceptance.
- Each recent history is capped at 20 mixed-content entries; the full saved
  relationship is retained separately.
- Library items expose `lastPlayedAt` and `lastActivityAt`. A new save seeds
  `lastPlayedAt` from the item's Recently Played entry when one is still in
  the 20-entry history. `DELETE /auth/activity/listening-history` empties
  Recently Played and, in the same account-fenced transaction, removes
  `lastPlayedAt` and resets `lastActivityAt` to `savedAt` on that listener's
  saves. Like Save and Unsave, it fails with 409 instead of writing once the
  account has been deleted.
- Expanded page responses include allowlisted resolved Album, MediaTrack, and
  Feed Post documents in an additive `included` payload. Referenced Posts are
  hydrated independently of the default Feed page, so older configured items
  remain discoverable.
- Included MediaTracks expose `displayCoverArtUrl`, resolving MediaTrack-specific
  cover art first and linked album cover art second. Linked albums used for
  this resolution are also included without transferring image ownership.
- Album cards read `Album.title`, while MediaTrack cards read the compatibility
  `AudioTrack.title`; correct album text does not verify the encoding of a
  legacy track title.
- MediaTrack titles and original filenames are normalized when read, created,
  or updated. Expanded Home and Library responses must apply the same
  normalization even though they resolve included tracks directly from the
  database.
- The iOS client accepts an `ARCHTREE_AUTH_BASE_URL` Info.plist value for
  authenticated traffic. Release builds require HTTPS; DEBUG builds additionally
  permit HTTP only for `localhost` and `127.0.0.1`.

## User Playlists

- Authenticated listeners manage private, owner-only Playlists under
  `/content/me/playlists`. Reads accept either the native Bearer session or the
  Web HttpOnly-cookie session, return only allowlisted DTOs, and use
  `Cache-Control: private, no-store`.
- `GET /content/me/playlists?limit=&cursor=` returns newest-updated summaries;
  `POST /content/me/playlists` creates one empty Playlist; and
  `GET`, `PATCH`, or `DELETE /content/me/playlists/:playlistId` reads, renames,
  or deletes an owner-scoped Playlist.
- Playlist summary and detail DTOs include a non-persisted `artworkUrl`. Read
  projection scans persisted member order and selects the first MediaTrack
  that is published, has `uploadStatus: ready`, an identity-bound `s3Key`, and usable track-specific or
  inherited Album artwork. Missing, pending, deleting, unsafe, or artwork-free
  candidates are skipped; `artworkUrl: ""` instructs clients to render the
  Finitude placeholder. List projection is bounded to 100 Playlists and 500
  member candidates each, using page-wide MediaTrack and Album reads rather
  than one catalog query per Playlist. Only single-slash same-origin paths and
  credential-free HTTPS artwork URLs are returned.
- `POST /content/me/playlists/:playlistId/items` adds one ready MediaTrack,
  optionally at a zero-based `position`;
  `DELETE /content/me/playlists/:playlistId/items/:itemId` removes one exact
  membership; and `PUT /content/me/playlists/:playlistId/items/order` accepts
  the complete current `itemIds` permutation.
- `GET /content/me/playlists/memberships?audioTrackIds=id1,id2` returns only
  the current owner's Playlist IDs containing up to 50 requested MediaTracks,
  so Add controls can show existing membership without exposing names or
  another account's data.
- Every mutation requires `Idempotency-Key`, replayable for 24 hours. A replay
  returns the original success status and rehydrates the current owner detail;
  if that Playlist was subsequently deleted, a non-delete replay returns the
  same owner-safe `404`, while a Delete receipt continues to replay `204`.
  Mutations of an existing Playlist also require its quoted revision ETag in
  `If-Match`; missing revisions return `428` and stale revisions return `409`.
  Every cookie-authenticated Web Playlist request also sends
  `X-Finitude-Account-Viewer` so a stale browser tab cannot read or mutate the
  newly switched account's private data. Bearer-authenticated native requests
  remain bound to their access-token identity.
- Web retains one uncertain Playlist creation intent (original name and key)
  in account-scoped tab memory across dialog closure and route changes. Reopen
  Create to retry that intent explicitly, or choose Stop retrying before
  starting another. This does not delete a Playlist that may already exist.
  Confirmed responses refresh the current account's cache; late responses from
  a previous account are ignored. Recovery ends on account transition or full
  page reload, and a retained intent cannot be replayed after its 24-hour
  receipt window. Same-name Playlists remain supported.
- Names contain 1–100 trimmed Unicode characters. Each account may own at most
  100 Playlists, each containing at most 500 unique MediaTracks. Playlist order
  is explicit; unavailable members remain represented but only ready members
  are projected into playback.
- Playlist writes own no S3 objects. Deleting a Playlist does not unsave or
  delete its MediaTracks, and deleting a MediaTrack or listener account cleans
  Playlist references through the database lifecycle before final removal.

## Session behavior

- API login returns a short-lived access token and a rotating opaque refresh
  token. `authSessions` stores only SHA-256 hashes; the immediately previous
  hash is also retained so logout wins a refresh race and a lost rotation
  response can be recovered.
- Access tokens default to 15 minutes. Refresh sessions have an absolute
  lifetime of 30 days by default.
- Refresh rotation is atomic: the current token rotates at most once, which
  moves its hash to `previousRefreshTokenHash` and stamps `rotatedAt`. For 60
  seconds after `rotatedAt`, presenting that previous token replaces only the
  current hash with a fresh one (both `/auth/refresh` and
  `/auth/browser/refresh`), so the pair from a lost response stops working and
  the session keeps exactly one current token. Such a replay leaves
  `previousRefreshTokenHash` and `rotatedAt` unchanged, so it cannot extend
  its own window, and emits a `refresh_previous_token_replayed` security
  event. Older tokens, the previous token after the window, and sessions last
  rotated before `rotatedAt` existed get `401` without any session change.
- Reset-code consumption, password/email effects, and session/listening/room
  revocation commit together. Failed transactions leave the original code,
  credential, and sessions available for a safe retry. Password login rechecks
  its verified password hash when committing the session, so a concurrent
  reset cannot be bypassed by a delayed login.
- `authActionTokens` keeps one hashed password-reset code slot per account. A
  wrong code increments the slot's `failedAttempts` inside the account
  transaction; the fifth wrong submission voids the code (`voidedAt`). Codes
  stored before per-account slots existed are no longer accepted. Verification
  slots left by the earlier code-based sign-up are ignored and expire through
  the TTL index.
- `emailLinkTokens` stores registration and verification links only as
  `HMAC-SHA256(AUTH_CODE_PEPPER ?? JWT_SECRET, "email-link:v1:<purpose>:<token>")`
  in `_id`, with `purpose`, the normalized `email`, `userId` (verification
  links only), `createdAt`, `expiresAt` (30 minutes) and `consumedAt`. Raw
  tokens (32 random bytes, base64url) exist only in the outgoing email.
  Consuming a link deletes the address's other links of the same purpose in
  the same transaction; expired links leave through the TTL index. Account
  deletion removes an account's links by `userId`.
- `users.emailVerified` keeps three stored forms and is never backfilled:
  `true` (verified), `false` (an unverified record from the earlier code-based
  sign-up, kept until it is replaced), and absent (created before
  verification existed; verified only while a linked Apple or Google identity
  stores the same lowercase email). Completing registration for a `false`
  record replaces the document in place (same `_id`) with only the new
  credentials, `emailVerified: true` and `emailVerifiedAt`, and removes its
  sessions, identities, passkeys, challenges, codes and links in one
  account-fenced transaction. The `pendingRegistration` field that the earlier
  sign-up stored disappears with that replacement.
- Session creation for any sign-in method returns `403` with
  `code: "email_verification_required"` unless the account is verified, and
  provider linking and passkey enrollment also return that `403` for such an
  account. Access-token checks and refresh do not check verification.
- Provider unlink checks the remaining recovery methods inside the account
  transaction. Account-owned sessions, identities, passkeys, codes, and
  challenges share the account deletion fence; discoverable passkey challenges
  can still be issued without an account. Authenticated credential changes
  recheck their session before writing.
- Protected requests verify that the access token's backing session is still
  active, allowing logout and logout-all to revoke access immediately.
- Optional-auth reads (`GET /api/listener/v1/home`,
  `GET /api/listener/v1/pages/home/items/:itemId`, and the legacy
  `GET /content/pages/:slug/expanded` for public pages such as Home) still
  serve requests without credentials anonymously. A presented
  `Authorization: Bearer` token that is expired, revoked, or malformed returns
  `401` before the account-viewer check so native clients refresh instead of
  silently receiving anonymous content or `account_viewer_mismatch`.
- Web login stores the access and refresh credentials in separate HttpOnly
  cookies and rotates them transparently when the access cookie expires.
- Cookie-authenticated Web requests for account-owned or personalized reads
  and writes send `X-Finitude-Account-Viewer` with the identity currently
  projected by the tab. The server validates it before controller work and
  echoes the same header on a successful private response. Missing or stale
  identity returns `409` with stable code `account_viewer_mismatch` without
  reading or mutating the replacement account. `GET /auth/browser/session`
  remains the unbound authoritative identity resolver, and native Bearer
  requests remain bound to their access-token identity.
- Web publishes login, logout, logout-all, account deletion, and viewer
  mismatch transitions across tabs using BroadcastChannel with a bounded
  storage-event fallback. A transition cancels in-flight queries, hides the
  previous session, removes every non-session query cache, and refetches the
  authoritative browser session; detached late responses cannot repopulate
  those caches. Account changes are intentionally treated as security
  boundaries, so public catalog data may refetch afterward.
  Storage or BroadcastChannel unavailability does not block the originating
  authentication action.
- Social reads are serialized within an account epoch. An active read has a
  30-second deadline covering response-body decoding and existing transient
  transaction retries; queue waiting time is excluded. Caller cancellation
  settles immediately, and an account transition cancels and discards the old
  queue so it cannot block the next epoch. Cancellation or a deadline does not
  establish that the server stopped processing the request.
- Playback activity captures the viewer and account epoch before awaiting
  playback start. A delayed start cannot report the previous account's activity
  or invalidate the replacement account's cache.
- Listener avatar reads bind private bytes to the requesting account and
  authoritative revision; a stale account projection receives no image bytes.
- Listener avatar writes and destructive account actions also bind to the
  account projected in the page. A stale tab receives a conflict instead of
  mutating whichever account most recently replaced the browser cookies.
- Avatar uploads require `Content-Length`, one `avatar` file no larger than
  5 MiB, no text fields, and a total multipart envelope no larger than 6 MiB.
  Total-size admission runs before in-memory multipart parsing; the parser
  separately enforces file size and file/field/part counts.
- Avatar mutations reserve a pending account-scoped lease in the same
  transaction that touches the active account. Leases last 30 seconds and
  renew every 10 seconds. A retry first resumes expired work using its recorded
  phase; every owner publication and asset cleanup claim checks that lease
  transactionally, so a late worker cannot overwrite or delete its successor.
  Pending receipts do not expire. Startup removes the old `expiresAt` field
  from pending avatar receipts; completed responses retain a 24-hour TTL.
  Account deletion takes the account fence and refuses to commit while an
  avatar reference, pending lease, or any current/detached private avatar
  lifecycle record remains. Once no avatar or private image asset remains,
  account deletion can retire expired `reserved` and `cleared` receipts in
  that same transaction; other pending states, including legacy, active, or
  uncertain operations, continue to block removal.
- A recovered legacy receipt without phase information, or an upload without
  a confirmed S3 response, preserves its image lifecycle evidence and returns
  an explicit recovery outcome. A new key can start a new operation; uncertain
  storage cleanup remains pending until an operator reconciles exact versions.
- Protected web pages redirect to login if unauthenticated. Content Manager
  additionally requires the current database role to be `admin`.
