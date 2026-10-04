import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoomUpgradeContext, createRoomUpgradeRateLimit } from '../src/realtime/roomUpgradeProtection';

test('WebSocket address and TLS resolution follows the same bounded Express proxy-hop policy', () => {
    const previous = process.env.TRUST_PROXY_HOPS;
    try {
        for (const [hops, ip, secure] of [['0', '10.0.0.1', false], ['1', '192.0.2.2', true], ['2', '198.51.100.3', true]] as const) {
            process.env.TRUST_PROXY_HOPS = hops;
            const resolve = createRoomUpgradeContext();
            assert.deepEqual(resolve({ socket: { remoteAddress: '10.0.0.1' },
                headers: { 'x-forwarded-for': '198.51.100.3, 192.0.2.2', 'x-forwarded-proto': 'https, http' } } as any), { ip, secure });
        }
    } finally { if (previous === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = previous; }
});

test('upgrade rate buckets have a hard cardinality bound and recover only after expiration', () => {
    const admit = createRoomUpgradeRateLimit();
    for (let i = 0; i < 1024; i += 1) assert.equal(admit(`2001:db8::${i}`, 1000), true);
    assert.equal(admit('new-source', 1000), false);
    for (let i = 1; i < 60; i += 1) assert.equal(admit('2001:db8::0', 1000), true);
    assert.equal(admit('2001:db8::0', 1000), false);
    assert.equal(admit('new-source', 61_001), true);
});
