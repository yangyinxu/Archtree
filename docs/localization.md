# Finitude Localization Contract

This document defines the technical localization contract shared by Archtree,
Finitude Web, Finitude iOS, and Finitude Android. Product behavior that users
can rely on is canonical in `docs/business-rules.md`.

## Decision summary

- Use canonical BCP 47 language tags everywhere. Filenames use the same tag,
  including its conventional casing: `en-US.json`, `zh-Hans.json`, and
  `zh-Hant-TW.json`. Do not use underscores such as `en_us.json`.
- Keep one flat JSON object per published locale. Stable semantic keys map to
  ICU MessageFormat messages.
- Treat the locale JSON files as the only manually maintained translation
  source. Build tooling derives platform-owned iOS and Android resources from
  the same reviewed catalog revision; generated resources are never translated
  or edited separately.
- Treat `en-US.json` as the source locale and ultimate runtime fallback. Web,
  iOS, and Android each package a reviewed complete copy that is sufficient for
  that client version to render every migrated runtime string offline.
- Keep the published locale files' key sets identical. For each key, every
  locale must use the exact named-variable set and variable types declared in
  `catalog.json`.
- Store the Web preference as one canonical BCP 47 tag. Native clients may
  store either the `system` sentinel or one canonical tag; `system` is a native
  preference state, not a locale, filename, request parameter, or response
  value.
- Establish a valid cached bundle or packaged US English before presenting
  localized UI. Refresh translations in the background on cold launch with
  ETag revalidation; never block startup on the remote service.
- Keep platform-owned copy in native resources. Runtime JSON does not replace
  iOS privacy-usage descriptions, App Store metadata, Android manifest labels,
  notifications rendered by the operating system, or other text needed before
  the localization runtime is available.

## Goals

- Give Web and both native clients one understandable key and message contract.
- Permit reviewed wording and translation corrections without an app release.
- Guarantee readable offline startup and deterministic failure recovery.
- Support plurals, grammatical selection, accessibility copy, and bidirectional
  layouts without building language rules into individual views.
- Make incomplete or structurally unsafe translations impossible to publish.

Automatic translation of catalog titles, artist names, album names, user data,
or arbitrary server content is not part of this contract. The first delivery
implementation also does not include an in-app translation editor or database
storage for translations.

## Locale identifiers and filenames

Language identifiers follow BCP 47 and are canonicalized before storage or
comparison. Tags are case-insensitive by standard, but Finitude uses one exact
representation to prevent duplicate files and cache entries:

| Subtag | Convention | Examples |
| --- | --- | --- |
| Language | lowercase | `en`, `fr`, `zh` |
| Script | title case | `Hans`, `Hant`, `Latn` |
| Region | uppercase letters or three digits | `US`, `GB`, `TW`, `419` |

Use the least-specific tag that describes genuinely shared copy. Finitude's
source copy and final fallback are specifically US English, so they use
`en-US`. A future generic-English bundle would use `en`, while another reviewed
regional variant would use a tag such as `en-GB`. For Chinese, prefer script
distinctions such as `zh-Hans` and `zh-Hant`; add a region only when that region
has distinct reviewed copy.

Aliases and noncanonical spellings are rejected during authoring. The catalog
must not contain two tags that canonicalize to the same locale.

## Source layout

The initial implementation should keep translations in Git so changes are
reviewable, reversible, and deployed through the existing release process:

```text
localization/
  catalog.json
  locales/
    en-US.json
    zh-Hans.json
  generated/
    manifest.json
    bundles/
      en-US.json
      zh-Hans.json
```

`catalog.json` contains translator context and the variable contract. Locale
metadata in that catalog contains each published language's reviewed autonym
and stable English name. Locale files contain every translated message,
including the small platform-owned subset. Everything under `generated/` is
deterministic build output and must not be edited by hand. Draft or incomplete
languages remain outside `locales/` and are never advertised to production
clients.

Native client builds consume the same catalog revision and generate their
String Catalog, InfoPlist, Android resource, and packaged JSON outputs inside
their respective workspaces. Those platform build artifacts are derived
outputs, not another authoring source.

A later translation-management system or CDN may become the authoring or
delivery backend without changing the client API or message format.

## Runtime JSON format

Locale files are UTF-8 JSON objects with sorted, flat semantic keys and string
values:

```json
{
  "common.action.cancel": "Cancel",
  "library.download_count": "{count, plural, =0 {No downloads} one {# download} other {# downloads}}",
  "settings.language.system": "System",
  "welcome.listener_name": "Welcome, {listenerName}"
}
```

