/**
 * Module boundaries metadata lookup for existing-Album reviews relies on: lookup loads the review capture and service, so neither
 * may load the lookup service (or the review lookup requests) at run time, though the review service loads value application to
 * read what applying waits for; a review's lookup evidence, which the lookup record loads, and its value rules stay pure: no
 * database and no path back to the record. Type-only imports are erased and never count.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The repository paths a source file loads at run time through relative imports, re-exports and dynamic imports. */
function runtimeImports(file: string): string[] {
    const text = readFileSync(path.join(repositoryRoot, file), 'utf8'), specifiers: string[] = [];
    for (const match of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^'";=()]*?\bfrom\s+['"](\.\.?\/[^'"]+)['"]/gm)) if (!match[1]) specifiers.push(match[2]);
    for (const match of text.matchAll(/\bimport\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g)) specifiers.push(match[1]);
    return specifiers.map(specifier => {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        const resolved = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(candidate => existsSync(path.join(repositoryRoot, candidate)));
        assert.ok(resolved, `${file} imports ${specifier}`);
        return resolved;
    });
}
/** Every module `start` loads at run time, itself included. */
function reachable(start: string): Set<string> {
    const seen = new Set([start]), queue = [start];
    while (queue.length) for (const next of runtimeImports(queue.shift()!)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    return seen;
}

const lookupService = 'src/administration/lookup/metadataLookupService.ts';
const reviewLookupRequests = 'src/administration/lookup/catalogReviewLookupRequests.ts';
const lookupRecord = 'src/administration/lookup/metadataLookupRecord.ts';
const reviewEvidence = 'src/administration/lookup/lookupReviewEvidence.ts';
const reviewValues = 'src/administration/lookup/lookupReviewValues.ts';
const valueApplication = 'src/administration/lookup/lookupValueApplication.ts';
const database = 'src/infrastructure/database.ts';

test('the review service and its capture never load the lookup service or the review lookup requests, which load them', () => {
    for (const start of ['src/administration/catalog/adminCatalogReviewService.ts', 'src/administration/catalog/adminCatalogReviewCapture.ts']) {
        const loaded = reachable(start);
        assert.deepEqual([loaded.has(lookupService), loaded.has(reviewLookupRequests)], [false, false], start);
    }
    // The reverse direction is the intended one: lookup admits a review through its capture, and the requests use the review policy.
    assert.ok(runtimeImports(lookupService).includes('src/administration/catalog/adminCatalogReviewCapture.ts'));
    assert.ok(runtimeImports(reviewLookupRequests).includes('src/administration/catalog/adminCatalogReviewService.ts'));
    // The review service reads what applying waits for from value application, which never loads the review service back.
    assert.ok(runtimeImports('src/administration/catalog/adminCatalogReviewService.ts').includes(valueApplication));
    assert.equal(reachable(valueApplication).has('src/administration/catalog/adminCatalogReviewService.ts'), false);
});

test('a review\'s value rules are pure: no database, no lookup record, value application or lookup service', () => {
    const values = reachable(reviewValues);
    assert.deepEqual([values.has(database), values.has(lookupRecord), values.has(valueApplication), values.has(lookupService)], [false, false, false, false]);
    assert.ok(runtimeImports(valueApplication).includes(reviewValues));
});

test('a review\'s lookup evidence and the lookup record are pure: no database, and the evidence never loads the record back', () => {
    const evidence = reachable(reviewEvidence), record = reachable(lookupRecord);
    assert.deepEqual([evidence.has(database), evidence.has(lookupRecord), evidence.has(lookupService)], [false, false, false]);
    assert.deepEqual([record.has(database), record.has(reviewEvidence), record.has(lookupService)], [false, true, false]);
});

test('the reader skips type-only imports and follows value imports, so the checks above are not vacuous', () => {
    const evidenceSource = readFileSync(path.join(repositoryRoot, reviewEvidence), 'utf8');
    assert.match(evidenceSource, /import type \{[^}]*\} from '\.\.\/import\/adminImportService'/);
    assert.equal(runtimeImports(reviewEvidence).includes('src/administration/import/adminImportService.ts'), false);
    assert.ok(runtimeImports(reviewEvidence).includes('src/administration/lookup/lookupQueryPlanner.ts'));
    assert.ok(reachable('src/administration/catalog/adminCatalogReviewService.ts').has(database));
});
