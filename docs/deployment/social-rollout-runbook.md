# Social and Listening Rooms Rollout Runbook

This runbook controls the Web-only Audio social release on the single Elastic
Beanstalk instance: enabling it for testing, the kill switch, verification and
rollback. Product behavior is canonical in
[`../business-rules.md`](../business-rules.md); release promotion and application
rollback follow the [Finitude Web runbook](finitude-web-rollout-runbook.md).
Switching social or rooms off never deletes profiles, friendships, shares,
settings or blocks.

## Switches

| Variable | Default | Controls | Effect when not `true` |
| --- | --- | --- | --- |
| `FINITUDE_SOCIAL_ENABLED` | `false` | Profiles, friend requests, music shares and listening status | Refuses new participation; reads, opt-out, removal, block, dismissal and account cleanup remain. Listening status is hidden. Rooms are off too. |
| `FINITUDE_ROOMS_ENABLED` | `false` | Audio listening rooms and their realtime connection, only together with social | Refuses room creation, joining, playback and realtime upgrades; leave, end, remove, decline, cancelling a host transfer, shared pause and dismissing or withdrawing recommendations remain. Open rooms are wound down. |

The first release deliberately keeps only these two flags. Shares and listening
status already have per-user opt-in/out and safety exits, and rooms are
Audio-only; a Video sync flag arrives with shared Video. There is no per-account
cohort: enabling a flag exposes it to every signed-in Web account.

Both flags are read when the process starts. An environment-property update
restarts the application, which is a short user-visible outage on the single
instance: in-flight requests drain for up to `SERVER_SHUTDOWN_GRACE_MS`
(30 seconds by default) and open realtime connections close. Change both flags in
one update so the application restarts once.

### Reading and changing the flags

Read only the rollout flags, without printing any other environment value:

```bash
aws elasticbeanstalk describe-configuration-settings \
  --application-name <application> --environment-name <environment> \
  --query "ConfigurationSettings[0].OptionSettings[?Namespace=='aws:elasticbeanstalk:application:environment' && starts_with(OptionName, 'FINITUDE_')].[OptionName,Value]" \
  --output text
```

Change them with the console (**Configuration → Updates, monitoring, and logging →
Environment properties**), the EB CLI
(`eb setenv FINITUDE_ROOMS_ENABLED=false -e <environment>`), or:

```bash
aws elasticbeanstalk update-environment --environment-name <environment> \
  --option-settings \
  Namespace=aws:elasticbeanstalk:application:environment,OptionName=FINITUDE_SOCIAL_ENABLED,Value=true \
  Namespace=aws:elasticbeanstalk:application:environment,OptionName=FINITUDE_ROOMS_ENABLED,Value=true
```

Wait until the environment reports **Ok** before verifying. The HTTPS
configuration-deployment hook re-applies the Nginx configuration on each update.

### Capacity limits

The free-tier Atlas cluster throttles above 100 operations per second, and rooms
are its largest steady consumer. `.ebextensions/social-capacity.config` therefore
ships conservative limits that apply only while both flags are `true`:

| Variable | Shipped | Product maximum | Refusal the listener sees |
| --- | ---: | ---: | --- |
| `FINITUDE_ROOMS_MAX_OPEN` | 1 | 100 | Creating a room: "Rooms are at capacity right now." |
| `FINITUDE_ROOM_MAX_MEMBERS` | 2 | 8 | Accepting an invitation: "This room is full." The invitation stays pending. |
| `FINITUDE_REALTIME_MAX_SOCKETS` | 10 | 256 | Live updates: "Live room updates are busy right now." Retried after 30 seconds. |

