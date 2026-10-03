import assert from 'node:assert/strict';
import test from 'node:test';
import {
    earlierWorkWaitLimitMs,
    queueVerificationDelivery,
    queueVerificationResend
} from '../src/services/verificationDeliveryQueue';

/** Synthetic work whose completion each test controls; nothing here sends email. */
const controlledWork = (outcome: 'sent' | 'skipped' | 'failed') => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const events: string[] = [];
    const work = async () => {
        events.push('started');
        await gate;
        events.push('finished');
        if (outcome === 'failed') throw new Error('synthetic delivery failure');
        return outcome === 'sent';
    };
    return { work, release, events };
};

const flush = () => new Promise(resolve => setImmediate(resolve));

test('work for one address runs in order while other addresses proceed', async () => {
    const first = controlledWork('sent');
    const second = controlledWork('sent');
    const other = controlledWork('sent');
    const firstResult = queueVerificationDelivery('lorem@example.test', first.work);
    const secondResult = queueVerificationDelivery('lorem@example.test', second.work);
    const otherResult = queueVerificationDelivery('ipsum@example.test', other.work);
    await flush();
    assert.deepEqual(first.events, ['started']);
    assert.deepEqual(second.events, [], 'the same address waits for earlier work');
    assert.deepEqual(other.events, ['started'], 'another address is not blocked');

    first.release();
    assert.equal(await firstResult, true);
    await flush();
    assert.deepEqual(second.events, ['started']);
    second.release(); other.release();
    assert.deepEqual(await Promise.all([secondResult, otherResult]), [true, true]);
});

test('earlier failures do not block later work for the address', async () => {
    const failing = controlledWork('failed');
    const later = controlledWork('sent');
    const failed = queueVerificationDelivery('dolor@example.test', failing.work);
    const laterResult = queueVerificationDelivery('dolor@example.test', later.work);
    failing.release(); later.release();
    await assert.rejects(failed, /synthetic delivery failure/);
    assert.equal(await laterResult, true);
});

test('a resend coalesces into an in-flight delivery that succeeds', async () => {
    const registration = controlledWork('sent');
    const resend = controlledWork('sent');
    const delivery = queueVerificationDelivery('sit@example.test', registration.work);
    const resent = queueVerificationResend('sit@example.test', resend.work);
    registration.release();
    assert.equal(await delivery, true);
    assert.equal(await resent, true);
    assert.deepEqual(resend.events, [], 'the delivered code already answers the resend');
});

for (const outcome of ['failed', 'skipped'] as const) {
    test(`a resend sends its own code after an in-flight delivery is ${outcome}`, async () => {
        const address = `amet-${outcome}@example.test`;
        const registration = controlledWork(outcome);
        const resend = controlledWork('sent');
        const delivery = queueVerificationDelivery(address, registration.work).catch(() => false);
        const resent = queueVerificationResend(address, resend.work);
        await flush();
        assert.deepEqual(resend.events, [], 'the resend waits for the in-flight delivery');
        registration.release();
        assert.equal(await delivery, false);
        await flush();
        assert.deepEqual(resend.events, ['started']);
        resend.release();
        assert.equal(await resent, true);
    });
}

test('a resend with nothing in flight runs immediately, and settled deliveries are not reused', async () => {
    const earlier = controlledWork('sent');
    earlier.release();
    assert.equal(await queueVerificationDelivery('consectetur@example.test', earlier.work), true);
    await flush();
    const resend = controlledWork('sent');
    const resent = queueVerificationResend('consectetur@example.test', resend.work);
    await flush();
    assert.deepEqual(resend.events, ['started'], 'a finished delivery does not satisfy a later resend');
    resend.release();
    assert.equal(await resent, true);
});

test('a stuck delivery delays later work for its address only up to the wait limit', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stuck = controlledWork('sent');
    const registration = controlledWork('sent');
    const resend = controlledWork('sent');
    void queueVerificationDelivery('adipiscing@example.test', stuck.work);
    const registered = queueVerificationDelivery('adipiscing@example.test', registration.work);
    const resent = queueVerificationResend('adipiscing@example.test', resend.work);
    await flush();
    assert.deepEqual(registration.events, []);
    assert.deepEqual(resend.events, []);

    t.mock.timers.tick(earlierWorkWaitLimitMs);
    await flush();
    assert.deepEqual(registration.events, ['started'], 'the registration stops waiting for the stuck send');
    registration.release();
    assert.equal(await registered, true);
    // The resend also stopped waiting to coalesce, so it sends its own code after the registration.
    await flush();
    assert.deepEqual(resend.events, ['started']);
    resend.release();
    assert.equal(await resent, true);
    stuck.release();
});
