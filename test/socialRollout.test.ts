import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { socialRollout } from '../src/config/socialRollout';
import { createRoomGatewayMetrics } from '../src/realtime/roomGatewayMetrics';

test('social rollout defaults off and never reports rooms without social', () => {
    assert.deepEqual(socialRollout({}), { socialEnabled: false, roomsEnabled: false });
    assert.deepEqual(socialRollout({ FINITUDE_ROOMS_ENABLED: 'true' }), { socialEnabled: false, roomsEnabled: false });
    assert.deepEqual(socialRollout({ FINITUDE_SOCIAL_ENABLED: 'true' }), { socialEnabled: true, roomsEnabled: false });
    assert.deepEqual(socialRollout({ FINITUDE_SOCIAL_ENABLED: 'true', FINITUDE_ROOMS_ENABLED: 'true' }),
        { socialEnabled: true, roomsEnabled: true });
});

test('social rollout accepts only the exact opt-in value, matching the server admission checks', () => {
    for (const value of ['TRUE', ' true', '1', 'yes', '']) {
        assert.deepEqual(socialRollout({ FINITUDE_SOCIAL_ENABLED: value, FINITUDE_ROOMS_ENABLED: 'true' }),
            { socialEnabled: false, roomsEnabled: false });
        assert.deepEqual(socialRollout({ FINITUDE_SOCIAL_ENABLED: 'true', FINITUDE_ROOMS_ENABLED: value }),
            { socialEnabled: true, roomsEnabled: false });
    }
});

test('every server surface reads the rollout flags through the shared definition', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const readers = globSync('src/**/*.ts', { cwd: root })
        .filter(file => /FINITUDE_(?:SOCIAL|ROOMS)_ENABLED/.test(readFileSync(path.join(root, file), 'utf8')))
        .map(file => file.split(path.sep).join('/')).sort();
    // Listening reads only the rooms flag on purpose: its service already runs behind the social flag.
    assert.deepEqual(readers, ['src/application/social/listeningService.ts', 'src/config/socialRollout.ts']);
});

test('the default room gateway enablement follows the flags at each read, not at creation', (t) => {
    const original = { social: process.env.FINITUDE_SOCIAL_ENABLED, rooms: process.env.FINITUDE_ROOMS_ENABLED };
    t.after(() => {
        for (const [name, value] of [['FINITUDE_SOCIAL_ENABLED', original.social], ['FINITUDE_ROOMS_ENABLED', original.rooms]] as const) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    });
    process.env.FINITUDE_SOCIAL_ENABLED = 'true'; process.env.FINITUDE_ROOMS_ENABLED = 'true';
    const metrics = createRoomGatewayMetrics();
    assert.equal(metrics.snapshot().enabled, true);
    process.env.FINITUDE_SOCIAL_ENABLED = 'false';
    assert.equal(metrics.snapshot().enabled, false);
    process.env.FINITUDE_SOCIAL_ENABLED = 'true'; delete process.env.FINITUDE_ROOMS_ENABLED;
    assert.equal(metrics.snapshot().enabled, false);
});
