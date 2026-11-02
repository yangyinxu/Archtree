import assert from 'node:assert/strict';
import test from 'node:test';
import { getAdminCapabilities } from '../../src/administration/adminCapabilityService';
import { maxVideoUploadMb } from '../../src/middleware/videoUpload';

const names = ['FINITUDE_ADMIN_IMPORTS_ENABLED', 'FINITUDE_ADMIN_CATALOG_ENABLED', 'FINITUDE_ADMIN_VISIBILITY_ENABLED', 'FINITUDE_HIDDEN_DELIVERY_ENFORCED',
    'OPENAI_API_KEY', 'FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT', 'FINITUDE_ADMIN_IMPORT_PRIVATE_STORAGE_READY',
    'ADMIN_IMPORT_S3_BUCKET_NAME', 'S3_BUCKET_NAME'] as const;
/** Runs `work` with every capability variable cleared, restoring the previous values afterwards. */
function withCleanEnvironment(work: () => void) {
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    try {
        for (const name of names) delete process.env[name];
        work();
    } finally {
        for (const name of names) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    }
}

test('catalog editing and visibility need only the admin role; imports default off and never expose provider configuration', () => withCleanEnvironment(() => {
    assert.deepEqual(getAdminCapabilities(), {
        schemaVersion: 1, admin: true,
        albumImports: { enabled: false, analysisAvailable: false, model: 'gpt-6-luna', maxFiles: 100 },
        catalog: { editing: true, visibility: true },
        localMp3Conversion: { enabled: true, readSources: true, replace: true, preset: 'mp3-320', maxFiles: 100 },
        metadataLookup: { available: false },
        videoUploads: { enabled: false, maxFileBytes: maxVideoUploadMb * 1024 ** 2, acceptedExtensions: ['mp4', 'mov', 'm4v'] }
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
}));

test('Video admission requires asserted distinct private storage and never exposes its locations', () => withCleanEnvironment(() => {
    process.env.FINITUDE_ADMIN_IMPORT_PRIVATE_STORAGE_READY = 'true';
    process.env.S3_BUCKET_NAME = 'synthetic-catalog-bucket';
    assert.equal(getAdminCapabilities().videoUploads.enabled, false);
    process.env.ADMIN_IMPORT_S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
    assert.equal(getAdminCapabilities().videoUploads.enabled, false);
    process.env.ADMIN_IMPORT_S3_BUCKET_NAME = 'synthetic-private-staging-bucket';
    assert.equal(getAdminCapabilities().videoUploads.enabled, true);
    const shown = JSON.stringify(getAdminCapabilities());
    assert.ok(!shown.includes('synthetic-catalog-bucket') && !shown.includes('synthetic-private-staging-bucket'));
}));

test('metadata lookup is available only with imports enabled and a valid contact, and never reports the contact or the reason', () => withCleanEnvironment(() => {
    process.env.FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT = 'lookup-operator@example.test';
    assert.deepEqual(getAdminCapabilities().metadataLookup, { available: false }, 'imports disabled');
    process.env.FINITUDE_ADMIN_IMPORTS_ENABLED = 'true';
    assert.deepEqual(getAdminCapabilities().metadataLookup, { available: true });
    const shown = JSON.stringify(getAdminCapabilities());
    for (const secret of ['lookup-operator', 'example.test', 'contact', 'reason']) assert.equal(shown.includes(secret), false, secret);
    process.env.FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT = 'not a contact';
    assert.deepEqual(getAdminCapabilities().metadataLookup, { available: false }, 'invalid contact');
    delete process.env.FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT;
    assert.deepEqual(getAdminCapabilities().metadataLookup, { available: false }, 'missing contact');
    assert.equal(JSON.stringify(getAdminCapabilities()).includes('contactMissing'), false);
}));
