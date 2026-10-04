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

## Signals

- `GET /health` is unauthenticated. Its `rooms` object reports `enabled` (both
  flags), `authorityState`, `lastSuccessfulSweepAgeMs` and fixed failure counters.
  `authorityState` is `ready` while rooms are enabled, `windingDown` while a
  process started with rooms off is ending rooms left open, `unavailable` after a
  lease or database failure, and `inactive` when nothing holds the room authority.
- The application log (`/var/log/web.stdout.log`, included in `eb logs`) contains
  `{"category":"server_listening",...}` after each restart. A process started with
  rooms off adds `{"category":"room_wind_down","state":"started"}` when it finds an
  open room and `{"category":"room_wind_down","state":"complete"}` once none
  remains (immediately when there was none).
- The WebSocket probe in the Finitude Web runbook answers `403 0` when rooms are
  enabled and the proxy forwards upgrades, and `503 0` when rooms are off.

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
5. Watch `/health` failure counters and environment health for the observation
   window. Stop and use the kill switch on any private-data exposure, sustained
   server errors, rising room failure counters or a stop condition.

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
- The log shows `room_wind_down` `complete` after the latest `server_listening`.
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
| Enablement | `/health` rooms snapshot, probe result, smoke-test result |
| Kill switch rehearsal | Restart time, time to pause, time to `inactive`, probe result, social reads with rooms off |
| Re-enable | `/health` rooms snapshot and probe result |
| Exceptions | Accepted difference, owner, expiry/follow-up |

Before the first public enablement, rehearse the kill switch once with the
test accounts: start room playback, switch rooms off, confirm the pause and
the end within about six minutes, confirm social reads still work, then switch
rooms back on.
