import assert from 'node:assert/strict';
import test from 'node:test';
import { isReservedSocialAlias, isReservedSocialHandle } from '../src/application/social/socialNamePolicy';
import { normalizeSocialHandle, parseSocialCommand } from '../src/contracts/socialV1';

/** The policy receives handles after the contract parser has lower-cased them. */
const reservedHandle = (value: string) => {
    const handle = normalizeSocialHandle(value);
    assert.ok(handle, `${value} must be a syntactically valid handle`);
    return isReservedSocialHandle(handle);
};

test('system, staff and brand handles are reserved regardless of case', () => {
    for (const value of ['admin', 'ADMIN', 'Administrator', 'root', 'support', 'help', 'finitude', 'Archtree',
        'kashewt', 'system', 'moderator', 'mod', 'official', 'security', 'staff', 'null', 'undefined', 'api', 'www',
        'mail', 'no_reply', 'noreply', 'postmaster', 'webmaster', 'abuse', 'sysadmin', 'helpdesk']) {
        assert.equal(reservedHandle(value), true, value);
    }
});

test('look-alike spellings, separators and trailing numbers do not make a reserved handle distinct', () => {
    for (const value of ['adm1n', 'a_d_m_i_n', 'admin_', 'supp0rt', 'r00t', 'adrnin', 'he1p', 'mai1', 'n0_reply',
        'w_w_w', 'admin2024', 's74ff', 'm0derat0r', 'sys7em', 'secur1ty', 'offic1al']) {
        assert.equal(reservedHandle(value), true, value);
    }
});

test('staff roles are reserved as handle parts and brand names anywhere in a handle', () => {
    for (const value of ['support_team', 'the_admin', 'staff_alice', 'official_news', 'mod_squad', 'admin1_bob',
        'finitude_fan', 'myfinitude', 'f1n1tude_music', 'archtree_dev', 'kashewt_official', 'teamarchtree']) {
        assert.equal(reservedHandle(value), true, value);
    }
});

test('ordinary handles stay available, including words that only contain a reserved term', () => {
    for (const value of ['alice', 'alice_123', 'bobby', 'shared', 'newcomer', 'invitation_host', 'listener_one',
        'media_fixture', 'badminton', 'administrative', 'helper', 'rooted', 'rot', 'mall', 'mai', 'apl', 'modern',
        'systematic', 'supporter_fan', 'nullable', 'u_0123456789abcdef0123', `u${'f'.repeat(20)}`]) {
        assert.equal(reservedHandle(value), false, value);
    }
});

test('display names cannot use staff roles as whole words or contain a brand name', () => {
    for (const value of ['Admin', 'Finitude Support', 'Official', 'The Moderator', 'Staff', 'Security Team',
        'System', 'Mod', 'support', 'SupportBot', 'Bob (admin)', 'admin_bob', 'Adm1n', 'ADMlN', 'Admin2024',
        'A D M I N', 'a.d.m.i.n', 'FinitudeFan', 'Team Finitude', 'archtree', 'Kashewt Crew', 'Helpdesk']) {
        assert.equal(isReservedSocialAlias(value), true, value);
    }
});

test('display-name checks fold Unicode compatibility forms, accents and Cyrillic or Greek look-alikes', () => {
    for (const value of ['ＡＤＭＩＮ', '𝐀𝐝𝐦𝐢𝐧', 'Ádmin', 'Ａｄｍｉｎ', '\u0410dmin', 'Sup\u0440ort', 'FINI\u0422UDE',
        '\u039Cod', 'Adm\u0456n']) {
        assert.equal(isReservedSocialAlias(value), true, JSON.stringify(value));
    }
});

test('Chinese staff terms are rejected anywhere in a display name', () => {
    for (const value of ['管理员', 'Finitude官方', '官方账号', '客服小王', '版主', '工作人员', '管理員', '工作人員']) {
        assert.equal(isReservedSocialAlias(value), true, value);
    }
});

test('ordinary display names stay available, including technical words reserved only as handles', () => {
    for (const value of ['Alice', 'Alias alice', 'Listener One', 'Invitation host', 'Soak Listener 1', 'Café',
        'Badminton Club', 'Administrative Assistant', 'Modern Love', 'Systematic', 'Supporter', 'Help', 'Root',
        'Null', 'Mail', 'I am a fan', 'Bob', '明'.repeat(50), '😀'.repeat(50), '🎵', '小明', 'Μαρία', 'Олег']) {
        assert.equal(isReservedSocialAlias(value), false, value);
    }
});

test('the contract parser still accepts reserved names because grandfathered profiles must keep saving', () => {
    const command = parseSocialCommand({ scopeToken: 'synthetic-signed-scope-token', commandId: 'synthetic-command-01',
        action: 'profile', expectedRevision: 1, handle: 'Support', alias: 'Official Support', discoverable: true });
    assert.ok(command && command.action === 'profile');
    assert.equal(command.handle, 'support');
});
