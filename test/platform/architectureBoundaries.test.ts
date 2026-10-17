import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Enforces the dependency and placement rules in docs/architecture/standards.md,
 * so the server layout cannot drift back into flat or upward-importing modules.
 */
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

const listFiles = (directory: string): string[] => readdirSync(path.join(repositoryRoot, directory), { withFileTypes: true })
    .flatMap(entry => entry.isDirectory()
        ? listFiles(path.posix.join(directory, entry.name))
        : [path.posix.join(directory, entry.name)]);

const sourceFiles = listFiles('src').filter(file => /\.tsx?$/.test(file));

/** Returns each relative import of a file as a repository path without extension. */
const relativeImports = (file: string) => [...readFileSync(path.join(repositoryRoot, file), 'utf8')
    .matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](\.\.?\/[^'"]+)['"]/g)]
    .map(match => path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));

/** Layers that only the HTTP edge may depend on, with the modules allowed to import each. */
const edgeLayers: Record<string, RegExp> = {
    'src/controllers/': /^src\/(app|server)\.ts$|^src\/(routes|controllers)\//,
    'src/routes/': /^src\/(app|server)\.ts$|^src\/routes\//,
    'src/views/': /^src\/(app|server)\.ts$|^src\/(routes|controllers|views)\//
};

/** Existing exceptions, each to be removed rather than extended. */
const knownExceptions = new Set([
    // Admin catalog previews reuse the MediaTrack byte-range responder instead of duplicating it.
    'src/administration/catalog/adminCatalogPreview.ts -> src/controllers/mediaTrackController'
]);

test('only the HTTP edge imports controllers, routes, and views', () => {
    const violations = sourceFiles.flatMap(file => relativeImports(file).flatMap(target => Object.entries(edgeLayers)
        .filter(([layer, allowed]) => target.startsWith(layer) && !allowed.test(file))
        .map(() => `${file} -> ${target}`)))
        .filter(violation => !knownExceptions.has(violation));
    assert.deepEqual(violations, []);
});

test('server code never imports tests or the Web client', () => {
    const violations = sourceFiles.flatMap(file => relativeImports(file)
        .filter(target => /^(test|web)\//.test(target))
        .map(target => `${file} -> ${target}`));
    assert.deepEqual(violations, []);
});

test('services and server tests live in domain folders', () => {
    const flat = [
        ...listFiles('src/services').filter(file => path.posix.dirname(file) === 'src/services'),
        ...listFiles('test').filter(file => path.posix.dirname(file) === 'test' && /\.ts$/.test(file))
    ];
    assert.deepEqual(flat, []);
});
