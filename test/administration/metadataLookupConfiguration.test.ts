import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metadataLookupConfiguration } from '../../src/config/metadataLookup';
import { syntheticServerTestEnvironment } from '../../scripts/lib/server-test-environment.mjs';

const enabled = (contact: string | undefined, imports = 'true') => metadataLookupConfiguration({
    FINITUDE_ADMIN_IMPORTS_ENABLED: imports, ...(contact === undefined ? {} : { FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT: contact })
});

test('lookup stays unavailable while imports are off, even with a valid contact', () => {
    for (const imports of [undefined, '', 'false', 'TRUE', 'True', ' true', '1', 'yes']) {
        assert.deepEqual(metadataLookupConfiguration({ ...(imports === undefined ? {} : { FINITUDE_ADMIN_IMPORTS_ENABLED: imports }),
            FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT: 'lookup-operator@example.test' }), { available: false, reason: 'importsDisabled' }, String(imports));
    }
});

test('an absent, empty or whitespace contact is missing', () => {
    for (const contact of [undefined, '', '   ', '\t']) assert.deepEqual(enabled(contact), { available: false, reason: 'contactMissing' });
});

test('contacts that could break the User-Agent comment or identify nobody are invalid', () => {
    for (const contact of ['lookup operator@example.test', 'lookup(operator)@example.test', 'lookup-operator@example.test)', '"lookup"@example.test',
        'lookup-operator@example.test\r\nX-Injected: 1', 'lookup-operator@example.test\nX', 'opérateur@example.test', `${'a'.repeat(190)}@example.test`,
        'http://lookup.example.test/contact', 'https://user:secret@lookup.example.test/', 'https://lookup.example.test:8443/', 'https://localhost/',
        'https://192.0.2.10/', 'operator', 'ab', '<lookup-operator@example.test>', 'lookup-operator@example', 'mailto:lookup-operator@example.test']) {
        assert.deepEqual(enabled(contact), { available: false, reason: 'contactInvalid' }, contact);
    }
});

test('a valid email or https URL contact produces the exact User-Agent', () => {
    assert.deepEqual(enabled('lookup-operator@example.test'), { available: true, userAgent: 'Finitude/1.0 ( lookup-operator@example.test )' });
    assert.deepEqual(enabled('  lookup-operator@example.test  '), { available: true, userAgent: 'Finitude/1.0 ( lookup-operator@example.test )' });
    assert.deepEqual(enabled('https://lookup.example.test/contact'), { available: true, userAgent: 'Finitude/1.0 ( https://lookup.example.test/contact )' });
    assert.deepEqual(enabled('https://lookup.example.test:443/'), { available: true, userAgent: 'Finitude/1.0 ( https://lookup.example.test:443/ )' });
});

test('the default environment of every test process leaves lookup unavailable', () => {
    assert.equal(metadataLookupConfiguration().available, false);
    // The blank contact also protects test processes that turn imports on.
    assert.equal(syntheticServerTestEnvironment.FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT, '');
    assert.equal(process.env.FINITUDE_ADMIN_METADATA_LOOKUP_CONTACT, '');
    assert.deepEqual(metadataLookupConfiguration({ ...process.env, FINITUDE_ADMIN_IMPORTS_ENABLED: 'true' }), { available: false, reason: 'contactMissing' });
});
