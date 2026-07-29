import assert from 'node:assert/strict';
import test from 'node:test';
import {
    evaluatePassword,
    requireAcceptablePassword
} from '../src/services/passwordPolicyService';

test('accepts a sufficiently long non-common password', () => {
    assert.deepEqual(evaluatePassword('correct-horse-battery-staple'), { accepted: true });
});

test('rejects passwords outside the bounded length', () => {
    assert.equal(evaluatePassword('too-short').accepted, false);
    assert.equal(evaluatePassword('x'.repeat(257)).accepted, false);
});

test('rejects common compromised passwords without a network disclosure', () => {
    assert.deepEqual(evaluatePassword('Password1234'), {
        accepted: false,
        message: 'Choose a less common password.'
    });
});

test('express validator adapter rejects the same invalid choices', () => {
    assert.throws(() => requireAcceptablePassword('qwerty123456'));
    assert.equal(requireAcceptablePassword('unique-long-password'), true);
});
