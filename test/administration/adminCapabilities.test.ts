import assert from 'node:assert/strict';
import test from 'node:test';
import { getAdminCapabilities } from '../../src/administration/adminCapabilityService';

test('catalog editing needs only the admin role; other admission defaults off and never exposes provider configuration', () => {
    const names = ['FINITUDE_ADMIN_IMPORTS_ENABLED', 'FINITUDE_ADMIN_CATALOG_ENABLED',
        'FINITUDE_ADMIN_VISIBILITY_ENABLED', 'FINITUDE_HIDDEN_DELIVERY_ENFORCED', 'OPENAI_API_KEY'] as const;
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    try {
        for (const name of names) delete process.env[name];
        assert.deepEqual(getAdminCapabilities(), {
            schemaVersion: 1, admin: true,
            albumImports: { enabled: false, analysisAvailable: false, model: 'gpt-6-luna', maxFiles: 100 },
            catalog: { editing: true, visibility: false },
            localMp3Conversion: { enabled: true, readSources: true, replace: true, preset: 'mp3-320', maxFiles: 100 }
        });
        process.env.FINITUDE_ADMIN_IMPORTS_ENABLED = 'true';
        process.env.OPENAI_API_KEY = 'fixture-provider-value';
        // A leftover closed rollout value from earlier deployments no longer makes the editor read-only.
        process.env.FINITUDE_ADMIN_CATALOG_ENABLED = 'false';
        process.env.FINITUDE_ADMIN_VISIBILITY_ENABLED = 'true';
        assert.equal(getAdminCapabilities().albumImports.analysisAvailable, true);
        assert.equal(getAdminCapabilities().catalog.editing, true);
        assert.equal(getAdminCapabilities().catalog.visibility, false);
        process.env.FINITUDE_HIDDEN_DELIVERY_ENFORCED = 'true';
        assert.equal(getAdminCapabilities().catalog.visibility, true);
        assert.equal(JSON.stringify(getAdminCapabilities()).includes('fixture-provider-value'), false);
        process.env.FINITUDE_HIDDEN_DELIVERY_ENFORCED = 'invalid';
        assert.equal(getAdminCapabilities().catalog.visibility, false);
    } finally {
        for (const name of names) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    }
});
