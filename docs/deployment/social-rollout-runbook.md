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

Every line is one JSON object with a `category`. They contain fixed labels, counts
and at most an opaque room ID. They never contain an account, session, address,
handle, token or error text.

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

Stream the application log to CloudWatch Logs first (console: **Configuration →
Updates, monitoring, and logging → Instance log streaming**, or option
`aws:elasticbeanstalk:cloudwatch:logs` `StreamLogs=true`, with a short retention
such as seven days). The log group is
`/aws/elasticbeanstalk/<environment>/var/log/web.stdout.log`. One summary a minute
is about 45 MB a month; streaming also sends the platform's other logs, so check
ingestion against the 5 GB free allowance. The suggested set below uses eight
custom metrics and eight alarms, which fits the CloudWatch free tier's ten of each
when nothing else uses them.

Create a metric from a JSON field, for example open sockets:

```bash
aws logs put-metric-filter --log-group-name /aws/elasticbeanstalk/<environment>/var/log/web.stdout.log \
  --filter-name archtree-open-sockets --filter-pattern '{ $.category = "ops_summary" }' \
  --metric-transformations metricName=OpenSockets,metricNamespace=Archtree/Social,metricValue='$.rooms.openSockets'
aws cloudwatch put-metric-alarm --alarm-name archtree-open-sockets-near-cap \
  --namespace Archtree/Social --metric-name OpenSockets --statistic Maximum --period 300 \
  --evaluation-periods 3 --threshold 8 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching --alarm-actions <sns-topic-arn>
```

| Metric (filter pattern; value) | Alarm |
| --- | --- |
| `OpsSummary` (`{ $.category = "ops_summary" }`; `1`) | Sum below 3 over 5 minutes, missing data breaching: the process stopped or hung |
| `OpenSockets` (summary; `$.rooms.openSockets`) | Maximum at least 80% of `FINITUDE_REALTIME_MAX_SOCKETS` for 15 minutes |
| `CapacityRejections` (summary; `$.rooms.capacityRejectionsTotal`) | Sum above 0 in 15 minutes: listeners are being refused; review the limits |
| `RoomFailures` (summary; `$.rooms.failuresTotal`) | Sum above 5 for three consecutive 5-minute periods |
| `AuthorityChanges` (summary; `$.rooms.authorityChanges`) | Sum above 4 in 15 minutes: the authority is flapping |
| `FanoutLagMax` (summary; `$.rooms.fanoutLagMaxMs`) | Maximum above 2000 for three of five minutes |
| `TicketUnavailable` (summary; `$.rooms.ticketFailures.unavailable`) | Sum above 0 for two consecutive 5-minute periods |
| `Limited` (summary; `$.limiters.total`) | Sum above 200 in 5 minutes: sustained throttling or abuse |

Investigate a specific limiter, code or room with CloudWatch Logs Insights, for
example `filter category = "ops_summary" | fields @timestamp, limiters.byScope`.
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
   listener's account or data for smoke tests.
4. Optionally rehearse locally with `npm run build` and `npm run demo:social`,
   which uses its own MongoDB and fixtures.

## 2. Enable for testing

1. Pick a quiet window and record the start time, owner and stop conditions.
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
| Flags | Values before and after each change, time and owner |
| Enablement | `/health` rooms snapshot, probe result, smoke-test result, `social_capacity_config` line |
| Kill switch rehearsal | Restart time, time to pause, time to `inactive`, probe result, social reads with rooms off |
| Re-enable | `/health` rooms snapshot and probe result |
| Exceptions | Accepted difference, owner, expiry/follow-up |

Before the first public enablement, rehearse the kill switch once with the
test accounts: start room playback, switch rooms off, confirm the pause and
the end within about six minutes, confirm social reads still work, then switch
rooms back on.
