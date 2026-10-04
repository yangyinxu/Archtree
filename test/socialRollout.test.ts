import assert from 'node:assert/strict';
import test from 'node:test';

import { socialRollout } from '../src/config/socialRollout';

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