Flat keys make diffs, equality checks, lookup, and fallback simpler than nested
objects. Keys use lowercase dot-separated namespaces and `snake_case` for a
multiword segment. They describe intent rather than repeating English copy.
Examples include `settings.language.title`, `playback.error.unavailable`, and
`accessibility.player.collapse_hint`.

Keys are immutable identifiers:

- Do not use the English sentence itself as a key.
- Do not reuse a key when its meaning or variable contract changes; add a new
  key and migrate callers.
- Keep keys additive while any supported client may still reference them.
- Do not concatenate fragments to build a sentence. Give translators the
  complete message and its context.
- Accessibility labels, hints, and announcements use the same catalog and
  review rules as visible copy.

## Catalog and variable contract

`catalog.json` is not shipped to the UI. It gives validation tools and
translators one authoritative definition for every message:

```json
{
  "schemaVersion": 1,
  "locales": {
    "en-US": {
      "nativeName": "English (United States)",
      "englishName": "English (United States)"
    },
    "zh-Hans": {
      "nativeName": "简体中文",
      "englishName": "Simplified Chinese"
    }
  },
  "messages": {
    "library.download_count": {
      "description": "Number of device downloads shown in the Library summary.",
      "delivery": ["runtime"],
      "variables": {
        "count": "number"
      }
    },
    "platform.app_name": {
      "description": "Application name shown by iOS and Android system UI.",
      "delivery": ["ios-system", "android-system"],
      "variables": {}
    },
    "welcome.listener_name": {
      "description": "Greeting shown after a listener opens Home.",
      "delivery": ["runtime"],
      "variables": {
        "listenerName": "string"
      }
    }
  }
}
```

Every catalog entry declares one or more delivery targets: `runtime`,
`ios-system`, or `android-system`. Delivery metadata controls generated output;
it does not create another translation value. A shared platform-owned message
may target both native systems. System-delivered messages do not accept runtime
variables unless the target platform resource format explicitly supports and
tests that contract.

The initial variable types are `string`, `number`, `date`, and `time`. Add a
new type only with formatter support and tests on Web and both native platforms.
Variable names are semantic and named; positional placeholders such as `%@`,
`%1$s`, `{0}`, and string interpolation inside views are not allowed in new
catalog messages.

All published locales must satisfy both invariants:

1. Their message-key set is exactly the key set in `catalog.json`.
2. For every key, their parsed named-variable set exactly matches the catalog,
   including variables inside plural or select branches.

ICU MessageFormat 1 is the initial wire syntax because mature parsers are
available today. Hide it behind a small `MessageFormatter` boundary on each
client so a later move to stable MessageFormat 2 does not affect views or key
lookup. Plural and select messages must include an `other` branch and must pass
locale-aware parser validation. Number, date, time, and plural behavior uses
the active message locale; time zone and user measurement preferences remain
device settings.

## Packaged en-US fallback

Every Finitude client packages a generated complete `en-US` runtime bundle. It
is derived from canonical `en-US.json`, contains every `runtime` key that client
version requires, and is versioned with the release. It must work without the
remote localization API, an account, previously cached data, or writable
storage. Web emits it as a hashed same-origin static asset and validates it
before mounting React; iOS and Android package it as an app resource.

Archtree's current `en-US.json` may contain newer additive keys than an older
client release. Clients ignore unknown remote keys. A remote bundle missing or
failing to format one key falls back to packaged US English for that key. In a
production build, lookup must never expose a raw key, blank placeholder, or
partially formatted message to the listener.

Until migration is complete, existing native resource systems remain valid:

- iOS continues using `Localizable.xcstrings` for views not yet migrated.
  Runtime views move to semantic JSON keys through one localization
  environment/service rather than reading JSON directly. Build tooling writes
  the designated generated String Catalog and Info.plist localization outputs
  for `ios-system` keys.
- Android keeps hand-authored resources that are not translation copy. Build
  tooling writes a separately named generated resource file for
  `android-system` keys such as `app_name`. Compose runtime copy moves from
  hard-coded `Text` values to the same semantic localization service used by
  iOS.

Generated native resources and all packaged runtime fallbacks are synchronized
from one pinned catalog revision on every client build. Ordinary `runtime`
translation changes may be published remotely without a client release. A
change to an `ios-system` or `android-system` value becomes visible only after
a native release containing regenerated resources. This avoids making a
network-delivered file responsible for text the operating system may need
before either app has launched without creating a second translation source.

