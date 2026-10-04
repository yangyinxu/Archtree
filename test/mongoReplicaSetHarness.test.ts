import assert from 'node:assert/strict';
import { promises as fsPromises, rmSync } from 'node:fs';
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

test('stale Mongo cleanup moves past directories that another run removes mid-sweep', async t => {
    const [beforeLstat, beforeOwnerRead, beforeRemoval, deadDirectory, activeDirectory] = await Promise.all(
        Array.from({ length: 5 }, () => mkdtemp(join(tmpdir(), 'archtree-auth-test-')))
    );
    try {
        // Dead owners carry the sweep through the owner read to removal; the active owner must survive.
        for (const directory of [beforeOwnerRead, beforeRemoval, deadDirectory, activeDirectory]) {
            const pid = directory === activeDirectory ? process.pid : 999_999;
            await writeFile(
                join(directory, '.archtree-test-owner.json'),
                JSON.stringify({ pid, createdAt: new Date().toISOString() })
            );
        }

        // Deletes a directory just before the sweep's real call, as a concurrent run's own cleanup would.
        const vanished = new Set<string>();
        const removeBefore = (method: 'lstat' | 'readFile' | 'rm', path: string, directory: string) => {
            const original = fsPromises[method] as (...args: unknown[]) => Promise<unknown>;
            t.mock.method(fsPromises, method, (...args: unknown[]) => {
                if (args[0] === path) {
                    rmSync(directory, { recursive: true, force: true });
                    vanished.add(directory);
                }
                return original(...args);
            });
        };
        removeBefore('lstat', beforeLstat, beforeLstat);
        removeBefore('readFile', join(beforeOwnerRead, '.archtree-test-owner.json'), beforeOwnerRead);
        removeBefore('rm', beforeRemoval, beforeRemoval);

        await removeStaleMongoTestDirectories();

        assert.deepEqual([...vanished].sort(), [beforeLstat, beforeOwnerRead, beforeRemoval].sort());
        assert.equal(await exists(deadDirectory), false);
        assert.equal(await exists(activeDirectory), true);
    } finally {
        await Promise.all([beforeLstat, beforeOwnerRead, beforeRemoval, deadDirectory, activeDirectory]
            .map(directory => rm(directory, { recursive: true, force: true })));
    }
});

test('stale Mongo cleanup still surfaces filesystem errors other than a missing path', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'archtree-auth-test-'));
    try {
        const original = fsPromises.lstat as (...args: unknown[]) => Promise<unknown>;
        t.mock.method(fsPromises, 'lstat', (...args: unknown[]) => args[0] === directory
            ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, lstat '${directory}'`), { code: 'EACCES' }))
            : original(...args));

        await assert.rejects(removeStaleMongoTestDirectories(), { code: 'EACCES' });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
