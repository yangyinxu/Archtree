import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';

import {
    assertAvatarMutationViewer,
    assertAvatarReadIdentity
} from '../src/controllers/avatarController';

const avatarRequest = (headers: Record<string, string> = {}) => ({
    get: (name: string) => headers[name.toLowerCase()]
}) as Request;

const statusOf = (error: unknown) => Number((error as { statusCode?: number }).statusCode);

test('avatar reads accept native clients and the matching Web account projection', () => {
    const user = { avatarRevision: 4 };
    assert.doesNotThrow(() => assertAvatarReadIdentity(avatarRequest(), 'listener-1', user));
    assert.doesNotThrow(() => assertAvatarReadIdentity(avatarRequest({
        'x-finitude-avatar-viewer': 'listener-1',
        'x-finitude-avatar-revision': '4'
    }), 'listener-1', user));
});

test('avatar reads reject stale viewers and revisions before streaming private bytes', () => {
    assert.throws(
        () => assertAvatarReadIdentity(avatarRequest({
            'x-finitude-avatar-viewer': 'listener-2',
            'x-finitude-avatar-revision': '4'
        }), 'listener-1', { avatarRevision: 4 }),
        (error) => statusOf(error) === 409
    );
    assert.throws(
        () => assertAvatarReadIdentity(avatarRequest({
            'x-finitude-avatar-viewer': 'listener-1',
            'x-finitude-avatar-revision': '3'
        }), 'listener-1', { avatarRevision: 4 }),
        (error) => statusOf(error) === 409
    );
    assert.throws(
        () => assertAvatarReadIdentity(avatarRequest({
            'x-finitude-avatar-revision': 'not-a-revision'
        }), 'listener-1', { avatarRevision: 4 }),
        (error) => statusOf(error) === 400
    );
});

test('avatar mutations reject a stale Web viewer while retaining native compatibility', () => {
    assert.doesNotThrow(() => assertAvatarMutationViewer(avatarRequest(), 'listener-1'));
    assert.doesNotThrow(() => assertAvatarMutationViewer(avatarRequest({
        'x-finitude-avatar-viewer': 'listener-1'
    }), 'listener-1'));
    assert.throws(
        () => assertAvatarMutationViewer(avatarRequest({
            'x-finitude-avatar-viewer': 'listener-2'
        }), 'listener-1'),
        (error) => statusOf(error) === 409
    );
});