For the current sibling-repository layout, maintainers run
`npm run localization:sync-native` after editing canonical translations. The
command first regenerates reviewed server artifacts, then copies the manifest
and complete `en-US` runtime fallback into both native projects. Custom checkout
locations use `-- --ios-root <path> --android-root <path>`. Platform-owned
String Catalog and Android resource outputs remain generated only from keys
assigned to their corresponding delivery targets.

## Language preference and matching

The native device-local preference has two forms:

```text
system
<canonical BCP 47 tag>
```

Web stores only an explicit published locale and starts with `en-US` when no
valid preference exists. Because ordinary webpages cannot reliably read the
browser's UI locale separately from content-language preferences, Web does not
offer an automatic Browser default option. A legacy stored `system` preference
migrates to `en-US`. Native clients default to `system`. Once chosen, a valid
preference survives relaunch, logout, and account changes because language is
an application/device preference rather than private account data.

For `system`, native clients evaluate the operating system's ordered preferred
languages against the latest valid manifest. For an explicit setting, a client
evaluates only the selected tag. Matching uses a deterministic best-fit
sequence: exact canonical tag, then the same language and likely script, then
the same language, and finally configured default `en-US`. For example,
preference `zh-CN` resolves to published `zh-Hans`, while an exact
`zh-Hant-TW` remains preferred when that reviewed locale exists.

The client performs matching locally. It does not send the user's complete
language preference list to Archtree. The resolved published locale is the
only locale used in the bundle URL.

The Web language selector shows published locales only. Native selectors show
the automatic `System` preference first and describe the locale resolved from
operating-system preferences. Every published locale has two review-stable
names in `catalog.json`: an autonym as the primary label and an English name as
secondary context. Script or region appears in both names when needed to
distinguish entries. The generator requires the metadata set to match the
locale-file set exactly and publishes the names in the manifest so Web, iOS,
and Android do not independently derive or translate them.
On desktop Web, a Spotify-like globe-and-language pill remains at the bottom of
the left sidebar; compact Web layouts expose the same action as a reachable
top-bar icon. Selecting an uncached language downloads and validates it before
committing the preference. If that explicit action fails, the existing
preference and visible language remain unchanged and the user receives a
retryable error.

If a previously selected locale is removed from a newer manifest, Finitude
retains the preference and any valid cached bundle instead of silently changing
the user's choice. Locale removal therefore requires a deprecation and client
migration plan; normal releases should add or revise locales, not abruptly
delete them.

## Startup and refresh lifecycle

Localization establishes local fallback state before UI presentation and keeps
remote refresh asynchronous:

1. Load and validate the release's packaged `en-US` bundle. Web does this from
   its hashed same-origin asset before mounting React; native clients read an
   app resource.
2. Read the preference and the last valid cached manifest.
3. Resolve the preferred published locale.
4. Activate that locale's last-known-good cached bundle, if valid; otherwise
   retain packaged `en-US`.
5. Present the app.
6. Once per cold process launch, conditionally revalidate the manifest.
7. Resolve again. Request the selected bundle only when no valid cache exists
   or its revision differs from the manifest, using its ETag when available.
8. Validate and persist a successful response as one complete cache record,
   then activate the complete bundle. Native file caches use temporary-file
   replacement; Web replaces one validated storage record.

`304 Not Modified` keeps the current cache. Offline, timeout, cancellation,
non-2xx, oversize, malformed, schema-incompatible, or invalid-message responses
leave the active bundle unchanged. Background launch refresh failure does not
show a blocking alert because readable fallback copy is already available.

Each preference or system-language change increments a request generation.
Only the current generation may activate a response. A cancelled, stale, or
slower request for a previous locale cannot overwrite a newer selection. The
active bundle swaps as one observable value so React, SwiftUI, and Compose
never render a mixture of two revisions.

When browser or operating-system language preferences change while the
automatic `system` preference is selected, Finitude re-resolves at the next
supported activation or preference event and uses the same cached-then-refresh
flow. An explicit in-app selection is not overwritten by that environment
change.

## Public delivery API

Translations are public application resources and do not require a listener
session. Archtree exposes two read-only endpoints:

```http
GET /api/localizations/v1/manifest
GET /api/localizations/v1/bundles/{locale}
```

The manifest response is intentionally small:

