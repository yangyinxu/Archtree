# Archtree Deployment TODOs

This file tracks infrastructure work that is intentionally deferred and cannot
be completed solely through application code.

## Production HTTPS for Authentication

Status: Recovery is prepared on `develop` following the 2026-08-02 production
deployment, after which the healthy single instance was observed serving HTTP
without a port 443 listener. Redeployment and HTTPS re-verification remain
pending.

Current state:

- Route 53 resolves the production domain to the healthy single-instance
  Elastic Beanstalk environment; public HTTP and `/health` both returned `200`
  during the 2026-08-05 incident check.
- Nginx is serving the ACME HTTP-01 challenge location, which is consistent
  with the hook's missing-certificate challenge configuration, while port 443
  refuses connections until issuance succeeds.
- The recovery candidate starts missing-certificate retry after a five-minute
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
- [ ] Deploy the HTTPS recovery candidate and confirm the bootstrap retry and
      twice-daily renewal timers are active.
- [ ] Reconfirm Let's Encrypt issuance, port 443, and the HTTP-to-HTTPS redirect.
- [x] Verify `TRUST_PROXY_HOPS` against the deployed proxy chain.
- [x] Change the iOS Release `ARCHTREE_AUTH_BASE_URL` to the production
      `https://` domain.
- [x] Verify password login over HTTPS from a signed physical-device build.
- [ ] Verify refresh rotation, logout, and logout-all over HTTPS from a signed
      physical-device build. `/auth/me` has been verified.
- [ ] Verify the SES sender/domain, grant the runtime only `ses:SendEmail`, and
      configure `AUTH_EMAIL_FROM` plus an `AUTH_CODE_PEPPER`.
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
