# Listener and browser architecture

Product behavior remains defined in [business-rules.md](../business-rules.md).

<!-- @catalog -->
**Contents**

- [Listener public contracts and browser boundaries](#listener-public-contracts-and-browser-boundaries)
  - [Compatibility policy](#compatibility-policy)
  - [Native client compatibility](#native-client-compatibility)
  - [Browser module boundaries](#browser-module-boundaries)
  - [Verification](#verification)
- [Browser session recovery](#browser-session-recovery)
<!-- @end-catalog -->

## Listener public contracts and browser boundaries

`src/contracts/listenerV1.ts` is the canonical TypeScript DTO source for the
public `/api/listener/v1` catalog and composition responses. It imports neither
database models nor HTTP, storage, or browser libraries. The service imports these
types and annotates its response envelopes; existing service type exports remain
available for server callers.

The Web schemas in `web/src/api/contentSchemas.ts` and `collectionSchemas.ts`
validate wire data. `contentContractAlignment.ts` is compiled with the Web build
and checks both assignability and complete top-level keys against the canonical
DTOs. Each nested public DTO is also checked independently. Updating only one side
therefore fails type checking even when the difference is an optional field.

### Compatibility policy

- Finitude Web's public catalog and collection schemas discard unknown additive
  fields recursively before returning the parsed result to a query cache or UI.
  The native clients decode differently; see
  [Native client compatibility](#native-client-compatibility).
- Known fields still validate their requiredness, value type, bounds, enum, and
  reference relationships. A new discriminator or enum variant is not an additive
  field and requires a negotiated capability or a new major API contract.
- Missing `mediaType` defaults to Audio for the existing legacy wire contract;
  missing Search `organizations` defaults to an empty collection. These are the
  existing compatibility defaults, not general permission to invent missing data.
- Request schemas remain strict. Account/session responses retain their separate
  strict policy. Owner-scoped Library, saved-state, and Playlist responses retain
  their existing validation rules; shared public summaries use the public policy.
- The server must continue to construct allowlisted DTOs from database-confirmed
  ready content. Client stripping is compatibility handling, not authorization or
  permission for the server to send private fields. Existing server projection and
  lifecycle integration tests remain required security checks.

`contracts/listener/v1/fixtures/album-legacy.json` and `album-current.json` are
credential-free, database-independent JSON examples that native consumers can
load unchanged. The compatibility test reads both through the current parser and
reads the current fixture through an independent frozen baseline parser.

The frozen parser establishes the forward-compatible reader introduced by this
change. It does not retroactively change already-open historical Web clients
whose schemas used `.strict()`. Deploy this reader before introducing new wire
fields, and retain the existing response shape until those clients can refresh;
use a versioned endpoint or capability negotiation if an immediate incompatible
change is necessary. The fixtures must be extended with every wire addition, and
the frozen baseline reader must not be silently updated to make a test pass.

### Native client compatibility

The native clients do not share the Web stripping policy, so every listener
wire change must satisfy each decoder. Checked against Finitude_iOS 91589f0
and Finitude_Android 433ee43:

- iOS decodes Listener Home collection pages strictly. An unknown key in any
  object of the page, including summaries and Credits, rejects the whole page.
  Each byline (at most 500 Swift Characters) and Credit name (at most 200)
  must already be trimmed and contain no Cc or Cf scalar, or the page is
  rejected.
- Android ignores unknown keys while decoding, then validates collection pages
  and Album details. Each byline (at most 500 code points) and Credit name (at
  most 200) must be trimmed and contain no ISO control character; Cf is
  accepted.
- Web strips unknown fields at runtime, as described above, and
  `contentContractAlignment.ts` fails the Web build when its schemas and the
  canonical DTOs disagree.

While that iOS decoder is supported, an additive listener v1 field needs a
negotiated capability or a new contract. Credit join phrases therefore add no
field and reach clients only inside `displayByline`. A phrase that reaches a
byline has passed the same validation as a write, so it adds no Cc or Cf
character; an invalid stored phrase is shown as `, `. The shared byline
builder, `src/services/catalog/catalogByline.ts`, keeps every byline within
500 UTF-16 code units, which never exceeds either client's limit. It does not
rewrite stored names: a name with a Cf character, such as an emoji ZWJ
sequence, or a Credit name over 200 characters still fails native validation.

The legacy public catalog (`publicCatalogService.ts`) projects each Credit as
exactly the five fields that `PublicCatalogCredit` declares: `subjectType`,
`subjectId`, `name`, `role` and `order`. Earlier releases spread the stored
Credit and so also sent `creditId`. This makes the runtime match the declared
contract and is not a DTO shape change; neither Web nor the native clients
read `creditId` from public responses.

`test/support/nativeDisplayTextValidators.ts` ports both native checks, and
`test/listener/nativeBylineValidators.test.ts` replays server bylines through
them. Re-check the sibling repositories whenever either decoder changes.

### Browser module boundaries

`playerStore.ts` continues to own the single media element, immutable queue,
history, and transport state. `queueOrder.ts` contains only pure ordering and
queue-copy functions. `mediaSessionAdapter.ts` owns optional browser system-control
registration, snapshot publication, and cleanup; every system action delegates to
that same store. It does not create a player or queue, and browser integration
errors cannot escape into transport.

The store retains its derived upcoming queue array while queue identity, order,
current entry, order position, and Repeat mode are unchanged. Media-clock updates
still publish transport progress without allocating that array again.
`usePlayerQueue.ts` subscribes the lazy Now Playing pane only to queue-related
fields. The full player hook remains responsible for progress and transport UI.
The active room-track composer is another lazy boundary: signed-out and inactive
profile gates load their explanation before the larger composer.
Music-share cards load their existing Save button on demand. The shared Icon
keeps navigation and identity glyphs eager while deferring playback glyphs behind
the same SVG dimensions and accessibility props. These boundaries retain the
existing controls and the unchanged transitive JavaScript budget.

Persistent browser-session schemas remain in `schemas.ts`. Account-route request
and response validators live in `accountSchemas.ts`, so public browsing does not
eagerly initialize password-recovery and account-management validation chains.
This split preserves the validation policy and requires no dependency changes.

### Verification

Run `npm run typecheck --workspace @archtree/finitude-web` for cross-boundary type
alignment. From `web/`, run `npx vitest run src/api/contentSchemas.test.ts
src/api/listenerContractCompatibility.test.ts src/player/playerStore.test.ts
src/player/queueOrder.test.ts` for the focused wire and transport checks, followed
by the normal full test/build and Listener playback/release gates for a release.
The existing build measures every emitted entry's transitive gzip JavaScript
against the unchanged 150 KiB limit; architectural splitting must not raise that
limit merely to make the gate pass. Inspect future eager dependencies before adding them; the current budget has little spare capacity.


The deterministic presentation-test media helper now wraps the shared `video`
element as well as legacy `Audio` construction. Keyboard editing is tested with
an Audio track, because active Video intentionally hides the browse workspace.
Real stream/seek and media-continuity tests still exercise the browser media
pipeline; those gates are not replaced by this presentation test double.

## Browser session recovery

Cookie-changing operations remain serialized by the same origin-wide Web Lock.
`runBrowserSessionTransition` gives its callback an active scope. An account
mutation that already owns this lock passes the scope to the API client, which
refreshes inside that scope instead of queuing another transition or joining a
refresh waiting behind it. Scopes expire when their callback returns; an identity
transition also invalidates an older scope's reserved account generation.

Logout-all and account deletion retain their sequence: authenticated server
mutation, best-effort browser cookie cleanup, then account-state notification.
An expired access cookie can refresh once inside the existing lock. A failed
refresh releases the lock and returns a retryable failure to the confirmation UI;
when that refresh proved the session had already ended, the tab also signs out as
described below.
Storage-fallback cleanup never receives permission to install or rotate cookies.

A viewer-bound 401 whose locked recovery finds no session (session read 401,
rotation 401, then a second session read 401) proves the shared cookie session
ended elsewhere, for example through logout-all on another device. While its
guard is still current, the client advances the account epoch and publishes a
`logout` account-session change to this and every other tab, so live transports
such as the room session stop at once and the coordinator resolves the signed-out
state without a reload. Publishing changes no cookies. Unbound and bootstrap reads
never publish, so the coordinator's own signed-out read cannot loop, and a
rate-limited, unavailable, unreachable or lock-less recovery proves nothing.

Every automatic recovery retains the initiating account epoch and viewer. The
client checks this guard before recovery, after acquiring the lock, after each
session read or rotation, before conflict cleanup, and before retrying the
original request. A late 401 from an earlier account cannot clear the current
session. The same guard runs before processing a response and after decoding its
error body, so a late 409 cannot publish an account-mismatch reconciliation event.
Genuine conflicting access/refresh identities still use the existing
locked signed-out recovery. Refresh coalescing is scoped to the epoch, viewer,
and bootstrap mode; an operation in a replacement epoch cannot join stale work.
An aborted request does not retry its mutation after shared recovery completes.

Verification from `web/`:

```sh
npx vitest run src/api/client.test.ts src/api/session.test.ts src/api/sessionTransition.test.ts src/api/sessionRecovery.test.ts src/app/BrowserSessionCoordinator.test.ts src/features/social/roomSessionEndedSession.test.ts src/features/account/AccountLifecyclePanel.test.tsx
npm run typecheck
npm run typecheck:e2e
npm run build
npx playwright test e2e/session-recovery.spec.ts e2e/account-isolation.spec.ts --workers=1
```

The browser tests exercise the built production bundle with isolated mocked
credentials and real browser Web Locks. Chromium, Firefox, and WebKit remain
separate validation targets; an unavailable local browser dependency is an
environment limitation, not permission to skip that browser's release gate.
