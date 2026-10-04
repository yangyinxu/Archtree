# Archtree Deployment TODOs

This file tracks infrastructure work that is intentionally deferred and cannot
be completed solely through application code.

## Production HTTPS for Authentication

Status: Recovered on 2026-08-05 at 23:38 EDT. Production commit `9b62537`
deployed successfully through CodePipeline and Elastic Beanstalk, restoring a
trusted HTTPS listener and the managed HTTP-to-HTTPS redirect.

Current state:

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
- [ ] Verify the SES sender/domain, grant the runtime only `ses:SendEmail`, and
      configure `AUTH_EMAIL_FROM` plus an `AUTH_CODE_PEPPER`.
- [ ] Set `AUTH_LINK_ORIGIN` to the exact production Web origin
      (`https://kashewt.com`) **before** deploying Web email-link
      registration. Every account must now have a verified email, and most
      existing accounts (including operator admin accounts) predate
      verification: their next password sign-in returns `403
      email_verification_required` and depends on a delivered verification
      link. Without SES, `AUTH_EMAIL_FROM` and `AUTH_LINK_ORIGIN`, those
      accounts cannot sign in again until email works (existing sessions keep
      working). Deploy Archtree before the native releases.
- [ ] After that deploy, send yourself a registration link, an
      already-registered notice and a verification link, and confirm each link
      opens the Finitude Web page on the production origin.
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

Status: Repository support added; nothing has been deployed or enabled in
production. The first social release is Finitude Web only, with Audio-only
rooms, behind `FINITUDE_SOCIAL_ENABLED` and `FINITUDE_ROOMS_ENABLED` (both
default `false`). It reaches production in the same `develop` to `main` merge
as email verification. Native social and rooms, and shared Video, are deferred
(see the [social plan](plans/social-and-shared-playback-plan.md)). The
procedures are in the [social rollout runbook](deployment/social-rollout-runbook.md)
and the [Finitude Web runbook](deployment/finitude-web-rollout-runbook.md); this
list tracks what has been done on the production environment. Keep the evidence
in the social runbook's evidence record.

Repository support for this launch: the HTTPS Nginx server forwards WebSocket
upgrades for the room connection, a prebuild hook installs a pinned,
digest-verified FFmpeg, an operator backfill analyzes existing Audio, a process
started with rooms off pauses and winds down open rooms, and `/health`, the
minutely `ops_summary` log line and `.ebextensions/social-capacity.config`
(1 open room, 2 members, 10 realtime sockets) cover signals and capacity.

### Before the release reaches production

- [ ] Complete the email items under Production HTTPS for Authentication
      above: the verified SES sender/domain, a runtime limited to
      `ses:SendEmail`, `AUTH_EMAIL_FROM`, `AUTH_CODE_PEPPER` and
      `AUTH_LINK_ORIGIN`. The same merge requires a verified email at password
      sign-in, so most existing accounts cannot sign in again until email
      delivery works.
- [ ] Merge `develop` into `main` through a pull request and require the
      release workflow on both the pull request and the merged-main push:
      unit, integration, the nine social browser scenarios, the three-engine
      browser/axe gate and artifact staging. Artifact staging refuses a
      bundle without the FFmpeg prebuild hook, `room-audio-decoder.config` or
      `social-capacity.config`.
- [ ] Record the release owner, rollback owner, observation window and stop
      conditions, and keep the current production artifact retrievable for
      rollback.
- [ ] Confirm both rollout flags are absent or `false` on the environment with
      the social runbook's query, which prints only the `FINITUDE_*` values.
- [ ] Deploy in a quiet window. The first deployment downloads about 117 MB of
      FFmpeg from GitHub, and `npm install` runs beside the old process on the
      1 GiB instance, where an earlier configuration update stalled.

### Deploy with both flags off

- [ ] `/health` returns 200. Startup creates the social and room indexes and
      stops if a unique or required index cannot be verified; the log shows no
      `optional_index_unavailable` line.
- [ ] The `/health` `rooms` object reports `enabled: false` and
      `authorityState: "inactive"`, and the log shows `room_wind_down`
      `complete` after the latest `server_listening`.
- [ ] The Nginx WebSocket upgrade fix is live. The deployment rewrites the
      existing HTTPS configuration in place without reissuing the certificate.
      The Finitude Web runbook's WebSocket probe returns `503 0` while rooms
      are off: the empty refusal comes from the application's upgrade handler,
      so Nginx forwarded the upgrade. A `401` with a body means Nginx dropped
      `Upgrade`/`Connection`.
- [ ] For a signed-in test account, `GET /api/social/v1/capabilities` reports
      `socialEnabled: false` and `roomsEnabled: false`, and Finitude Web shows
      no Together entry or social actions.
- [ ] The Finitude Web runbook's listener smoke checks and the email-link
      checks above pass.

### Room audio decoder and catalog backfill

The prebuild hook installs FFmpeg and the operator backfill analyzes existing
Audio (see the README's room audio decoder and catalog backfill sections).

- [ ] Confirm `/var/log/eb-hooks.log` shows the verified install,
      `/usr/local/bin/ffmpeg -hide_banner -version` runs, and
      `ROOM_AUDIO_FFMPEG_PATH` resolves to `/usr/local/bin/ffmpeg`.
- [ ] Upload a short original MP3 through Content Manager and confirm the Room
      audio analysis page lists it as eligible.
- [ ] From an operator machine with FFmpeg, run the backfill dry run against
      production and review its `wouldAnalyze` count.
- [ ] Apply the backfill in paced runs until a summary reports `finished=true`,
      then rerun once without `--after` to retry any `retryLater` tracks.
- [ ] Keep the backfill log's final summary with the rooms release evidence.

### Monitoring and alarms

- [ ] Stream the instance logs to CloudWatch Logs with about seven days of
      retention and confirm an `ops_summary` line arrives every minute.
- [ ] Create the social runbook's eight metric filters and alarms with an SNS
      topic that reaches the operator. Set the open-socket alarm at 80% of the
      effective socket limit (8 with the shipped 10). Check that other custom
      metrics and alarms in the account leave room within the free tier's ten
      of each.
- [ ] Confirm the `OpsSummary` alarm is `OK`. It treats missing data as
      breaching, so it also reports a stopped or hung process.
- [ ] Enable the alerts the free-tier Atlas project offers and note where its
      operation counters, connections and Network Out are watched.

### Enable for testing

Enabling a flag exposes it to every signed-in Web account; there is no
per-account cohort.

- [ ] In a quiet window, set both flags to `true` in one environment update.
      The restart is a short outage on the single instance.
- [ ] `/health` shows `rooms.enabled: true`, `authorityState: "ready"` and a
      `lastSuccessfulSweepAgeMs` of a few seconds or less. The
      `social_capacity_config` log line shows 1 open room, 2 members and 10
      sockets with no `invalidSettings`. The probe returns `403 0`, and a test
      room connects over `wss://`.
- [ ] Run the social runbook's two-account smoke test with operator-owned
      accounts only, including an MP3 track that became eligible through the
      backfill.
- [ ] With one playing two-member room, record the `ops_summary` peaks,
      instance memory, and Atlas operation counters and Network Out. Compare
      them with the capacity budget (about 46 operations per second).
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
      the [capacity budget](testing/t4g-micro-capacity-screen.md#social-and-rooms-database-budget--2026-10-04)).
- [ ] Refresh the FFmpeg pin before upstream retention ends (about 2028-09) or
      sooner for FFmpeg security fixes.

Not part of this launch: native social and rooms on iOS and Android (iOS
invitation links also need the Associated Domains item above) and shared Video,
which will add its own flag.
