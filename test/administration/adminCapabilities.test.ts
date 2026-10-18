import assert from 'node:assert/strict';
import test from 'node:test';
import { getAdminCapabilities } from '../../src/administration/adminCapabilityService';

test('catalog editing and visibility need only the admin role; imports default off and never expose provider configuration', () => {
    const names = ['FINITUDE_ADMIN_IMPORTS_ENABLED', 'FINITUDE_ADMIN_CATALOG_ENABLED',
        'FINITUDE_ADMIN_VISIBILITY_ENABLED', 'FINITUDE_HIDDEN_DELIVERY_ENFORCED', 'OPENAI_API_KEY'] as const;
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    try {
        for (const name of names) delete process.env[name];
        assert.deepEqual(getAdminCapabilities(), {
            schemaVersion: 1, admin: true,
            albumImports: { enabled: false, analysisAvailable: false, model: 'gpt-6-luna', maxFiles: 100 },
            catalog: { editing: true, visibility: true },
            localMp3Conversion: { enabled: true, readSources: true, replace: true, preset: 'mp3-320', maxFiles: 100 }
        });
        process.env.FINITUDE_ADMIN_IMPORTS_ENABLED = 'true';
        process.env.OPENAI_API_KEY = 'fixture-provider-value';
        // Leftover closed rollout values from earlier deployments no longer restrict administrators.
        process.env.FINITUDE_ADMIN_CATALOG_ENABLED = 'false';
        process.env.FINITUDE_ADMIN_VISIBILITY_ENABLED = 'false';
        process.env.FINITUDE_HIDDEN_DELIVERY_ENFORCED = 'false';
        assert.equal(getAdminCapabilities().albumImports.analysisAvailable, true);
        assert.deepEqual(getAdminCapabilities().catalog, { editing: true, visibility: true });
        assert.equal(JSON.stringify(getAdminCapabilities()).includes('fixture-provider-value'), false);
    } finally {
        for (const name of names) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    }
});
