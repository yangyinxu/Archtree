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

test('bulk uploads preserve lifecycle outcomes and stop after server-wide failures', () => {
    assert.match(contentManagerClient, /request\.getResponseHeader\('Retry-After'\)/);
    assert.match(contentManagerClient, /statusCode === 429/);
    assert.match(contentManagerClient, /request\.status === 422/);
    assert.match(contentManagerClient, /outcomes\.push\(\.\.\.errorOutcomes\)/);
    assert.match(contentManagerClient, /Not attempted because the batch stopped after/);
    assert.match(contentManagerClient, /if \(stopBatch\) break/);
});

test('bulk uploads enforce the rendered file-selection limit before the first request', () => {
    assert.match(
        contentManagerClient,
        /const maximumBulkAudioFiles = Number\(bulkUploadForm\.dataset\.maxFiles\)/
    );
    assert.match(contentManagerClient, /files\.length > maximumBulkAudioFiles/);
    assert.match(contentManagerClient, /formData\.append\('audioFiles', file\)/);
    const validationIndex = contentManagerClient.indexOf(
        'Select no more than ${maximumBulkAudioFiles} files per batch.'
    );
    const uploadIndex = contentManagerClient.indexOf('const response = await uploadFile(');
    assert.ok(validationIndex >= 0);
    assert.ok(uploadIndex >= 0);
    assert.ok(validationIndex < uploadIndex);
});

test('bulk Album promotion is rejected before upload without a selected Primary Artist', () => {
    const validationIndex = contentManagerClient.indexOf(
        'Album promotion requires a selected Album and Primary Artist.'
    );
    const uploadIndex = contentManagerClient.indexOf('const response = await uploadFile(');
    assert.ok(validationIndex >= 0);
    assert.ok(uploadIndex >= 0);
    assert.ok(validationIndex < uploadIndex);
    assert.match(contentManagerClient, /promoteToAlbumPrimaryInput\.disabled = !canPromote/);
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
