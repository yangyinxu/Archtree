import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { catalogSearchFilter, catalogSearchProjection, withCatalogSearchUpdate } from '../src/utils/catalogSearch';

test('search candidates are bounded and unsupported Unicode retains the exact regex path', () => {
    assert.deepEqual(catalogSearchProjection('Aa').catalogSearchGrams, ['a', 'aa']);
    for (const text of ['周杰伦', 'Kelvin', 'ſong', 'a'.repeat(513), null]) {
        assert.equal(catalogSearchProjection(text).catalogSearchVersion, 0);
    }
    const longest = catalogSearchProjection('a'.repeat(512));
    assert.equal(longest.catalogSearchVersion, 1);
    assert.ok(longest.catalogSearchGrams.length <= 1533);
    assert.deepEqual(catalogSearchFilter('title', '周.*', true), { title: { $regex: '周\\.\\*', $options: 'i' } });
    assert.deepEqual(catalogSearchFilter('title', 'needle', false), { title: { $regex: 'needle', $options: 'i' } });
});

test('operational backfill rejects invalid pages and unconfirmed writes before connecting', () => {
    for (const args of [[], ['--collection=albums', '--apply'], ['--collection=albums', '--limit=0'], ['--collection=users']]) {
        const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backfill-catalog-search.ts', ...args], {
            cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
            env: { ...process.env, DB_CONN_STRING: 'mongodb://127.0.0.1:1', DB_NAME: 'synthetic_no_connection' }
        });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /Search backfill failed/);
        assert.doesNotMatch(result.stderr, /127\.0\.0\.1|synthetic_no_connection/);
    }
});

test('metadata callers cannot supply their own candidate index and renames replace it atomically', () => {
    assert.deepEqual(withCatalogSearchUpdate({ bio: 'kept', catalogSearchVersion: 1, catalogSearchGrams: ['forged'] }, 'name'), { bio: 'kept' });
    assert.deepEqual(withCatalogSearchUpdate({ title: 'New title', catalogSearchGrams: [] }, 'title'), {
        title: 'New title', ...catalogSearchProjection('New title')
    });
});
