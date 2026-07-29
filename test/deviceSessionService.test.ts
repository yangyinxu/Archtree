import assert from 'node:assert/strict';
import test from 'node:test';
import { describeSessionDevice } from '../src/services/deviceSessionService';

test('describes Finitude app sessions without exposing networking versions', () => {
    assert.deepEqual(
        describeSessionDevice('Finitude_iOS/1 CFNetwork/3860.300.31 Darwin/25.5.0'),
        { deviceName: 'iPhone or iPad', deviceType: 'mobile' }
    );
});

test('describes common browsers using familiar platform names', () => {
    assert.deepEqual(
        describeSessionDevice(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
            + 'AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
        ),
        { deviceName: 'Chrome on Mac', deviceType: 'computer' }
    );
    assert.deepEqual(
        describeSessionDevice(
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) '
            + 'AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
        ),
        { deviceName: 'Safari on iPhone', deviceType: 'phone' }
    );
});

test('unknown session metadata fails closed to a generic label', () => {
    assert.deepEqual(
        describeSessionDevice('an-internal-client-build/12345'),
        { deviceName: 'Unknown device', deviceType: 'unknown' }
    );
});
