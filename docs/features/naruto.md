# Naruto Mobile integration

Archtree hosts the Naruto Mobile browser distribution and proxies its private analysis requests.

<!-- @catalog -->
**Contents**

- [Naruto Mobile private analysis proxy](#naruto-mobile-private-analysis-proxy)
- [Preparing the Naruto browser distribution](#preparing-the-naruto-browser-distribution)
  - [Required Naruto source handoff on develop](#required-naruto-source-handoff-on-develop)
<!-- @end-catalog -->

## Naruto Mobile private analysis proxy

The fixed API lives at `/naruto-mobile/api/v1`:

- `GET /status` returns availability, protocol compatibility, and the shared
  `maxConcurrentRequests` capacity.
- `GET /access` verifies an authenticated Archtree Bearer session.
- `POST /classify` accepts only the bounded `triage` or `detail` protocol.

Naruto Web is served independently at `/naruto` from `naruto-web/dist`.
The generated bundle contains the Web application, its Vite asset manifest,
and `naruto-mobile-chrome-extension.zip`. Only declared public assets, the
HTML entry, and that extension download are served; release metadata and build
markers remain private. Extensionless deep links receive the SPA entry, missing
resources return 404, and a missing bundle returns 503 without capturing API,
authentication, or Finitude routes. Prepare this bundle before deploying the
site. The existing Windows EXE and desktop-only API remain supported.

For the built local portal, open `http://localhost:8080/naruto` in the same Chrome
profile as the installed collector extension. The matching extension supports
local HTTP `/naruto` portals on `localhost` and `127.0.0.1` at ports 8080, 5173,
and 3765. After an extension update, replace the files in its unpacked directory,
reload it in `chrome://extensions`, then refresh the portal before connecting.

The browser-specific API lives at `/naruto/api/v1`:

- `GET /status` returns availability, protocol version, fixed model, and shared
  capacity to a same-origin browser without requiring login.
- `POST /classify` uses the same v1 `triage`/`detail` envelope as the desktop API.
  It requires an existing HttpOnly Archtree cookie session, exact same-origin
  JSON proof, and `X-Finitude-Account-Viewer` containing the displayed account's
  ID. Authorization headers are rejected on this browser surface. Authentication,
  the account fence, service readiness, rate limits, and concurrency admission
  run before the 1 MB JSON parser.

The matching Naruto client retries transient Node and Chrome fetch failures,
including interrupted response bodies, up to six attempts per batch with
exponential backoff. A persistent detail failure retains completed local cache
records and offers **继续分析并生成报告** to resume. An older saved `Failed to
fetch` error receives the same recovery guidance after updating the Web bundle.
Cancellation, account changes, and unrelated programming errors are not treated
as retryable transport failures.

The page resolves its initial identity through `GET /auth/browser/session`
(`user.id`) and sends signed-out users to
`/auth/login-web?returnTo=%2Fnaruto%2F`. This reuses the existing shared browser
session coordination; no Naruto account or credential store is introduced.
The Chrome extension collects in the user's own signed-in Bilibili browser,
retains raw records and task progress locally, and supports explicit local
exports. The server does not run a browser or receive Bilibili credentials.
The extension does not call the paid browser API directly; the same-origin Web
page submits only the existing bounded classification fields.

Set `OPENAI_API_KEY` in the Elastic Beanstalk runtime environment. Set optional
`OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` when requests must explicitly select the
organization and project that have model access. These settings apply to both
Decisions and Responses and are owned by the server; the Windows client cannot
override them. Every
authenticated Archtree account may use this endpoint. The Windows app signs in
through the existing `/auth/login`, `/auth/refresh`, and `/auth/logout`
endpoints and stores the rotating session with operating-system encryption.
The proxy never returns the OpenAI key or accepts arbitrary OpenAI request
options.

For local development, configure `OPENAI_API_KEY` in this Archtree checkout's
ignored root `.env`, then restart with `npm run dev`. The server does not load
the sibling Naruto client's `.env`. The browser's `/naruto/api/v1/status`
reports whether server provider configuration is present; it does not validate
upstream account access or quota. Archtree sign-in and analysis availability
are independent: an authenticated listener stays signed in while analysis is
unavailable, and the UI explains that service state rather than asking them to
sign in again. Refresh the portal after changing server configuration.

Screening uses `POST /v1/decisions`, `gpt-6-luna`, and prompt version
`naruto-decisions-v1`. Named questions address each comment independently.
Detailed analysis uses `POST /v1/responses`, `gpt-6-luna`, medium reasoning,
and `store: false`. Refusals, malformed item answers, and low-confidence skips
are normalized to `uncertain`. Screening request failures are retained by the
Windows client for detailed analysis. Deploy the matching proxy before releasing
the updated Windows client. The protocol envelope remains version 1.

The desktop and browser classifiers together admit up to 12 simultaneous
requests per client IP and 12 across the server process. The existing per-IP
60-request/minute budget still
applies. Both Decisions and detail calls share this capacity; the desktop
client reduces its active request budget and honors `Retry-After` when either
the proxy or upstream provider returns 429. Chrome collection tabs have an
independent limit and do not change model request concurrency.

## Preparing the Naruto browser distribution

The Naruto browser UI and Chrome extension are built from the sibling
`naruto-mobile` repository. Install its locked dependencies with `npm ci`, then
prepare its hosted assets from this Archtree checkout:

```powershell
npm run prepare:naruto-web
# Or choose an explicit source checkout:
npm run prepare:naruto-web -- D:\Documents\GitHub\naruto-mobile
```

The helper runs the sibling's `npm run build:hosted`, validates the `/naruto/`
Vite manifest and extension download, and copies only the hosted distribution
to the ignored `naruto-web/dist/` directory. A distribution digest and source
commit/dirty metadata accompany the build; desktop data, local configuration,
and credentials are excluded. `/naruto/naruto-mobile-chrome-extension.zip`
downloads the unpacked extension described by the UI's installation guide.
Extension `0.1.2` adds bounded scrolling/waiting for lazy Bilibili comments and
keeps incomplete sources retryable. Reload the updated extension and refresh the
portal before continuing an older investigation; its first explicit resume
retries legacy title-only sources while retaining local evidence and spent time.
When preparing a new bundle while the local Archtree server is running, restart
that server before refreshing the page so its static-asset allowlist includes
the new hashed bundle files.
Extension `0.1.3` also requests `tabGroups` to keep tool-created collector tabs
in an orange `火影调查` group. Existing browser groups and user tabs are not
adopted; pausing and finishing preserve user-added or repurposed tabs. Replace
the extracted extension files and reload it in Chrome after preparing an update.
Extension `0.1.4` also accepts late tracking-query/trailing-slash changes to the
same canonical video or dynamic, while retaining content-ID and tab-placement
ownership boundaries. Its visible connection message includes the loaded version;
fixed local warning reasons identify the failed collection stage without page
payloads or upstream exception text.
Extension `0.1.5` retries still-loading background comments by briefly activating
one owned collector tab at a time in its existing window/group. It restores the
previous selection only if the user has not changed tabs, and requires no new
extension permissions. Its reader scrolls the actual observed comment host.
Extension `0.1.6` additionally recognizes Bilibili's rendered zero-comment count
paired with its end-of-comments footer as a completed empty source. An end
marker alone or hidden/unfinished comment UI remains pending.
Extension `0.1.7` opens login checks and collection in separate new normal Chrome
windows with `focused: false`. Parallel collector tabs share one dedicated
window and the orange investigation group; delayed-comment retries change only
that window's selected tab. The existing user window keeps its selection.
Cleanup removes only owned tabs, so a user-added tab keeps its window open.
Extension `0.1.9` enforces the selected content window itself rather than
trusting Bilibili's search filter: each source needs a confirmed publish time
inside the window, and undated sources are skipped with a warning. The retired
动态 search is replaced by 专栏 article search, and the portal requires `0.1.9`
before starting or resuming live collection.

`npm run stage:eb-artifact` includes this separately prepared distribution when
present and revalidates its provenance. Prepare it before staging any release
intended to serve Naruto. The normal Archtree build does not rebuild the sibling
or fetch its private source. Without a prepared distribution, `/naruto` returns
503 while the existing APIs and Finitude listener remain available. Naruto
releases use the same release verification and deployment process as Archtree;
generated bundles and deployment archives must not be committed.

### Required Naruto source handoff on `develop`

Current Naruto source handoff:
[`14f852435880ba65556ed894dfdbea177307f97f`](https://github.com/yangyinxu/naruto-mobile/commit/14f852435880ba65556ed894dfdbea177307f97f).

Every push to `yangyinxu/naruto-mobile`'s `main` branch, including a
documentation-only push, requires a matching Archtree update on `develop`.
The person or agent pushing Naruto is responsible for completing this handoff:

1. Record the exact pushed Naruto commit SHA in the entry above. Build from a
   clean checkout of that commit with
   `npm run prepare:naruto-web -- <source-directory>` and run
   `npm run smoke:naruto-web`.
2. Verify that `naruto-web/dist/release-source.json` has the matching
   `sourceCommit` and `sourceDirty: false`. Commit and push the source handoff
   and any required integration changes to Archtree `develop`, preserving
   unrelated work and leaving generated distributions ignored.
3. Report both repository commits and the verification results. This is a
   required collaboration workflow; no CI job automatically synchronizes the
   repositories. This entry records the `develop` handoff and is not read by the
   production release workflow.

Before an authorized Archtree `main` release, set the Actions variable
`NARUTO_SOURCE_COMMIT` to this same complete source SHA. A routine `develop`
handoff does not push Archtree `main` or deploy production.

Automatic Naruto release packaging is opt-in. Set the Archtree repository's
Actions variable `NARUTO_SOURCE_COMMIT` to a complete 40-character commit SHA
already committed and pushed to `yangyinxu/naruto-mobile`. Branches, tags,
abbreviated hashes, and malformed values are rejected. When that repository is
private, provide `NARUTO_SOURCE_TOKEN` as an Actions secret with read-only
Contents access to that source repository; the default `GITHUB_TOKEN` is normally
limited to Archtree. Checkout does not persist the source credential.

For a `main` push with the variable configured, the release workflow checks out
that exact source under ignored `.naruto-source/`, installs its locked
dependencies and Chromium, runs its tests, prepares the hosted distribution,
and runs the local browser demo smoke. Any failure blocks the release. The
shared build artifact includes `naruto-web/dist` and its hidden manifest and
provenance; the final Elastic Beanstalk ZIP also includes `naruto-web`. The
existing Archtree release gates and promotion identity remain required. This
CI smoke exercises the local demo; real-extension collection is covered by
the source tests and the separate installed-Chrome smoke described below.

Without `NARUTO_SOURCE_COMMIT`, the ordinary release excludes Naruto and the
deployed `/naruto` page returns 503. A local prepared bundle does not configure
CI. Both repositories' implementation changes must be committed and pushed
before enabling a Naruto release, with Archtree's changes delivered through
the existing `main` release process. Updating the source variable alone does
not trigger a workflow or deployment; a subsequent authorized `main` push is
required. Pull-request gates do not check out the optional source or use its
private token.

After preparing the current distribution, run the local demo smoke with
`npm run smoke:naruto-web`. To exercise the real unpacked Chrome extension and
the hosted live flow together in an isolated temporary Chrome profile, set an
explicit installed Chrome executable:

```powershell
$env:NARUTO_HOSTED_EXTENSION_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run smoke:naruto-web
Remove-Item Env:NARUTO_HOSTED_EXTENSION_EXECUTABLE
```

The optional mode uses Chrome's local `Extensions.loadUnpacked` debugging API
in the temporary profile. Bilibili pages, account persistence reads, and server
classification are synthetic fixtures; it never uses a personal browser
profile, a real account, or paid provider calls. Both modes verify reports, ZIP
import/export, IndexedDB reload, and blocked unexpected browser origins.