Socket seats split into reserved and general seats. The reserved seats number the
open-room limit times the member limit, at most half of all sockets; with the
shipped values that is 2 reserved and 8 general. Each connected room member's
first socket takes a reserved seat, and every other socket takes a general one.
One account may hold a quarter of the general seats (between one and four
sockets; two when shipped), plus its first socket while it is in a room. A
refused tab can still create a room, accept an invitation and invite friends
over HTTP, then connects right away with the member's reserved seat. If a room
ends while the sockets are over the general seats, each former member's socket
that no longer fits is closed with WebSocket code 1013 and that tab waits like
any other. Concurrent room creation cannot exceed the open-room limit, because
every create writes the room authority fence, so conflicting creates retry
against the committed room. Lowering a limit never removes members or
closes open rooms.
Derivation and the transfer caveat are in the
[capacity budget](../testing/t4g-micro-capacity-screen.md#social-and-rooms-database-budget--2026-10-04).
To change a limit, set the variable as an environment property; that overrides the
shipped default and restarts the application like a flag change. To return to the
shipped value, set it back explicitly. Raise limits only after watching Atlas
operation counters and **Network Out** with the `ops_summary` gauges during a
real enablement. After each restart, the log's `social_capacity_config` line shows
the effective values and names any setting that could not be used.

## Production authentication email configuration

The 2026-10-11 console and CloudShell reads confirmed `AWS_REGION=us-east-1`,
`AUTH_EMAIL_FROM=no-reply@kashewt.com` and
`AUTH_LINK_ORIGIN=https://kashewt.com`. SES reports `SendingEnabled: true`,
`ProductionAccessEnabled: false`, and successful domain verification and DKIM
for `kashewt.com`. Account-level suppression covers `BOUNCE` and `COMPLAINT`;
the account's production-access `Details` object was empty. `AUTH_CODE_PEPPER`
was absent from the environment properties at that check, so the application
used its supported `JWT_SECRET` fallback. The remaining
configuration and acceptance sequence includes the later approved recipient
permission repair and T1 acceptance; the remaining email-flow checks stay open:

1. Domain-policy setup complete: the production runtime identity is confirmed
   as `ArchtreeAdmin`.
   Its inline `ArchtreeSesSendAuthEmail` policy was narrowed and read back as
   `ses:SendEmail` on
   `arn:aws:ses:us-east-1:<production-account-id>:identity/kashewt.com`, conditioned
   on `ses:FromAddress=no-reply@kashewt.com`. The identity has no groups or other
   inline policies; its attached `ArchtreeS3Policy` contains only S3 actions.
   Simulation returns `allowed` for the approved sender and domain, and
   `implicitDeny` for another sender, `ses:SendRawEmail` and another identity.
   The raw-email action and wildcard identity scope have been removed.
   Two later SDK transport probes returned `AccessDenied` for the exact approved
   sandbox-recipient SES identity. The operator subsequently approved adding
   only that identity, retaining `ses:SendEmail` and the exact From-address
   condition. All five simulations passed again, the update returned HTTP 200,
   and strict readback matched the approved policy. Independent transport and
   application T1 emails were then received; see the
   [evening completion record](#email-permission-and-t1-completion--2026-10-12).
2. Complete on 2026-10-12: the operator configured a dedicated `AUTH_CODE_PEPPER`
   in CloudShell, and boolean-only environment readback confirmed it is present
   after the update completed. No value is retained here. Changing from the
   fallback key invalidates outstanding reset codes and emailed links; request
   new links for verification afterward. Future rotations must use the approved
   secret-management path without logging values. Do not rotate `JWT_SECRET`
   for this purpose.
3. While SES remains in its regional sandbox, use only an explicitly authorized,
   verified test recipient (or the SES mailbox simulator). Verify each exact
   recipient address before sending; do not assume a plus-address variant inherits
   another address's verification. The 2026-10-11 recipient-verification attempt
   is recorded below as historical evidence. Current testing uses the operator's
   dedicated test mailbox; its exact SES identity was verified later on
   2026-10-12, with `VerifiedForSendingStatus: true`. Keep the address outside the
   repository and preserve the operator's primary signed-in session. The operator
   has explicitly chosen to retain the SES sandbox and defer the production-access
   request. Earlier console form preparation used `TRANSACTIONAL`,
   `https://kashewt.com` and English, with optional contacts blank; it did not
   submit a request or accept its terms. The unsubmitted form was subsequently
   cancelled, returning to the Get set up page with its sandbox heading and no
   open terms or submission form. No submission is currently authorized.
   The
   [SES production-access procedure](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
   defines the regional sandbox restriction; a successful sandbox test does not
   make ordinary listener email delivery available.
4. After configuration and permission verification, verify receipt of registration,
   already-registered and verification messages through the application and open
   their links on the production origin. T1 receipt, account creation/login and
   rejection of its consumed link within 30 minutes are verified. T2 receipt and
   its token-free production destinations, plus six-digit reset-code receipt,
   are also verified; T3/legacy verification and actual password-reset completion
   remain open. Retain only a timestamp, message type, delivery result and
   link-origin result; never retain recipient addresses, one-time links, tokens
   or private account content in the repository. Require
   `ProductionAccessEnabled: true` before declaring public email delivery ready.

The authorized production `POST /auth/browser/registration/request` test on
2026-10-11 returned generic `202 Accepted`. This proves request acceptance only;
it does not prove SES acceptance, mailbox receipt or a usable verification link.
A later authorized Chrome Gmail session was available, and a search scoped to
the approved test recipient found zero application emails. The last-hour log
query found zero registration failure events, but log streaming began after the
request, so that result does not establish SES acceptance. The separately
requested AWS SES recipient-verification email was visibly received at 15:02 UTC;
this confirms receipt of that AWS message only. At that point, final SES identity
confirmation awaited operator approval, and the application test still needed
to be repeated after verification, including email receipt and link inspection.
The delivery gate remained open; no recipient address, verification URL or token
is retained here.

The initial 2026-10-12 read-only check reconfirmed the verified domain and DKIM,
`ProductionAccessEnabled: false`, and no configured `AUTH_CODE_PEPPER`.
Application email receipt and link use were unverified at that check. The current
dedicated test mailbox is separate from the historical recipient attempt above;
that AWS verification message supplies no evidence for delivery to the current
test mailbox.

The later [completion update](#configuration-and-notification-completion--2026-10-12)
records the dedicated pepper and exact test-recipient verification. SES production
access remains disabled by operator decision, and the unsubmitted request is
intentionally deferred. Public email readiness remains unmet. The
subsequent [diagnostic record](#email-diagnostics-and-catalog-inventory--2026-10-12)
preserves the earlier application failure and independent transport denials.
The later [evening completion record](#email-permission-and-t1-completion--2026-10-12)
records the approved permission repair, T1 creation/replay, T2 and reset-code
receipt, with the remaining email-flow limits kept explicit.

## Signals

- `GET /health` is unauthenticated. Its `rooms` object reports `enabled` (both
  flags), `authorityState` and its change count `authorityChanges`,
  `lastSuccessfulSweepAgeMs`, `openSockets`, `openRooms` and fixed failure counters.
  `authorityState` is `ready` while rooms are enabled, `windingDown` while a
  process started with rooms off is ending rooms left open, `unavailable` after a
  lease or database failure, and `inactive` when nothing holds the room authority.
  On a flags-off boot it briefly reports `starting`, and it can report
  `unavailable` until the next five-second tick if the first pre-listen tick hits
  a transient database error. The room state never changes the `/health` status
  code. Its `requests.byArea.social` counts `/api/social/v1` traffic, with
  `limited` for 429 refusals and `failed` for 5xx responses.
- The application log (`/var/log/web.stdout.log`, included in `eb logs`) contains
  `{"category":"server_listening",...}` after each restart. A process started with
  rooms off adds `{"category":"room_wind_down","state":"started"}` when it finds an
  open room and `{"category":"room_wind_down","state":"complete"}` once none
  remains (immediately when there was none).
- The WebSocket probe in the Finitude Web runbook answers `403 0` when rooms are
  enabled and the proxy forwards upgrades, and `503 0` when rooms are off.

### Structured log lines

The application emits each line as one JSON object with a `category`. They contain
fixed labels, counts and at most an opaque room ID, never an account, session,
address, handle, token or error text. Elastic Beanstalk adds a syslog prefix to the
stored stdout message; CloudWatch must parse that prefix before JSON metric
filters can read these fields (see the transformer below).

| Category | When | Fields |
| --- | --- | --- |
| `ops_summary` | Every 60 seconds in every process | See below |
| `room_lifecycle` | After a room is created, suspended for host absence, or closed | `transition` (`created`, `suspended`, `closed`), `roomId`, and for closures `reason`: `hostEnded`, `hostAbsent` (five minutes), `hostMissing`, `expired` (24 hours) or `accountLifecycle` (the host's account was deactivated, deleted or signed out everywhere; reported by the next sweep. During a deployment overlap, a room ended in the other process is also reported this way) |
| `room_authority` | When the room authority state changes | `state` |
| `social_capacity` | At most once a minute per limit while refusals occur | `limit` (`sockets`, `openRooms`, `roomMembers`), `maximum` |
| `social_capacity_config` | At startup with rooms enabled | `maxOpenRooms`, `maxRoomMembers`, `maxRealtimeSockets`, `invalidSettings` (variable names) |

`ops_summary` fields (counts cover the interval unless marked as a gauge):

- `capacity`: the effective limits.
- `rooms.enabled`, `rooms.authorityState`, `rooms.lastSuccessfulSweepAgeMs`,
  `rooms.openRooms`, `rooms.openSockets`: gauges, as in `/health`.
- `rooms.authorityChanges`; `rooms.socketsOpened`, `rooms.socketsClosed`,
  `rooms.peakSockets`; `rooms.socketCloses.{normal, goingAway, policy, unavailable, abnormal}`.
- `rooms.upgradeRejections.{unavailable, unauthorized, attemptRate, pending, capacity, perAddress, perAccount}`
  and `rooms.upgradeRejectionsTotal`.
- `rooms.ticketFailures.{capacity, perAccount, limit, session, unavailable}` and
  `rooms.ticketFailuresTotal`. `capacity` means the seats were full; `perAccount`
  means one account already held its share (no `social_capacity` line).
- `rooms.capacityRejections.{sockets, openRooms, roomMembers}` and
  `rooms.capacityRejectionsTotal`.
- `rooms.fanoutPasses` and `rooms.fanoutLagMaxMs`: how long the slowest pass took,
  from a committed change's wakeup (or the five-second recovery tick) until every
  socket was re-read. This is the outbox delivery lag; the outboxes themselves
  hold only invalidation versions.
- `rooms.roomsCreated`, `rooms.roomsSuspended`, `rooms.roomsClosed`.
- `rooms.failures.{authorityAcquisition, sweep, refresh, report, disconnect}` and
  `rooms.failuresTotal`: increases since the previous summary.
- `rejections.total` and `rejections.byCode`: social and room 429/503 error codes
  (for example `social_limit`, `ticket_limit`, `realtime_capacity`,
  `room_unavailable`) and rejected room commands for limits (`room_capacity`,
  `room_full`, `room_reaction_limit`, ...).
- `limiters.total` and `limiters.byScope`: HTTP 429s per request limiter (for
  example `room-http`, `room-http-read`, `social-api`, `social-mutation`, `auth`),
  with media admission refusals as `media-delivery`.

### CloudWatch metric filters and alarms

Application status: Log ingestion, alarms and operator test-notification delivery
are complete. The 2026-10-11 logging update completed with the
environment `Ready/Green/Ok` and its application version unchanged. Seven log
groups have seven-day retention and stdout receives real `ops_summary` events.
The stdout transformer, eight transformed-log metric filters, eight alarms and
`archtree-operations` SNS topic are created. Each metric has six real 60-second
datapoints in the latest 15-minute readback, and all eight alarms are `OK` with
actions enabled and the topic configured. The topic had no subscription, so
operator notification delivery remained unverified at that baseline check.

The initial 2026-10-12 readback again found all eight alarms `OK`, with actions
enabled, and zero confirmed or pending operations-topic subscriptions. This refreshes
the baseline alarm evidence. The later
[completion update](#configuration-and-notification-completion--2026-10-12)
records the single approved confirmed subscription and verified test-notification
receipt, closing that gate without changing the earlier observations.

Stream the application log to CloudWatch Logs first (console: **Configuration →
Updates, monitoring, and logging → Instance log streaming**, or option
`aws:elasticbeanstalk:cloudwatch:logs` `StreamLogs=true`, with a short retention
such as seven days). The log group is
`/aws/elasticbeanstalk/Archtree-2024-env/var/log/web.stdout.log`. One summary a minute
is about 45 MB a month; streaming also sends the platform's other logs, so check
ingestion against the 5 GB free allowance. The suggested set below uses eight
custom metrics and eight alarms, which fits the CloudWatch free tier's ten of each
when nothing else uses them.

Review these common parameters before creating the filters or alarms:

| Setting | Configuration |
| --- | --- |
| Region and environment | `us-east-1`; `Archtree-2024-env` (`e-qeb3ekat4i`) |
| Instance log streaming | Namespace `aws:elasticbeanstalk:cloudwatch:logs`: `StreamLogs=true`, `RetentionInDays=7`, `DeleteOnTerminate=false` |
| Metric namespace and dimensions | `Archtree/Social`; no dimensions, one filter set on the production stdout group |
| Transformer | Grok removes the platform prefix into `payload`; `parseJSON` writes that payload to `ops` |
| Filter pattern | `{ $.ops.category = "ops_summary" }` for all eight filters, with `applyOnTransformedLogs=true` |
| Metric unit | `Milliseconds` for `FanoutLagMax`; `Count` for the other seven |
| SNS topic | `archtree-operations` created in the same region; use its returned ARN for every alarm action |
| Notification target | Operator-selected recipient, retained outside the repository; its SNS subscription must be confirmed |
| Alarm notifications | `ActionsEnabled=true`; `AlarmActions=[<confirmed-topic-arn>]`; `OKActions=[<confirmed-topic-arn>]` |

Enable streaming and the transformer before creating log metric filters, and
confirm a real `ops_summary` event reaches the stdout group. Transformations and
metric filters apply at ingestion; they do not reconstruct historical events.
Confirm the SNS subscription and a test notification before
treating a configured alarm as operator-visible. Both checks completed for the
current subscription on 2026-10-12; repeat them whenever its destination changes.

The original `{ $.category = "ops_summary" }` filter matched no production
events because the raw message contains the platform prefix. `TestTransformer`
successfully parsed an actual stdout event with this processor sequence, which
is now installed on the stdout group. This reproducible example tests a synthetic
summary before creating or replacing the group transformer:

```bash
archtree_stdout_transformer='[
  {"grok":{"match":"%{DATA}: %{GREEDYDATA:payload}"}},
  {"parseJSON":{"source":"payload","destination":"ops"}}
]'
aws logs test-transformer --region us-east-1 \
  --transformer-config "$archtree_stdout_transformer" \
  --log-event-messages 'Oct 11 12:00:00 example-host web[1]: {"category":"ops_summary","rooms":{"openSockets":0}}' \
  --query 'transformedLogs[].transformedEventMessage' --output text
aws logs put-transformer --region us-east-1 \
  --log-group-identifier /aws/elasticbeanstalk/Archtree-2024-env/var/log/web.stdout.log \
  --transformer-config "$archtree_stdout_transformer"
```

After platform or log-format changes, test the parser against a current real
summary before updating it; do not store private log payloads in the repository.
The processor schema follows
[`put-transformer`](https://docs.aws.amazon.com/cli/latest/reference/logs/put-transformer.html).
Create or update each metric filter on transformed events, for example open sockets:

```bash
aws logs put-metric-filter --region us-east-1 \
  --log-group-name /aws/elasticbeanstalk/Archtree-2024-env/var/log/web.stdout.log \
  --filter-name archtree-open-sockets --filter-pattern '{ $.ops.category = "ops_summary" }' \
  --apply-on-transformed-logs \
  --metric-transformations metricName=OpenSockets,metricNamespace=Archtree/Social,metricValue='$.ops.rooms.openSockets',unit=Count
aws cloudwatch put-metric-alarm --region us-east-1 --alarm-name archtree-open-sockets-near-cap \
  --namespace Archtree/Social --metric-name OpenSockets --statistic Maximum --period 300 \
  --evaluation-periods 3 --datapoints-to-alarm 3 --threshold 8 \
  --comparison-operator GreaterThanOrEqualToThreshold --actions-enabled \
  --treat-missing-data notBreaching --alarm-actions '<confirmed-topic-arn>' \
  --ok-actions '<confirmed-topic-arn>'
```

Each row defines one filter and one alarm. Periods are in seconds; `M/N` means
`DatapointsToAlarm=M`, `EvaluationPeriods=N`. Use `LessThanThreshold` for `<`,
`GreaterThanThreshold` for `>`, and `GreaterThanOrEqualToThreshold` for `>=`.

| Filter name / metric | Metric value | Alarm name | Statistic / period | Breach / M/N | Missing data |
| --- | --- | --- | --- | --- | --- |
| `archtree-ops-summary` / `OpsSummary` | `1` | `archtree-ops-summary-missing` | Sum / 300 | `< 3` / 1/1 | `breaching` |
| `archtree-open-sockets` / `OpenSockets` | `$.ops.rooms.openSockets` | `archtree-open-sockets-near-cap` | Maximum / 300 | `>= 8` / 3/3 | `notBreaching` |
| `archtree-capacity-rejections` / `CapacityRejections` | `$.ops.rooms.capacityRejectionsTotal` | `archtree-capacity-rejections` | Sum / 900 | `> 0` / 1/1 | `notBreaching` |
| `archtree-room-failures` / `RoomFailures` | `$.ops.rooms.failuresTotal` | `archtree-room-failures` | Sum / 300 | `> 5` / 3/3 | `notBreaching` |
| `archtree-authority-changes` / `AuthorityChanges` | `$.ops.rooms.authorityChanges` | `archtree-authority-flapping` | Sum / 900 | `> 4` / 1/1 | `notBreaching` |
| `archtree-fanout-lag` / `FanoutLagMax` | `$.ops.rooms.fanoutLagMaxMs` | `archtree-fanout-lag` | Maximum / 60 | `> 2000` / 3/5 | `notBreaching` |
| `archtree-ticket-unavailable` / `TicketUnavailable` | `$.ops.rooms.ticketFailures.unavailable` | `archtree-ticket-unavailable` | Sum / 300 | `> 0` / 2/2 | `notBreaching` |
| `archtree-limited` / `Limited` | `$.ops.limiters.total` | `archtree-sustained-throttling` | Sum / 300 | `> 200` / 1/1 | `notBreaching` |

The socket threshold assumes the shipped limit of ten; recalculate it at 80% of
the effective limit before applying. Only `OpsSummary` treats missing data as
breaching, so an idle optional feature does not trigger the other seven alarms.
The CLI parameter shapes follow
[`put-metric-filter`](https://docs.aws.amazon.com/cli/latest/reference/logs/put-metric-filter.html)
and [`put-metric-alarm`](https://docs.aws.amazon.com/cli/latest/reference/cloudwatch/put-metric-alarm.html).

Inspect newly ingested transformed summaries with CloudWatch Logs Insights, for
example `filter ops.category = "ops_summary" | fields @timestamp, ops.limiters.byScope`.
`GetLogEvents` and `FilterLogEvents` return original messages, so a raw JSON filter
returning zero matches after transformer installation does not prove that the
transformed events or metrics are absent. Use Insights and fresh metric datapoints
to verify transformation and filters. See the
[CloudWatch transformation behavior](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CloudWatch-Logs-Transformation.html).
On the Atlas side, watch the cluster's operation counters, connections and
**Network Out**, and enable the project alerts the free tier offers.

## 1. Before the first enablement

1. Deploy the release with both flags `false` and verify it through the Finitude
   Web runbook. `/health` shows `rooms.enabled: false` and, after start,
   `authorityState: "inactive"`; the log shows `room_wind_down` `complete`.
2. Confirm the required social and room indexes were verified at startup
   (`/health` is 200) and the room audio decoder and catalog backfill checks from
   the Finitude Web runbook have passed, so eligible Audio exists.
3. Prepare two dedicated test accounts that you control. Never use a real
   listener's account or data for smoke tests. Keep their browser contexts
   separate from the operator's primary session, which must remain signed in.
   The tested Gmail plus-address variant resolved to the same application
   account. A distinct QA account has since completed registration and login in
   the in-app browser; the original Chrome account was recovered through the
   normal Finitude session refresh. Use those separate contexts for the smoke
   test; aliases alone are not evidence of separate participants.
4. Optionally rehearse locally with `npm run build` and `npm run demo:social`,
   which uses its own MongoDB and fixtures.
5. **CI prerequisite for `FINITUDE_ROOMS_ENABLED=true`:** the complete blocking
   release gate must pass on consecutive pull-request and merged-main runs.
   This prerequisite is complete for the current release (next section).
   Keep rooms disabled until the remaining production prerequisites and
   controlled rollout checks are ready.

### Cross-engine audio acceptance (blocks enabling rooms)

The release workflow's `social-e2e` job now runs every Linux social browser project
in one blocking step, including `firefox-audio-formats` and
`webkit-audio-formats`. Those two run the
[compressed-audio room scenario](../../web/e2e-social/audio-formats.spec.ts) in
Firefox and WebKit with real Linux decoders. Their previous quarantine followed
intermittent failures with different timing symptoms:

- [`expectPlaying`](../../web/e2e-social/audio-formats.spec.ts) saw no
  playing media element. Commit `4edc79c` fixed one root cause, a source whose
  metadata reported a zero duration and was never reloaded.
- After a seek, the host's `playbackGeneration` stayed at the previous value
  instead of advancing by one
  (the seek assertion in `audio-formats.spec.ts`; CI saw 4, not 5).
- Within the 10-second deadline, the synchronization poll never saw both
  members' clocks advancing smoothly for more than a second in samples captured
  within 50 ms of each other
  ([`expectSynchronized`](../../web/e2e-social/audio-formats.spec.ts)).

The 2026-10-11 repair candidate captures the current room version when each new
seek gesture begins, so a previous drag's version cannot reject a later command.
It also recovers a fully buffered decoder left at current-frame readiness after
a controller-owned drift correction, even if its media clock is still advancing.
Each playback occurrence permits at most one decoder-stall reload and one
missing-duration reload. The separate budgets cover a WebKit decoder reinstall
that reports a zero duration; neither failure can replenish its own budget.
The merged-main run `38160763777` exposed that sequence after MP3-to-AAC
advancement, while its other 16 social tests passed. Recovery stays bounded
at two paused source reloads per playback occurrence;
future-data readiness, drift tolerances, local-pause cancellation and zero test
retries are preserved.

The separate quarantine config, command and `continue-on-error` step are removed.
All social traces, screenshots and drift evidence now use the `social-real/`
folder of the `finitude-social-browser-evidence` artifact. Any project's failure
blocks artifact staging and the `social` provenance outcome. To reproduce just
the compressed-audio pair on Linux with an isolated audio sink:
`CI=1 xvfb-run -a npm run test:e2e:social --workspace @archtree/finitude-web -- --project=firefox-audio-formats --project=webkit-audio-formats`.

The [2026-10-12 release evidence](../testing/finitude-web-release-matrix.md#verified-release-status--checked-2026-10-12)
records consecutive successful pull-request and merged-main runs of the complete
blocking gate. It closes Linux cross-engine acceptance for the current release.
The 2026-10-11 evidence table below remains historical and does not describe the
latest CI or deployed version.

Before rooms are enabled in production:

1. For each new release candidate, preserve the complete blocking Linux gate;
   diagnose failures without widening tolerances or adding retries to hide drift.
2. Retain consecutive passing pull-request and merged-main runs with both audio
   projects and the exact candidate/build identity. The linked current release
   record contains this evidence.
3. Keep production rooms disabled while email delivery, distinct test-account
   and audio-catalog preparation remain incomplete. Use the controlled test
   window below for deployment smoke, observation and kill-switch checks before
   leaving the feature enabled for public use.

## 2. Enable for testing

1. Obtain separate operator approval for the controlled Rooms window; it remains
   pending, and the decision to retain the SES sandbox does not authorize it.
   Pick a quiet window and record the start time, owner and stop conditions.
   Confirm the repaired cross-engine audio projects have passed the blocking
   acceptance gate (section 1, step 5); otherwise do not set `FINITUDE_ROOMS_ENABLED`.
2. Set `FINITUDE_SOCIAL_ENABLED=true` and `FINITUDE_ROOMS_ENABLED=true` in one
   update. To test social without rooms, set only social to `true`.
3. After the environment is **Ok**, verify `/health` `rooms.enabled: true`,
   `authorityState: "ready"` and a `lastSuccessfulSweepAgeMs` below a few seconds.
   Run the WebSocket probe and expect `403 0`.
4. Smoke test with the two test accounts in separate browsers:
   create identities, send and accept a friend request, share a track and open
   it from Music shares, enable **Share what I’m listening to** and see the
   status from the other account, then create a room with eligible Audio,
   invite and join, play, pause, react, recommend a track, leave and end.
5. Watch `/health` failure counters, the `ops_summary` lines (or their alarms)
   and environment health for the observation window. Stop and use the kill
   switch on any private-data exposure, sustained server errors, rising room
   failure counters, Atlas throttling or a stop condition.

## 3. Kill switch

Use the narrowest switch that contains the problem:

- **Rooms only:** set `FINITUDE_ROOMS_ENABLED=false`. Friends, shares and ordinary
  listening status keep working.
- **All social:** set `FINITUDE_SOCIAL_ENABLED=false`. Rooms stop as well.

What happens after the restart:

1. Every realtime upgrade gets `503`. Web clients stop connecting and offer no
   room playback, while leave, end and decline keep working.
2. Within seconds of startup, every open room's shared playback is paused and
   `authorityState` is `windingDown`. If the previous process could not release
   its lease, this waits up to 10 seconds for that lease to expire.
3. Open rooms then follow the ordinary rules: suspended 30 seconds and ended five
   minutes after the host's last heartbeat before the restart, or at their
   24-hour expiry. A host can end a room sooner.
4. When no room remains open the process releases the room authority, logs
   `room_wind_down` `complete`, reports `authorityState: "inactive"` and stops
   polling. A disabled process cannot open another room.

Verify within about six minutes of the restart:

- `/health` shows `rooms.enabled: false` and `authorityState: "inactive"`.
- The log shows `room_wind_down` `complete` for the latest process start (it can
  appear just before `server_listening`).
- The WebSocket probe returns `503 0`.
- With only rooms off, a test account can still read friends and shares.

If `authorityState` stays `unavailable`, check database connectivity and the
`authorityAcquisition`/`sweep` counters. Another live process can hold the lease
only during an overlapping deployment; it is released on that process's shutdown
or expires within 10 seconds. Do not delete room documents by hand.

## 4. Re-enable

Set the flag back to `true`. Ended rooms stay ended. A room that was still open
stays paused or suspended until its host explicitly starts it again; nothing
resumes by itself. Repeat the checks in section 2, step 3.

## 5. Roll back

- To stop the feature, use the kill switch; it needs no application rollback and
  keeps every social record.
- Before an application rollback to a bundle released before this wind-down
  existed, first switch rooms off on the current bundle and wait for
  `room_wind_down` `complete`. An older bundle does nothing with rooms while they
  are off, so a room still open would otherwise stay open and unpaused in the
  database until rooms are enabled again.
- Then roll back through the Finitude Web runbook. Social collections, indexes and
  closed-room records are additive; the previous bundle may ignore them, and
  rollback must not delete them. Closed rooms are removed by their existing
  24-hour TTL.

## Evidence record

| Field | Required value |
| --- | --- |
| Release | `RELEASE.json` commit and environment version |
| Cross-engine audio gate | Before enabling rooms: the repair candidate identity and new consecutive passing pull-request and merged-main runs with `firefox-audio-formats` and `webkit-audio-formats` blocking |
| Flags | Values before and after each change, time and owner |
| Enablement | `/health` rooms snapshot, probe result, smoke-test result, `social_capacity_config` line |
| Kill switch rehearsal | Restart time, time to pause, time to `inactive`, probe result, social reads with rooms off |
| Re-enable | `/health` rooms snapshot and probe result |
| Exceptions | Accepted difference, owner, expiry/follow-up |

Before the first public enablement, rehearse the kill switch once with the
test accounts: start room playback, switch rooms off, confirm the pause and
the end within about six minutes, confirm social reads still work, then switch
rooms back on.

### Deployment verification — 2026-10-11

This historical record preserves what was observed on 2026-10-11 without
closing the enablement, monitoring or rollback gates. Its CI runs predate the
repaired complete gate; the current CI evidence is linked above and the later
production check follows this table.

| Check | Observed evidence and limit |
| --- | --- |
| Main workflow observed then | [Run 37220116476](https://github.com/yangyinxu/Archtree/actions/runs/37220116476), created 2026-10-04 17:20:11 UTC, commit `b7c44fdad3aa84d05ba12637beeefd75c7737108`, succeeded. Its blocking social selection passed 15 tests. The non-blocking selection failed Firefox's seek-generation check (expected 5, received 4); WebKit passed. Overall success did not close quarantine. |
| Pull-request workflow observed then | [Run 37219198449](https://github.com/yangyinxu/Archtree/actions/runs/37219198449), created 2026-10-04 17:05:34 UTC, head `9630720508e22600c220d3a76d479ec28c82406d`, succeeded, including both quarantined tests. The subsequent main failure prevented treating this as stable cross-engine acceptance. |
| Public Web deployment | `/finitude` HTML and its four directly referenced JS/CSS assets matched the retained main artifact byte for byte. The artifact's `RELEASE.json` records the main commit above and build `github-37220116476-1`. The backend's on-instance `RELEASE.json` has not been independently read. |
| Production environment | A later signed-in console inspection confirmed `Archtree-2024-env` (`e-qeb3ekat4i`) in `us-east-1`, Health `Ok`, running version `code-pipeline-1791171387027-ArchtreeBuildArtifacts-745b4485-c6dd-468b-b4ec-bb5b5e6bb624`, Node.js 24 on Amazon Linux 2023 platform `6.11.9`, one ARM64 `t4g.micro`, and enhanced health reporting. |
| Public runtime | `/health` returned 200 with `rooms.enabled: false`, `authorityState: "inactive"`, zero sockets and zero room failure counters. `/api/listener/v1/capabilities` reported both social and rooms disabled. `/health` exposes no release identity. These snapshots do not prove startup logs, backfill, monitoring or a kill-switch rehearsal. |
| Authentication prerequisite | Public capabilities reported `emailRegistration: true`; registration and verification pages returned the listener shell. Console and CloudShell confirmed the approved sender, exact production link origin and region, SES domain/DKIM success, `SendingEnabled: true`, `ProductionAccessEnabled: false`, account-level suppression for `BOUNCE` and `COMPLAINT`, and an empty production-access `Details` object. The dedicated code pepper is absent. The confirmed runtime identity's policy is now limited to `ses:SendEmail` on the verified domain with its exact From-address condition. Readback confirms the scope; simulations allow the approved send and deny another sender, raw email and another identity. |
| Authorized registration test | One production registration request returned generic `202 Accepted`. Authorized Chrome Gmail access later found zero application messages for the test recipient. Zero registration failure events in the last-hour log query cannot establish SES acceptance because streaming started after the request. The base recipient is SES-verified, but the exact alias had no identity. Its separate AWS recipient-verification message was received at 15:02 UTC; final identity confirmation awaits operator approval. Application receipt and link use remain pending. |
| SES production-access request | The console form is prepared with Transactional, `https://kashewt.com` and English. Optional contacts are blank and terms acknowledgement is unchecked. It has not been submitted; submission awaits operator approval and AWS production-access approval remains pending. |
| Monitoring baseline | Initial local IAM discovery requests were denied; a later signed-in console and CloudShell session resolved that visibility limit. That inspection found instance and health-event log streaming disabled, no log groups under `/aws/elasticbeanstalk/Archtree-2024-env`, no metric alarms in `us-east-1`, zero SNS subscriptions, and empty EB notification-email/custom-metrics settings. |
| Log-streaming update | Complete: `StreamLogs=true`, `RetentionInDays=7`, `DeleteOnTerminate=false`; environment `Ready/Green/Ok`, application version unchanged. Seven log groups exist with seven-day retention, including stdout with real `ops_summary` events. |
| Log transformation and metric alarms | Complete: the raw platform-prefixed events matched no JSON filter. `TestTransformer` successfully parsed a real event using grok plus `parseJSON`, and that transformer was applied to stdout. All eight filters use `applyOnTransformedLogs=true` and `$.ops.*` paths. Readback found six real 60-second datapoints per metric in the latest 15-minute window. All eight alarms are `OK`, with actions enabled and the topic configured. |
| Notification setup | In progress: SNS topic `archtree-operations` exists, but no subscription or notification receipt has been verified. Working metric ingestion and `OK` alarm state do not establish operator notification delivery. |

The initial infrastructure inspection was read-only; the dated logging,
transformation, metric, alarm and topic steps above record the authorized changes.
Production rollout flags were disabled at that inspection. Complete the remaining
delivery and monitoring checks with the authorized management identity and
operator-owned test accounts; an accepted update does not establish successful
runtime or notification delivery.

### Production verification — 2026-10-12

This read-only CloudShell and public-endpoint check refreshes the production
evidence. It neither changes the historical record above nor closes email,
notification, audio-catalog or playing-room acceptance. Current CI and served
Web-byte identities remain in the
[release record](finitude-web-rollout-runbook.md#verified-release-and-served-web-bytes--checked-2026-10-12).

| Check | Observed evidence and limit |
| --- | --- |
| Environment and registered source bundle | `Archtree-2024-env` (`e-qeb3ekat4i`) is `Ready/Green/Ok`, running version `code-pipeline-1791749817909-ArchtreeBuildArtifacts-b9ef073e-49dc-4b87-b05a-cc178f823cce`. That application's registered SourceBundle contains `RELEASE.json` with `commitSha=2c1cf6e37e9ea95bf13b8218a153f3e3aa5b45cc` and `buildId=github-38170519764-1`. This binds the registered version to its source bundle; it is not a direct read of the running instance's file. |
| Public health and transport | HTTPS `/health` returned 200 with `rooms.enabled: false`; HTTP returned 308. One WebSocket upgrade probe with a synthetic ticket and foreign Origin returned `503 0`. The disabled-room handler was reached through Nginx; no real ticket, authenticated connection or enabled-room Origin behavior was exercised. |
| Current-deployment startup | Complete pagination of the 2026-10-11 19:45–20:30 UTC startup window found one `server_listening` event, one room wind-down completion and zero `optional_index_unavailable` events. These are startup observations, not a kill-switch test with a playing room. |
| Decoder deployment hook | The same fully paginated window contained one pinned-installation message and one decoder-ready message. The hook checks the saved archive-digest marker, runs the actual FFmpeg/ffprobe version checks, and requires AAC/MP3 decoders, MOV/MP3 demuxers, PCM s16le, file/pipe input and the null muxer, including a final capability check through `/usr/local/bin/ffmpeg`. It does not recalculate the installed binary's digest. This is deployment-hook evidence; no independent SSH/SSM FFmpeg command or production media analysis was performed. |
| Authentication email | SES domain and DKIM remain verified, production access remains disabled (sandbox), and `AUTH_CODE_PEPPER` is absent. Application email receipt and link use remain pending. Use the operator's dedicated test mailbox and retain no private address or one-time link in this record. |
| Alarms and notifications | All eight alarms are `OK` with actions enabled. The operations topic has zero confirmed subscriptions and zero pending subscriptions. Notification subscription, confirmation and actual receipt remain pending. |
| Remaining controlled acceptance | Dedicated pepper configuration, SES production access and application email/link acceptance, operator notification receipt, production audio analysis/backfill, two-account Rooms smoke and observation, playing-room redeployment recovery and the kill-switch rehearsal remain open. Preserve the operator's primary signed-in session throughout test-account work. |

### Configuration and notification completion — 2026-10-12

These historical authorized changes follow the read-only baseline above. The
remaining-acceptance row records the state at that stage, before the later
completion and sandbox-retention decision below. No secret, private email address,
verification URL or account payload is retained here.

| Check | Completion evidence and limit |
| --- | --- |
| Dedicated pepper | The operator personally executed the CloudShell configuration command. The initial result was `updateAccepted: true` with the environment `Updating`; subsequent environment readback was `Ready/Green/Info`, and a boolean-only option check returned `dedicatedPepperConfigured: true`. The update is complete; no pepper value was printed or recorded in this evidence. Previously issued reset codes and emailed links must be requested again. |
| Post-update runtime | HTTPS `/health` reported `status: "ok"`, `rooms.enabled: false` and `authorityState: "inactive"`. This verifies recovery from the configuration update with rooms off; it does not replace a playing-room redeployment rehearsal. |
| Dedicated SES test recipient | The exact dedicated mailbox's AWS verification page reported success, and `GetEmailIdentity` returned `VerifiedForSendingStatus: true`. This permits the authorized sandbox application test but does not prove an application email was delivered. |
| Operator notification subscription | The operator explicitly approved an ongoing email subscription and test notification. Subscription creation and confirmation succeeded; fully paginated `ListSubscriptionsByTopic` readback confirmed exactly one approved email subscription. No endpoint is retained here. |
| Notification receipt | A clearly marked `TEST ONLY` SNS publication returned HTTP 200. The dedicated test inbox received `Archtree P0 test notification`, with timestamp `2026-10-12T22:32:34.112763+00:00`; both subject and body were verified. This closes subscription and test-receipt acceptance for the operations topic. |
| Account isolation | The primary Gmail and existing Finitude sessions remained signed in. A tested Gmail plus-address variant resolved to the same application account; second-account preparation and the two-account Rooms smoke therefore remain incomplete. |
| Remaining acceptance | `ProductionAccessEnabled: false`; the production-access request remains unsubmitted pending the operator's approval of its terms. Application registration and other authentication email receipt/link checks, production audio analysis/backfill, distinct two-account Rooms observation, playing-room redeployment and kill-switch rehearsal remain open. |

### Email diagnostics and catalog inventory — 2026-10-12

These historical checks preserve the earlier baseline and completion records. They
close only identification of existing pending audio-backfill candidates; they
do not close authentication delivery, fresh media decoding or playing-room
acceptance. No private recipient, token or account payload is retained here.

| Check | Observed evidence and limit |
| --- | --- |
| Application registration | The generic 202/check-email response was followed by a failure. Complete pagination of the 22:32–22:36:59 UTC stdout window found one `email_registration_request_failed` at `2026-10-12T22:34:16.393Z`; the other three authentication failure categories and the suppression/undeliverable categories were zero. The event records no error class, and the dedicated inbox contained no application message. This establishes a failed request, not a delivery delay; the event alone cannot distinguish account lookup, token preparation or SES failure. |
| Production credential principal | CloudShell read the configured standard AWS access-key identifier only into memory and used IAM `GetAccessKeyLastUsed` to compare its `UserName`. Boolean-only output confirmed `productionAuthPrincipalChecked: true`, `matchesReviewedUser: true`, `explicitCredentialPairPresent: true`, `sessionTokenAbsent: true` and `profileAbsent: true`. The configured production credentials belong to `ArchtreeAdmin`, matching the independent SDK probe and proposed-policy user. No key or configuration value was printed. This does not establish whether the running process retains cached credentials or replace a new application send and inbox receipt check. |
| Independent SES transport | Two controlled SDK transport probes returned `AccessDenied`. Safe classification identified the exact approved test-recipient SES identity as the denied resource. At this check, the `ArchtreeAdmin` policy had only the sender-domain resource, `ses:SendEmail` and the exact From-address condition. A proposal adding only that approved recipient identity passed five simulation cases, but user approval and the permission update were pending. No successful SES acceptance or application receipt had been established. |
| Existing Audio inventory | The ordinary administrator Room audio analysis UI was read through all four pages: 94 ready/published Audio sources, comprising 72 `eligible`, 22 `unsupported`, and zero `notAnalyzed`, `retryable`, `running` or `unavailable`; no next page remained. The UI and CLI dry run share `listRoomAudioAnalysis`. Thus no pending source requires backfill apply in this inventory. No CLI, S3 HEAD/GET or Analyze action ran, so this is a complete status inventory, not evidence that all media was decoded again. |
| Remaining acceptance | Resolve and verify the approved-recipient permission, then verify application email receipt and usable links; SES production access still requires its separately approved request and AWS approval. Fresh-media production decode, distinct two-account Rooms smoke and observation, playing-room redeployment and kill-switch rehearsal remain open. The operator has approved three synthetic audio uploads, but no upload or decoder outcome is recorded yet. |

### Email permission and T1 completion — 2026-10-12

This later operator-approved repair and retest supersede the unresolved email
permission status above while preserving those earlier failures. Only the
specific completed gates below are closed.

| Check | Completion evidence and limit |
| --- | --- |
| Approved permission repair | The operator authorized the prepared exact-recipient update. The guarded apply repeated all five simulation cases successfully, `put_user_policy` returned HTTP 200, and strict readback matched the approved policy (`approvedPolicyApplied: true`). The addition is limited to the approved test-recipient SES identity; no private address or policy resource containing that address is retained here. |
| Independent transport receipt | The SDK probe returned `apiSuccess: true`. The dedicated inbox received and opened `TEST ONLY - Archtree SES transport diagnostic` from `no-reply@kashewt.com`; its fixed test body contains no authentication token or account data. This verifies that transport test only. |
| Application T1 creation and single use | `Finish creating your Finitude account` arrived at 22:54 UTC. The actual link was checked only in memory against `https://kashewt.com/finitude/register/complete`, with its token in the fragment, and initial inspection opened the setup form. The operator completed registration and login; Account showed email verified. Replay of the consumed T1 link within its 30-minute lifetime was invalid. No private address, credentials or token is retained here. |
| T2 and reset-code receipt | The already-registered notice was received with correct, token-free production login and password-reset links. A password-reset email containing a six-digit code was also received. No password reset was performed, so reset completion and session-revocation acceptance remain open; no code is retained here. |
| Post-repair logs | The fully paginated 22:52–22:56:36.551 UTC CloudWatch window reported `complete: true` and zero events for all six allowlisted authentication error, suppression and undeliverable categories. This complements the observed T1 receipt; it does not prove untested email flows. |
| New-media and canonical transport | The first synthetic MP3 create attempt had redirected to login without a confirmed outcome. The original Chrome session then recovered through Finitude's normal refresh, and all three authorized synthetic QA tracks were created and publicly ready. The final fourth analysis page showed all three as Ready for rooms. Each canonical source passed HEAD plus two ranges compared with its original bytes. The M4A probe initially failed its strict MIME check; that result is retained, and an explicit supplemental check for the actual stored `audio/x-m4a` type passed. These results close fresh-media eligibility and transport for these three fixtures, not browser room playback. |
| Ordinary Web playback | With both rollout flags off, the isolated QA account played each of the three approved tracks once through its Search action and single-track queue. Each had exactly one DOM media element with the correct query-free canonical source, 120-second duration, no media error, `readyState: 4`, and advancing time while playing. After Pause, Home plus five Page Up keys sought to 60 seconds while remaining paused with a stable clock; explicit Play resumed time advancement. The VBR source briefly reached `readyState: 1` during seek and recovered to `4` before explicit resume. Next was disabled as expected for a single-track queue, so queue Next was not tested. The QA player finished paused. This closes only these ordinary playback checks, not full Listener, pinned-player, Rooms/synchronization, physical-device or audible-output acceptance. |
| Read-only storage audit | At 23:30:45 UTC, the normal Operations link opened `/admin/audio-storage/reconciliation`. The complete Audio report showed 104 track records, 98 current S3 objects, zero orphans, six historical missing-file records and zero incomplete audio lifecycles; none of the three known QA IDs appeared in issue findings. The separate Video finding is one legacy active/ready lifecycle with its S3 object present, not a new QA issue or a missing/failed operation. No remediation or deletion was invoked, and all six historical records remain; metadata cannot reconstruct their absent media. The service uses `ListObjectsV2` for current keys and `HeadObject` only for orphan metadata, not `ListObjectVersions`. This does not verify QA replacement/deletion or noncurrent-version cleanup. |
| Current controlled-test boundary | The original Chrome account and the distinct registered, verified in-app-browser QA account are signed in separately. The guarded environment inspection is `Ready/Green` on the original version, with its registered source bundle available; both rollout flags are unset and therefore false, and no rehearsal version exists. No Rooms enablement or rehearsal has run. Separate approval for the controlled window remains pending; the SES sandbox decision does not authorize it. |
| Remaining acceptance | T3/legacy verification and password-reset completion/session revocation remain open. The operator has chosen to retain the SES sandbox and intentionally defer its production-access request; the unsubmitted form was cancelled and the console returned to sandbox setup. Exact verified-recipient test evidence remains valid, but ordinary-listener email delivery is not ready. Controlled two-account Rooms smoke and observation, playing-room same-bundle redeployment/restoration and the kill-switch rehearsal remain open. |
