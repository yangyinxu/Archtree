import { readFileSync } from 'node:fs';
import { ObjectId } from 'mongodb';
import type { AdminImportDocument } from '../../src/administration/import/adminImportService';

/** Fixture folders under test/fixtures: frozen v1 documents and the documents a later format could store. */
export type ImportFixtureFolder = 'adminImport' | 'adminImportCompat';

/** Stored import fixtures are relaxed MongoDB Extended JSON that uses only the $oid and $date wrappers. */
const revive = (_key: string, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const wrapped = value as { $oid?: string; $date?: string };
    return typeof wrapped.$oid === 'string' ? new ObjectId(wrapped.$oid) : typeof wrapped.$date === 'string' ? new Date(wrapped.$date) : value;
};

/** Reads one fixture as a fresh document, so a test may change or freeze it without affecting another test. */
export function loadImportFixture<T = AdminImportDocument>(folder: ImportFixtureFolder, name: string): T {
    return JSON.parse(readFileSync(new URL(`../fixtures/${folder}/${name}`, import.meta.url), 'utf8'), revive) as T;
}
