import type { MxResolver } from '../../../src/services/emailDomainDeliverability';

/**
 * Browser tests never query DNS. A domain under the reserved `.invalid`
 * top-level domain (RFC 2606) stands for one that cannot receive mail; every
 * other domain counts as deliverable. The browser-test server's resolver and
 * the fake account routes share this one rule.
 */
export const isUndeliverableTestDomain = (domain: string) => {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, '');
  return normalized === 'invalid' || normalized.endsWith('.invalid');
};

/** Answers like an MX lookup without DNS: NXDOMAIN for `.invalid`, one synthetic mail host otherwise. */
export const browserTestMxResolver: MxResolver = async (domain) => {
  if (isUndeliverableTestDomain(domain)) {
    throw Object.assign(new Error('Synthetic NXDOMAIN.'), { code: 'ENOTFOUND' });
  }
  return [{ exchange: `mx.${domain}`, priority: 10 }];
};
