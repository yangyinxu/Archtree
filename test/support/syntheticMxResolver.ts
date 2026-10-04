import { setEmailDomainResolver, type MxResolver } from '../../src/services/emailDomainDeliverability';

/**
 * Preloaded into every server test process by `scripts/lib/server-test-arguments.mjs`,
 * so no test queries real DNS before an authentication email. Every domain
 * answers with one synthetic mail host, which keeps existing email assertions
 * deliverable. A test that needs another answer installs its own resolver with
 * `setEmailDomainResolver` and restores the previous one afterwards.
 */
export const syntheticMxResolver: MxResolver = async domain => [{ exchange: `mx.${domain}`, priority: 10 }];

setEmailDomainResolver(syntheticMxResolver);
