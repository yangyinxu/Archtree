import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    exactSocialKeys, isSocialId, isSocialRevision, normalizeSocialHandle, parseSocialCommand
} from '../src/contracts/socialV1';

const identity = { scopeToken: 'synthetic-signed-scope-token', commandId: 'synthetic-command-01' };
const socialId = `s_${'a'.repeat(32)}`;
const fixture = JSON.parse(readFileSync(new URL('../contracts/social/v1/identity-and-relationships.json', import.meta.url), 'utf8'));
const profile = fixture.profileWrite;

test('social profile parser normalizes chosen identity and freezes the captured intent', () => {
    const parsed = parseSocialCommand(profile);
    assert.deepEqual(parsed, fixture.normalizedProfileWrite);
    assert.ok(Object.isFrozen(parsed));
    assert.equal(profile.alias, '  Cafe\u0301  ');
    assert.ok(parseSocialCommand({ ...profile, alias: '明'.repeat(50) }));
    assert.ok(parseSocialCommand({ ...profile, alias: '😀'.repeat(50) }));
});

test('social identity is distinct from accounts and accepts only bounded exact handles', () => {
    assert.equal(isSocialId(socialId), true);
    for (const value of ['a'.repeat(24), `s_${'A'.repeat(32)}`, {}, null, `${socialId} `]) {
        assert.equal(isSocialId(value), false);
    }
    assert.equal(normalizeSocialHandle('ALICE_123'), 'alice_123');
    for (const value of ['ab', ' alice', 'alice ', 'a@b', '1alice', 'école', 'a'.repeat(25), {}, null]) {
        assert.equal(normalizeSocialHandle(value), null);
    }
});

test('social commands require safe integer revisions without coercion', () => {
    assert.equal(isSocialRevision(0), true);
    assert.equal(isSocialRevision(Number.MAX_SAFE_INTEGER), true);
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null, true]) {
        assert.equal(isSocialRevision(value), false);
        assert.equal(parseSocialCommand({ ...profile, expectedRevision: value }), null);
    }
});

test('social alias validation rejects hidden controls, empty text and excessive length', () => {
    for (const alias of ['', '   ', 'a\u0000b', 'a\u007fb', 'a\u202eb', 'a\u200bb', '明'.repeat(51), '😀'.repeat(51), true]) {
        assert.equal(parseSocialCommand({ ...profile, alias }), null);
    }
});

test('every relationship action preserves exact target and revision requirements', () => {
    assert.equal(fixture.fixtureVersion, 1);
    for (const command of fixture.relationshipWrites) {
        const { action } = command;
        assert.deepEqual(parseSocialCommand(command), command);
        assert.equal(parseSocialCommand({ ...identity, action, targetSocialId: socialId }), null);
        assert.equal(parseSocialCommand({ ...command, accountId: 'private-account' }), null);
    }
    assert.deepEqual(parseSocialCommand({ ...identity, action: 'block', targetSocialId: socialId }),
        { ...identity, action: 'block', targetSocialId: socialId });
    assert.equal(parseSocialCommand({ ...identity, action: 'block', targetSocialId: socialId, expectedRevision: 1 }), null);
    assert.deepEqual(parseSocialCommand({ ...identity, action: 'deactivate' }), { ...identity, action: 'deactivate' });
    assert.equal(parseSocialCommand({ ...identity, action: 'deactivate', targetSocialId: socialId }), null);
});

test('social parser rejects missing, unknown and malformed identity fields', () => {
    for (const input of [null, [], 1, 'profile', { ...profile, action: 'future' },
        { ...profile, commandId: 'short' }, { ...profile, commandId: 'x'.repeat(81) },
        { ...profile, commandId: 'contains space and invalid' }, { ...profile, scopeToken: 'short' },
        { ...profile, scopeToken: 'x'.repeat(1_025) }, { ...profile, discoverable: 'false' },
        { ...profile, role: 'admin' }, { ...profile, handle: null }, Object.create(profile)]) {
        assert.equal(parseSocialCommand(input), null);
    }
    const missing = { ...profile } as Record<string, unknown>;
    delete missing.discoverable;
    assert.equal(parseSocialCommand(missing), null);
    assert.equal(exactSocialKeys({ a: 1 }, ['a', 'b']), false);
    assert.equal(exactSocialKeys(Object.create({ a: 1 }), ['a']), false);
    assert.equal(exactSocialKeys(JSON.parse('{"__proto__":{"role":"admin"}}'), []), false);
});
