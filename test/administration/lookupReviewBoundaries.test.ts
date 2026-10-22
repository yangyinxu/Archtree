/**
 * Module boundaries metadata lookup for existing-Album reviews relies on: lookup loads the review capture and service, so neither
 * they nor the review's apply, identity and Credit modules may load the lookup service (or the review lookup requests) at run
 * time, though applying loads value application to read what it waits for; a review's lookup evidence, which the lookup record
 * loads, its value rules, the Credits an apply rebuilds and the records it creates stay pure: no database and no path back to the
 * record. Type-only imports are erased and never count.
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

const reviewService = 'src/administration/catalog/adminCatalogReviewService.ts';
const reviewApply = 'src/administration/catalog/adminCatalogReviewApply.ts';
const reviewIdentity = 'src/administration/catalog/adminCatalogReviewIdentity.ts';
const reviewCredits = 'src/administration/catalog/adminCatalogReviewCredits.ts';
const newRecords = 'src/administration/catalog/adminNewCatalogRecords.ts';
const discard = 'src/administration/catalog/adminCatalogReviewDiscard.ts';

test('the review service, its capture, apply, discard, identities and Credits never load the lookup service or the review lookup requests, which load them', () => {
    for (const start of [reviewService, 'src/administration/catalog/adminCatalogReviewCapture.ts', reviewApply, discard, reviewIdentity, reviewCredits]) {
        const loaded = reachable(start);
        assert.deepEqual([loaded.has(lookupService), loaded.has(reviewLookupRequests)], [false, false], start);
    }
    // The reverse direction is the intended one: lookup admits a review through its capture, and the requests use the review policy.
    assert.ok(runtimeImports(lookupService).includes('src/administration/catalog/adminCatalogReviewCapture.ts'));
    assert.ok(runtimeImports(reviewLookupRequests).includes(reviewService));
    // Creating a review queues its automatic run through the review lookup requests, which the route loads instead of the service.
    assert.ok(runtimeImports('src/routes/adminCatalogReviewRoutes.ts').includes(reviewLookupRequests));
    // Applying reads what it waits for from value application, which never loads the review service or the apply back.
    assert.ok(runtimeImports(reviewApply).includes(valueApplication));
    assert.equal(runtimeImports(reviewService).includes(valueApplication), false);
    assert.deepEqual([reachable(valueApplication).has(reviewService), reachable(valueApplication).has(reviewApply)], [false, false]);
    // Discarding deletes the lookup record through the pure lookup contract and never loads the review service, which reads its
    // tombstones for creation replays; the route loads it for the discard route and its discarded answers.
    assert.equal(reachable(discard).has(reviewService), false);
    assert.ok(runtimeImports(reviewService).includes(discard));
    assert.ok(runtimeImports('src/routes/adminCatalogReviewRoutes.ts').includes(discard));
    assert.ok(runtimeImports(discard).includes('src/administration/lookup/lookupContract.ts'));
    // The identity model never loads the review service or its capture.
    assert.deepEqual([reachable(reviewIdentity).has(reviewService), reachable(reviewIdentity).has('src/administration/catalog/adminCatalogReviewCapture.ts')], [false, false]);
});

test('the Credits an apply rebuilds and the records it creates are pure: no database', () => {
    for (const start of [reviewCredits, newRecords]) assert.equal(reachable(start).has(database), false, start);
    assert.ok(runtimeImports('src/administration/import/adminImportCatalogCommit.ts').includes(newRecords));
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
    assert.ok(reachable(reviewService).has(database));
});
