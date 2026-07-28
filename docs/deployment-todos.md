# Archtree Deployment TODOs

This file tracks infrastructure work that is intentionally deferred and cannot
be completed solely through application code.

## Production HTTPS for Authentication

Status: Deferred. Blocks production activation of Phase 0 authentication, but
does not block continued local development or later feature implementation.

Current state:

- The Elastic Beanstalk endpoint responds over HTTP.
- Port 443 does not currently provide HTTPS.
- The iOS Release configuration still identifies the HTTP endpoint, and the
  authentication client refuses to send credentials or tokens to it.
- Production Archtree authentication rejects requests that are not identified
  as HTTPS after trusted-proxy resolution.

Required before production authentication is enabled:

- [ ] Choose a production API domain owned by the project.
- [ ] Issue and validate an AWS ACM certificate in the load balancer's region.
- [ ] Configure an HTTPS listener on port 443 and attach the certificate.
- [ ] Forward HTTPS traffic from the load balancer to Archtree's internal HTTP
      port.
- [ ] Allow port 443 through the applicable load-balancer security group.
- [ ] Point production DNS to the Elastic Beanstalk environment or load
      balancer.
- [ ] Redirect public port 80 traffic to HTTPS where appropriate.
- [ ] Verify `TRUST_PROXY_HOPS` against the deployed proxy chain.
- [ ] Change the iOS Release `ARCHTREE_AUTH_BASE_URL` to the production
      `https://` domain.
- [ ] Deploy Archtree and verify login, refresh rotation, `/auth/me`, logout,
      and logout-all over HTTPS.
- [ ] Verify the SES sender/domain, grant the runtime only `ses:SendEmail`, and
      configure `AUTH_EMAIL_FROM` plus an `AUTH_CODE_PEPPER`.
- [ ] Configure the iOS Associated Domains entitlement after the production
      authentication domain exists.
- [ ] If legacy-token compatibility is temporarily enabled for rollout, remove
      `ALLOW_LEGACY_AUTH_TOKENS=true` after the migration window.

Safety constraints while deferred:

- Do not weaken the iOS secure-authentication URL check or ATS policy.
- Do not remove Archtree's production secure-transport middleware.
- Do not ship production authentication against the current HTTP endpoint.

Completion evidence:

- HTTPS responds successfully with a trusted certificate.
- HTTP authentication is rejected or redirected without processing credentials.
- A Release iOS build completes the full authentication lifecycle over HTTPS.