```json
{
  "schemaVersion": 1,
  "defaultLocale": "en-US",
  "locales": [
    {
      "locale": "en-US",
      "nativeName": "English (United States)",
      "englishName": "English (United States)",
      "revision": "sha256-BASE64URL"
    },
    {
      "locale": "zh-Hans",
      "nativeName": "简体中文",
      "englishName": "Simplified Chinese",
      "revision": "sha256-BASE64URL"
    }
  ]
}
```

A bundle response wraps the `runtime` entries selected from the corresponding
on-disk locale file:

```json
{
  "schemaVersion": 1,
  "locale": "zh-Hans",
  "revision": "sha256-BASE64URL",
  "messages": {
    "common.action.cancel": "取消"
  }
}
```

The revision is an opaque digest of the generated canonical `runtime` message
map; clients compare it for equality only. A change limited to platform-owned
copy therefore does not cause installed clients to download an unchanged
runtime bundle. Both endpoints return a strong `ETag` derived from the complete
representation and accept `If-None-Match`. Bundle responses also return
`Content-Language` with the exact published tag. Public caching may store
responses; `Cache-Control: public, max-age=0, must-revalidate` keeps the
cold-launch freshness check conditional. The server returns only allowlisted
manifest locales and never maps an untrusted path segment directly to a
filesystem path.

The endpoint version represents the response contract. `schemaVersion`
represents the bundle/message schema. A wording correction changes only the
revision. Additive keys do not change either version. A breaking representation
or parser change requires a new schema and a compatibility rollout rather than
silently changing existing responses.

## Validation and publishing gate

The localization build must fail before publication when any of these checks
fails:

- filename is not the one canonical BCP 47 representation;
- locale metadata is missing, extra, malformed, or does not exactly match the
  published locale-file set;
- JSON is invalid UTF-8, contains duplicate keys, is not a flat string map, or
  exceeds configured key, value, or total-byte limits;
- a published locale has a missing or extra key;
- a message is empty, syntactically invalid, or has a variable mismatch;
- a plural/select message lacks a required fallback branch;
- a key is unsorted, reused incompatibly, or missing translator context;
- a packaged client `en-US.json` lacks a key referenced by that client;
- a generated iOS or Android resource differs from the pinned catalog revision
  or contains a key not assigned to that delivery target;
- the generated manifest revision does not match the canonical generated
  `runtime` message-map bytes.

Clients still validate downloaded data because network and cached files are
untrusted inputs. Validation is bounded, cache writes are atomic, and only a
fully decoded bundle becomes last-known-good. Translation values are plain
text, not HTML, Markdown, format strings passed to native variadic APIs, URLs,
or executable configuration.

API failures shown in runtime UI are selected from stable client-side error
keys. Clients do not display arbitrary server error messages as translated
copy.

## Platform integration and quality gates

The in-app language setting is the shared product control. Web stores this
device-local preference independently of account data and synchronizes changes
between tabs. Where a stable published locale is also declared to an operating
system, native clients should keep per-app language support synchronized when
the platform permits it. Android should use `LocaleManager`/AndroidX
application locales rather than maintaining a conflicting second platform
preference. iOS project localizations remain necessary for platform-owned
resources and cannot be dynamically expanded solely by downloading JSON. Both
native clients generate those resources from canonical locale JSON during a
build; native resource files are delivery artifacts, not an independent
translation source.

Every published locale is tested for:

- normal, long, and pseudo-localized copy at supported text sizes;
- truncation, wrapping, and accessibility labels/hints;
- plural, select, number, date, and time cases;
- right-to-left layout using logical leading/trailing directions and mirrored
  directional controls where appropriate;
- cold offline launch, corrupt cache, stale response, `304`, locale switching,
  and failed explicit-language download;
- Web desktop and mobile selector placement, keyboard/focus behavior, document
  `lang`/`dir`, explicit default, legacy preference migration, and reload
  persistence;
- human linguistic review of visible and accessibility copy.

Pseudo-locales are test fixtures, not entries in the production manifest.

## Standards references

- [BCP 47 / RFC 5646: Tags for Identifying Languages](https://www.rfc-editor.org/rfc/rfc5646.html)
- [RFC 4647: Matching of Language Tags](https://www.rfc-editor.org/rfc/rfc4647.html)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
- [ICU MessageFormat](https://unicode-org.github.io/icu/userguide/format_parse/messages/)
- [Unicode MessageFormat 2](https://messageformat.unicode.org/)
- [Apple: Localizing and varying text with a string catalog](https://developer.apple.com/documentation/xcode/localizing-and-varying-text-with-a-string-catalog)
- [Android: Per-app language preferences](https://developer.android.com/guide/topics/resources/app-languages)
