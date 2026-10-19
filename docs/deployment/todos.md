# Archtree Deployment TODOs

This file tracks infrastructure work that is intentionally deferred and cannot
be completed solely through application code.

<!-- @catalog -->
**Contents**

- [Administrator Metadata Lookup Rollout](#administrator-metadata-lookup-rollout)
- [Artist Follow and New Releases Rollout](#artist-follow-and-new-releases-rollout)
- [Production HTTPS for Authentication](#production-https-for-authentication)
- [Web-only Audio Social Launch](#web-only-audio-social-launch)
  - [Before the first public enablement](#before-the-first-public-enablement)
  - [Deploy with both flags off](#deploy-with-both-flags-off)
  - [Room audio decoder and catalog backfill](#room-audio-decoder-and-catalog-backfill)
  - [Monitoring and alarms](#monitoring-and-alarms)
  - [Enable for testing](#enable-for-testing)
  - [After the test window](#after-the-test-window)
<!-- @end-catalog -->

## Administrator Metadata Lookup Rollout

Status: Lookup jobs run on the server once an import's uploads complete and
apply a preselected release's values to the draft, staging its Cover Art
Archive front artwork as a cover candidate; Publish waits while a run or that
staging is active, a tie is unresolved or a conflict with an administrator's
own value is unanswered. The Web Review and publish summary shows each run's
status, ties and conflicts, takes a submitted Album or song name and offers a
manual retry. Without the contact below, nothing is sent and no lookup starts.

- [ ] Set `FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT` in production to an operator
      email address or https URL before metadata lookup is enabled for
      administrators. Lookup stays unavailable, and sends nothing, without it.
- [ ] During release verification of metadata lookup, confirm the fixed iTunes
      storefronts (`jp`, `us`, `kr`, `tw`) and the source rates (MusicBrainz at
      least 1.1 seconds apart, iTunes 3 seconds apart, Cover Art Archive two at
      once).

## Artist Follow and New Releases Rollout

Status: Local implementation and automated verification are **Complete** as of
2026-10-13. Production deployment and enablement are **Not started**.

- [ ] Release the integrated backend/Web and compatible native clients through
      their normal release gates; old clients remain compatible without the
      personalization version header.
- [ ] Verify the exact mandatory Follow and release-date indexes documented in
      [authentication and content management](../features/auth-and-content-management.md),
      including the unique owner/Artist constraint.
- [ ] Configure a Home Carousel with source `followedArtistReleases`, its name,
      persisted position, and a limit from 1 through 20.
- [ ] Enable `FINITUDE_ARTIST_FOLLOWS_ENABLED` only after controlled-account
      Follow, Unfollow, new-release visibility, account transition, and flag
      rollback checks pass. Keep discovery independent and disabled.
- [ ] Verify compatible physical-device clients against that same deployment.

The flag defaults off in every environment. Disabling it hides Follow and the
generated Home source while preserving status reads, Unfollow, relationships,
and deletion cleanup. Local fixtures and simulator evidence do not establish
production rollout or real-device delivery.

## Production HTTPS for Authentication

Status: Recovered on 2026-08-05 at 23:38 EDT. Production commit `9b62537`
deployed successfully through CodePipeline and Elastic Beanstalk, restoring a
trusted HTTPS listener and the managed HTTP-to-HTTPS redirect.

Historical recovery state (2026-08-05):

- Route 53 resolves the production domain to the single-instance Elastic
  Beanstalk environment, which reported `Ok` after deploying the recovery
  commit.
- Public HTTP returns `308` to the equivalent `https://kashewt.com` URL, and
  repeated HTTPS `/health` checks return `200` with a trusted certificate.
- The deployed Let's Encrypt certificate covers `kashewt.com` and expires on
  2026-11-04. Direct instance-level timer status remains to be captured during
  the next authorized instance inspection.
- The deployed recovery starts missing-certificate retry after a five-minute
  base delay plus a bounded randomized delay, then uses an hourly base interval
  without requiring another deployment. Its separate twice-daily maintenance
  path preserves a working certificate when renewal fails.
- Physical-device Debug and Release iOS builds use
  `https://kashewt.com`;
  simulator Debug builds retain the localhost override.
- Archtree trusts the single deployed Nginx proxy hop. After TLS recovery
  activates the managed redirect, Nginx overwrites the trusted forwarded
  protocol metadata so a public request cannot bypass that redirect.

Remaining rollout and capability gates:

Read-only verification on 2026-10-11 found both public authentication capability
endpoints reporting `emailRegistration: true`, and the Web registration and
verification routes returning the listener shell. A later signed-in console and
CloudShell inspection confirmed the production sender, region and link origin,
and successful SES domain verification and DKIM. SES sending is enabled in
`us-east-1`, but production access is disabled (sandbox). The complete environment
properties omit `AUTH_CODE_PEPPER`, so the supported `JWT_SECRET` fallback is in
use. The runtime identity is confirmed as `ArchtreeAdmin`; its email policy has
been narrowed to `ses:SendEmail` on the verified domain identity with the exact
From-address condition. Readback and policy simulation confirm the approved send
is allowed while another sender, raw email and another identity are denied. One
authorized production registration request returned generic `202 Accepted`;
a later authorized Gmail browser search found no application email for that test.
The exact test recipient's SES verification was requested, and the AWS verification
message was received at 15:02 UTC; final identity confirmation still awaited
operator approval. Application email receipt and link use were unverified. At that point,
the remaining email gates were SES production access, a dedicated pepper, and
received-email/link verification. See the
[reviewable configuration](social-rollout-runbook.md#production-authentication-email-configuration).

The initial 2026-10-12 read-only check reconfirmed SES sandbox status, verified
domain and DKIM, and the absence of `AUTH_CODE_PEPPER`. Application email receipt
and link use were unverified at that point. Subsequent tests use the operator's
dedicated test mailbox, whose address stays outside the repository; verify that
exact recipient before a sandbox send and preserve the operator's primary
signed-in session.

Later on 2026-10-12, the operator configured the dedicated pepper in CloudShell.
The environment update completed, and a boolean-only configuration readback
confirmed `dedicatedPepperConfigured: true`. The dedicated test mailbox's exact
SES identity is now verified. The operator has chosen to retain the SES sandbox;
production access remains disabled and its request is intentionally deferred.
The unsubmitted console form was cancelled, returning to the sandbox setup page.
Public email delivery is not ready. See the
[completion update](social-rollout-runbook.md#configuration-and-notification-completion--2026-10-12).

The later application registration test failed after its generic 202 response:
the fully paginated 22:32–22:36:59 UTC log window contains one
`email_registration_request_failed` at `2026-10-12T22:34:16.393Z`, with no error
class recorded. Two independent SDK transport probes returned `AccessDenied`;
safe error classification identified the exact approved test-recipient SES
identity as the denied resource. The policy then allowed only the sender
domain identity. A proposed addition of that exact recipient identity passed
five simulation cases and awaited approval. This was a failed test, not evidence
of a delivery delay. See the
[diagnostic record](social-rollout-runbook.md#email-diagnostics-and-catalog-inventory--2026-10-12).

Later that evening, the operator approved the exact-recipient permission update.
All five simulations passed again, the policy update returned HTTP 200, and
strict readback matched the approved policy. The independent transport test was
accepted and received. A new application T1 registration email arrived at 22:54
UTC, and its production link passed initial inspection and opened the account
setup form. The operator completed registration and login, and Account reported
email verified. Replaying the consumed T1 link within its 30-minute lifetime
was rejected. T2 was received with the correct token-free destinations, and a
password-reset email containing a six-digit code was received without performing
a reset. T3/legacy verification and password-reset completion remain open;
SES production access is intentionally deferred by the operator. See the
[evening completion record](social-rollout-runbook.md#email-permission-and-t1-completion--2026-10-12).

An account that predates email verification receives
`403 email_verification_required` when it next signs in and needs a delivered
verification link. Existing sessions continue working, but successful capability
checks alone cannot establish that a returning listener can sign in again.

- [ ] Enroll the project in a paid Apple Developer team. The active iOS target
      intentionally omits Sign in with Apple and Associated Domains
      entitlements until this is available.
- [x] Choose a production API domain owned by the project.
- [x] Add repository configuration for public certificate issuance and renewal
      directly on the single Elastic Beanstalk instance.
- [x] Add instance security-group ingress for port 443.
- [x] Point production DNS to the Elastic Beanstalk environment.
- [x] Set `HTTPS_DOMAIN`, `ACME_EMAIL`, and `TRUST_PROXY_HOPS=1` in Elastic
      Beanstalk, then deploy after DNS resolves to the instance.
- [x] Deploy the HTTPS recovery candidate through the production pipeline.
- [ ] Capture direct `systemctl` evidence that the bootstrap retry and
      twice-daily renewal timers are active on the production instance.
- [x] Reconfirm Let's Encrypt issuance, port 443, and the HTTP-to-HTTPS redirect.
- [x] Verify `TRUST_PROXY_HOPS` against the deployed proxy chain.
- [x] Change the iOS Release `ARCHTREE_AUTH_BASE_URL` to the production
      `https://` domain.
- [x] Verify password login over HTTPS from a signed physical-device build.
- [ ] Verify refresh rotation, logout, and logout-all over HTTPS from a signed
      physical-device build. `/auth/me` has been verified.
- [x] Verify the `kashewt.com` SES domain and DKIM in `us-east-1`, and configure
      the approved domain sender in `AUTH_EMAIL_FROM` with that `AWS_REGION`.
- [x] Set `AUTH_LINK_ORIGIN` to the exact production Web origin
      (`https://kashewt.com`).
- [ ] **Deferred by operator:** obtain SES production access in `us-east-1`
      before declaring ordinary-listener email delivery ready. The operator has
      chosen to retain the sandbox and defer the request. The earlier console
      form was cancelled without submitting a request or accepting its terms;
      the console returned to the sandbox setup page. Continue
      only authorized tests to exact verified recipients; successful sandbox
      delivery does not establish public email readiness.
- [x] Confirm the runtime AWS identity and simulate sender-context
      `ses:SendEmail` on the domain identity. That simulation returns `allowed`;
      it does not prove permission for the exact sandbox-recipient identity.
- [x] Narrow the existing policy to `ses:SendEmail` on the verified domain
      identity, retaining its exact From-address condition. Readback confirms
      the scope; simulations allow that sender/domain-resource combination and
      return `implicitDeny` for another sender, `ses:SendRawEmail` and another
      domain identity.
- [x] Apply the approved exact test-recipient SES identity addition and verify
      it through policy readback, an independent transport send and an
      application registration send. Five simulation cases passed again;
      `put_user_policy` returned HTTP 200 and strict readback returned
      `approvedPolicyApplied: true`. Both the transport test and T1 application
      email were received after the update.
- [x] Configure a securely generated, dedicated `AUTH_CODE_PEPPER`, without
      logging or committing its value. The operator applied the update on
      2026-10-12; boolean-only readback confirmed it is configured. Request new
      reset codes and email links because those keyed by the earlier fallback
      secret no longer verify.
- [x] Receive a T1 registration email and verify its production-origin link
      reaches the initial account setup form. The dedicated inbox received
      `Finish creating your Finitude account` at 22:54 UTC on 2026-10-12; the
      link passed inspection and showed the confirmed-email account setup form.
      No private address or token is retained here.
- [x] Complete registration with the operator's chosen password and verify
      account creation, link consumption and replay/single-use behavior.
      The operator completed registration and login; Account reported email
      verified. Replay of the consumed T1 link within 30 minutes was invalid.
- [x] Receive the application T2 already-registered notice and verify its
      production-origin login and password-reset destinations contain no token.
- [x] Receive a password-reset email containing a six-digit code. No code or
      private recipient is retained here, and no password reset was performed.
- [ ] Verify T3/legacy-account verification receipt and completion, and the
      password-reset completion/session-revocation flow. Successful code receipt
      does not close reset acceptance or justify changing the original account.
- [ ] Configure the iOS Associated Domains entitlement after the production
      authentication domain exists.
- [ ] Enable Sign in with Apple for `com.example.finitude`, refresh its
      provisioning profile, and set `APPLE_CLIENT_IDS` to every accepted app or
      service client identifier.
- [ ] Create Google iOS and server OAuth clients. Set the iOS
      `GOOGLE_CLIENT_ID`, `GOOGLE_REVERSED_CLIENT_ID`, and
      `GOOGLE_SERVER_CLIENT_ID` build settings, and set Archtree
      `GOOGLE_CLIENT_IDS` to the accepted server client identifiers.
- [ ] Verify first-time Apple registration, Apple private relay, repeat login,
      Google registration, repeat login, provider revocation, and nonce
      rejection on a signed device build.
- [ ] Verify an existing email cannot be silently linked while signed out and
      can be linked only from an authenticated account-management flow.
- [ ] Set `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, and `WEBAUTHN_RP_NAME` for the
      final HTTPS authentication domain.
- [ ] Add `webcredentials:<WEBAUTHN_RP_ID>` to the signed iOS Associated Domains
      entitlement and publish a valid `/.well-known/apple-app-site-association`
      file containing the app identifier.
- [ ] Verify passkey enrollment, discoverable sign-in, cancellation, replay
      rejection, counter updates, synced-device use, and lost-passkey recovery
      on signed physical devices.
- [ ] If legacy-token compatibility is temporarily enabled for rollout, remove
      `ALLOW_LEGACY_AUTH_TOKENS=true` after the migration window.

Safety constraints while rollout work remains:

- Do not weaken the iOS secure-authentication URL check or ATS policy.
- Do not remove Archtree's production secure-transport middleware.
- Do not regress production authentication to a remote HTTP endpoint.

Completion evidence:

- HTTPS responds successfully with a trusted certificate.
- HTTP authentication is rejected or redirected without processing credentials.
- A signed physical-device build completes password login over HTTPS.
- Refresh, profile, and session-revocation operations complete over HTTPS
  before the full authentication lifecycle is considered verified.

## Web-only Audio Social Launch

Status: The 2026-10-12 read-only production check found `Archtree-2024-env`
(`e-qeb3ekat4i`) `Ready/Green/Ok`. Its current application version's registered
SourceBundle identifies main `2c1cf6e` and build `github-38170519764-1`; this is
not an independent read of the backend's on-instance `RELEASE.json`. HTTPS
`/health` returned 200 with rooms disabled, HTTP redirected with 308, and one
synthetic-ticket WebSocket upgrade probe returned `503 0`. Startup and decoder
hook evidence are in the
[current record](social-rollout-runbook.md#production-verification--2026-10-12);
the [2026-10-11 record](social-rollout-runbook.md#deployment-verification--2026-10-11)
remains historical. The
[release matrix](../testing/finitude-web-release-matrix.md#verified-release-status--checked-2026-10-12)
records the completed consecutive PR/main CI gates and served Web-byte match.
After the later pepper update, the environment reported `Ready/Green/Info` and
HTTPS `/health` reported `status: "ok"`, rooms disabled and authority inactive;
the [completion update](social-rollout-runbook.md#configuration-and-notification-completion--2026-10-12)
records that subsequent state.
The first social release is Finitude Web only, with Audio-only
rooms, behind `FINITUDE_SOCIAL_ENABLED` and `FINITUDE_ROOMS_ENABLED` (both
default `false`). Its release scope includes email verification. Native social
and rooms, and shared Video, are deferred
(see the [social plan](../plans/social-and-shared-playback-plan.md)). The
procedures are in the [social rollout runbook](social-rollout-runbook.md)
and the [Finitude Web runbook](finitude-web-rollout-runbook.md); this
list tracks what has been done on the production environment. Keep the evidence
in the social runbook's evidence record.

Repository support for this launch: the HTTPS Nginx server forwards WebSocket
upgrades for the room connection, a prebuild hook installs a pinned,
digest-verified FFmpeg, an operator backfill analyzes existing Audio, a process
started with rooms off pauses and winds down open rooms, and `/health`, the
minutely `ops_summary` log line and `.ebextensions/social-capacity.config`
(1 open room, 2 members, 10 realtime sockets) cover signals and capacity.

### Before the first public enablement

- [ ] Complete the email items under Production HTTPS for Authentication
      above: the verified SES sender/domain, a runtime limited to
      `ses:SendEmail`, `AUTH_EMAIL_FROM`, `AUTH_CODE_PEPPER` and
      `AUTH_LINK_ORIGIN`. The same merge stops unverified accounts from
      opening new sessions with any sign-in method, so most existing accounts
      cannot sign in again until email delivery works.
- [x] Merge `develop` into `main` through a pull request and require the
      release workflow on both the pull request and the merged-main push:
      unit, integration, the blocking social browser gate, the three-engine
      browser/axe gate and artifact staging. The
      [2026-10-12 release evidence](../testing/finitude-web-release-matrix.md#verified-release-status--checked-2026-10-12)
      records both complete passes, including `firefox-audio-formats` and
      `webkit-audio-formats`. Artifact staging refuses a bundle without the
      FFmpeg prebuild hook, `room-audio-decoder.config` or `social-capacity.config`.
- [ ] Record the release owner, rollback owner, observation window and stop
      conditions, and keep the current production artifact retrievable for
      rollback.
- [x] Confirm both rollout flags are absent or `false` before the controlled
      window. The guarded 2026-10-12 environment inspection found both unset
      (the documented false default), `Ready/Green` on the original version,
      and no rehearsal version. No enablement has run.
- [ ] Deploy in a quiet window. The first deployment downloads about 117 MB of
      FFmpeg from GitHub, and `npm install` runs beside the old process on the
      1 GiB instance, where an earlier configuration update stalled.

### Deploy with both flags off

- [x] `/health` returns 200. Startup creates the social and room indexes and
      stops if a unique or required index cannot be verified; the log shows no
      `optional_index_unavailable` line. The fully paginated current-deployment
      startup window, 2026-10-11 19:45–20:30 UTC, contains one `server_listening`
      and zero `optional_index_unavailable` events.
- [x] The `/health` `rooms` object reports `enabled: false`, and the current
      deployment's startup window contains one completed room wind-down. This
      verifies startup with rooms off, not the playing-room kill-switch rehearsal.
- [x] The Nginx WebSocket upgrade reaches the application's disabled-room
      handler. One 2026-10-12 probe using a synthetic ticket and foreign Origin
      returned `503 0`. This proves forwarding while rooms are off; it does not
      prove an authenticated room connection or enabled-room Origin enforcement.
- [ ] For a signed-in test account, `GET /api/social/v1/capabilities` reports
      `socialEnabled: false` and `roomsEnabled: false`, and Finitude Web shows
      no Together entry or social actions.
- [ ] The Finitude Web runbook's listener smoke checks and the email-link
      checks above pass.

### Room audio decoder and catalog backfill

The prebuild hook installs FFmpeg and the operator backfill analyzes existing
Audio (see the [room audio decoder](aws.md#room-audio-decoder-on-elastic-beanstalk) and
[catalog backfill](../features/social-and-rooms.md#room-audio-catalog-backfill) sections).

- [x] Confirm the deployment hook revalidates the pinned FFmpeg installation
      and reports the decoder ready. The current startup window contains one
      installed-pin message and one ready message. The hook checks the recorded
      archive-digest marker and runs the actual binaries' version and decoder
      capability checks, including the final `/usr/local/bin/ffmpeg` path. This
      is deployment-hook evidence, not an independent SSH/SSM command or a fresh
      digest of the installed binary; see the
      [dated record](social-rollout-runbook.md#production-verification--2026-10-12).
- [x] Upload original synthetic QA Audio through Content Manager and confirm
      room eligibility. After the original Chrome session recovered through
      Finitude's normal refresh, all three authorized tracks were created and
      publicly ready; the analysis UI's final fourth page showed all three
      as Ready for rooms. Canonical HEAD and two byte-range comparisons passed
      for each source. The M4A probe's initial strict MIME failure is retained;
      an explicit supplemental check for the stored `audio/x-m4a` type passed.
      See the [current record](social-rollout-runbook.md#email-permission-and-t1-completion--2026-10-12).
      A later read-only storage audit found 104 track records, 98 current S3
      objects, zero orphans, six historical missing-file records and zero
      incomplete audio lifecycles. None of the three QA IDs appeared in issue
      findings. No remediation ran; replacement/deletion and noncurrent-version
      acceptance remain unverified. The linked record preserves the audit limits.
- [x] Verify ordinary Web play, pause, paused seek and explicit resume for all
      three QA tracks in the isolated test account while both rollout flags
      remain off. Each used one canonical media element and a single-track
      queue, advanced during play, stayed paused at a keyboard seek to 60
      seconds, and resumed on Play. The VBR source recovered from transient
      `readyState: 1` to `4` before resume. This narrow check does not close the
      full Listener smoke, queue Next, pinned-player, Rooms/synchronization,
      physical-device or audible-output gates; the QA player finished paused.
- [x] Identify existing pending backfill candidates across the complete
      production catalog. The administrator Room audio analysis UI covered all
      four pages on 2026-10-12: 94 ready/published Audio sources, with 72
      `eligible`, 22 `unsupported`, and zero `notAnalyzed`, `retryable`, `running`
      or `unavailable`; the final page had no continuation. Its list service is
      the same one used by the CLI dry run, so no candidate in that inventory
      requires apply. This was a status read: no CLI, S3 HEAD/GET or Analyze action ran,
      and it does not prove fresh decoding of these sources. See the
      [inventory record](social-rollout-runbook.md#email-diagnostics-and-catalog-inventory--2026-10-12).

If a later complete inventory contains `notAnalyzed` or `retryable` sources,
preview the approved backfill, apply in paced runs, and retain its final summary
with the release evidence. A CLI dry run counts each `wouldAnalyze` row toward
`--max-analyses` (default 100); use `--max-analyses=1000` and follow `resumeAfter`
until `finished=true` for a complete preview. After apply finishes, rerun once
without `--after` to retry any `retryLater` sources. None of those CLI steps was
performed or needed for the observed zero-candidate inventory.

### Monitoring and alarms

Status: CloudWatch ingestion, alarms and operator test-notification delivery
are complete; Atlas-side checks remain open. The 2026-10-11 initial console and
CloudShell inspection found instance and health-event log streaming disabled,
no production log groups,
no regional metric alarms and no SNS subscriptions. The log-streaming update has
completed with `StreamLogs=true`, `RetentionInDays=7` and
`DeleteOnTerminate=false`; the environment is `Ready/Green/Ok` with the application
version unchanged. Seven log groups exist with seven-day retention, and real
`ops_summary` events arrive in stdout. The events include an Elastic Beanstalk
syslog prefix, so raw JSON filters matched zero events. A transformer tested
against a real event now parses the JSON into `ops`; all eight metric filters
apply to the transformed logs, and all eight alarms have been created. The
`archtree-operations` SNS topic was created without a subscription. Live metric
readback found six real 60-second datapoints for each of the eight metrics in the
latest 15-minute window; all eight alarms are `OK`, with actions enabled and the
topic configured. Operator subscription and notification receipt were pending
at that baseline check.
The [social runbook](social-rollout-runbook.md#cloudwatch-metric-filters-and-alarms)
contains the applied parser and filter configuration.

The initial 2026-10-12 readback again found all eight alarms `OK` with actions
enabled. The operations topic had zero confirmed and zero pending subscriptions, so
notification delivery was still open at that point.

Later that day, the operator approved and confirmed the dedicated test mailbox's
ongoing SNS subscription. Fully paginated readback found exactly one confirmed
subscription for the approved email endpoint. A clearly marked `TEST ONLY`
publication returned HTTP 200, and the dedicated inbox received the test
notification with its subject and body verified. This closes the subscription
and receipt gate; the earlier zero-subscription observations remain historical.

- [x] Stream the instance logs to CloudWatch Logs with seven-day retention and
      confirm real `ops_summary` events reach the stdout group.
- [x] Apply the verified stdout transformer and create the eight metric filters
      and eight alarms using transformed JSON paths. The open-socket threshold
      is eight, matching 80% of the shipped ten-socket limit.
- [x] Verify new datapoints for the eight metrics after transformation/filter
      activation, including the recurring summary cadence and alarm evaluation.
      Each metric has six real minute-level datapoints; all eight alarms are `OK`.
- [x] Add and confirm an operator SNS subscription and verify receipt of a test
      notification. The approved confirmed email subscription and received
      `Archtree P0 test notification` are recorded in the
      [2026-10-12 completion update](social-rollout-runbook.md#configuration-and-notification-completion--2026-10-12).
- [x] Confirm the `OpsSummary` alarm is `OK`. It treats missing data as
      breaching, so it also reports a stopped or hung process.
- [ ] Enable the alerts the free-tier Atlas project offers and note where its
      operation counters, connections and Network Out are watched.

### Enable for testing

Enabling a flag exposes it to every signed-in Web account; there is no
per-account cohort.

- [x] **CI prerequisite before `FINITUDE_ROOMS_ENABLED=true`:** record consecutive
      pull-request and merged-main CI passes with both `firefox-audio-formats`
      and `webkit-audio-formats` blocking. The
      [2026-10-12 release evidence](../testing/finitude-web-release-matrix.md#verified-release-status--checked-2026-10-12)
      closes this prerequisite. Keep rooms disabled until the remaining email,
      audio-catalog and controlled rollout checks are ready.

- [x] Prepare two distinct operator-owned application accounts in separate
      contexts: the recovered original Chrome account and the newly registered,
      verified account signed in through the in-app browser. The earlier Gmail
      plus-address attempt did not create a separate account. Keep the primary
      Gmail and original Finitude sessions signed in during controlled testing.
- [ ] Obtain separate approval for the controlled Rooms window, then set both
      flags to `true` in one environment update during that quiet window.
      Approval remains pending; retaining the SES sandbox does not authorize
      this window. The restart is a short outage on the single instance.
- [ ] `/health` shows `rooms.enabled: true`, `authorityState: "ready"` and a
      `lastSuccessfulSweepAgeMs` of a few seconds or less. The
      `social_capacity_config` log line shows 1 open room, 2 members and 10
      sockets with no `invalidSettings`. The probe returns `403 0`, and a test
      room connects over `wss://`.
- [ ] Run the social runbook's two-account smoke test with operator-owned
      accounts only, including an MP3 track with confirmed production analysis.
- [ ] With one playing two-member room, record the `ops_summary` peaks,
      instance memory, and Atlas operation counters and Network Out. Compare
      them with the capacity budget: one playing two-member room costs about
      46 operations per second, and the shipped worst case (adding the sweep,
      lease, the other sockets and tab polling) is about 64 (see
      `docs/deployment/t4g-micro-capacity-screen.md`).
- [ ] Redeploy the same application version while a test room is playing. The
      new process reports `authorityState: "ready"` within about 10 seconds of
      `server_listening`, both tabs reconnect, the room is paused, and nothing
      resumes until the host starts it.
- [ ] Rehearse the kill switch (social runbook section 3). Switch rooms off
      during room playback and confirm the pause within seconds, then
      `authorityState: "inactive"` and `room_wind_down` `complete` within about
      six minutes, the probe at `503 0`, and friends and shares still
      readable. Switch rooms back on and confirm nothing resumes by itself.
- [ ] Complete the social runbook's evidence record.

### After the test window

- [ ] Leave both flags on (the public launch) or switch them off until any
      stop condition is resolved, and record the decision and its owner.
- [ ] Raise a capacity limit only after measurements show Atlas headroom, or
      after the room sweep's reads are reduced or the cluster is upgraded (see
      the [capacity budget](t4g-micro-capacity-screen.md#social-and-rooms-database-budget--2026-10-04)).
- [ ] Refresh the FFmpeg pin before upstream retention ends (about 2028-09) or
      sooner for FFmpeg security fixes.

Not part of this launch: native social and rooms on iOS and Android (iOS
invitation links also need the Associated Domains item above) and shared Video,
which will add its own flag.
