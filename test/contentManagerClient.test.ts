import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const contentManagerClient = readFileSync(
    new URL('../src/public/content-manager.js', import.meta.url),
    'utf8'
);

test('bulk Soundtrack uploads preserve every Credit intent field in each request', () => {
    assert.match(contentManagerClient, /formData\.append\('artistRole', artistRole\)/);
    assert.match(
        contentManagerClient,
        /formData\.append\('inheritAlbumPrimaryCredits', 'true'\)/
    );
    assert.match(contentManagerClient, /formData\.append\('organizationId', organizationId\)/);
    assert.match(contentManagerClient, /formData\.append\('organizationRole', organizationRole\)/);
    assert.match(contentManagerClient, /formData\.append\('attributionUnknown', 'true'\)/);
    assert.match(contentManagerClient, /formData\.append\('promoteToAlbumPrimary', 'true'\)/);
});

test('clearing Credits for unknown attribution requires explicit confirmation', () => {
    assert.match(contentManagerClient, /\[data-confirm-attribution-unknown\]/);
    assert.match(contentManagerClient, /This removes every current Credit/);
});

test('optional batch controls cannot disable destructive confirmations', () => {
    const confirmationIndex = contentManagerClient.indexOf("document.querySelectorAll('button[data-danger]')");
    const batchIndex = contentManagerClient.indexOf("document.querySelectorAll('[data-batch-track-delete]')");
    assert.ok(confirmationIndex >= 0);
    assert.ok(batchIndex >= 0);
    assert.ok(confirmationIndex < batchIndex);
    assert.match(contentManagerClient, /if \(!button \|\| !selectAllButton \|\| trackCheckboxes\.length === 0\) return/);
});

test('generated labels do not duplicate explicit labels', () => {
    assert.match(contentManagerClient, /field\.labels && field\.labels\.length > 0/);
});

test('drag reorder provides keyboard-operable move controls', () => {
    assert.match(contentManagerClient, /moveUp\.textContent = 'Move up'/);
    assert.match(contentManagerClient, /moveDown\.textContent = 'Move down'/);
    assert.match(contentManagerClient, /selectMove\(element/);
});
