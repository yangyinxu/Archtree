import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    removeStaleMongoTestDirectories
} from './support/mongoReplicaSet';

const exists = async (path: string) => {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
};

test('stale Mongo cleanup removes dead owners but preserves active harnesses', async () => {
    const deadDirectory = await mkdtemp(join(tmpdir(), 'archtree-auth-test-'));
    const activeDirectory = await mkdtemp(join(tmpdir(), 'archtree-auth-test-'));
    const unrelatedDirectory = await mkdtemp(join(tmpdir(), 'archtree-other-test-'));
    try {
        await writeFile(
            join(deadDirectory, '.archtree-test-owner.json'),
            JSON.stringify({ pid: 999_999, createdAt: new Date().toISOString() })
        );
        await writeFile(
            join(activeDirectory, '.archtree-test-owner.json'),
            JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
        );

        await removeStaleMongoTestDirectories();

        assert.equal(await exists(deadDirectory), false);
        assert.equal(await exists(activeDirectory), true);
        assert.equal(await exists(unrelatedDirectory), true);
    } finally {
        await Promise.all([
            rm(deadDirectory, { recursive: true, force: true }),
            rm(activeDirectory, { recursive: true, force: true }),
            rm(unrelatedDirectory, { recursive: true, force: true })
        ]);
    }
});
