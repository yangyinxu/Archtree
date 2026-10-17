import assert from 'node:assert/strict';
import test from 'node:test';
import { describeDeclaredSessionDevice, describeSessionDevice } from '../../src/services/account/deviceSessionService';

test('explicit app categories distinguish Android and preserve older iOS clients', () => {
    for (const [category, deviceName, deviceType] of [
        ['phone', 'iPhone', 'phone'],
        ['tablet', 'iPad', 'tablet'],
        ['android-phone', 'Android phone', 'phone'],
        ['ANDROID-TABLET', 'Android tablet', 'tablet'],
    ]) {
        assert.deepEqual(describeDeclaredSessionDevice(category), { deviceName, deviceType });
    }
    for (const category of [undefined, '', 'My private device', 'phone\nother', 'phone '.repeat(100)]) {
        assert.equal(describeDeclaredSessionDevice(category), undefined);
    }
});

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
