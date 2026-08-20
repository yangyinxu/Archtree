import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

import {
    catalogCreditRollout,
    CatalogCreditWritesDisabledError,
    requireCatalogCreditWrites
} from '../src/config/catalogCreditRollout';
import { postArtist, updateArtist } from '../src/controllers/artistController';
import { postAudioTrack, updateAudioTrack } from '../src/controllers/audioTrackController';
import { AudioFormat, AudioTrack } from '../src/models/audioTrack';
import { SimpleDate } from '../src/models/simpleDate';

const rolloutKeys = [
    'CATALOG_CREDIT_READS_ENABLED',
    'CATALOG_CREDIT_WRITES_ENABLED',
    'CATALOG_CREDIT_SECTIONS_ENABLED',
    'CATALOG_ORGANIZATION_SURFACES_ENABLED',
    'CATALOG_CREDIT_REJECT_LEGACY_WRITES'
] as const;

test('Catalog Credit rollout defaults keep additive reads and writes on without rejecting legacy clients', () => {
    const prior = Object.fromEntries(rolloutKeys.map((key) => [key, process.env[key]]));
    rolloutKeys.forEach((key) => delete process.env[key]);
    try {
        assert.deepEqual(catalogCreditRollout(), {
            readsEnabled: true,
            writesEnabled: true,
            sectionsEnabled: true,
            organizationSurfacesEnabled: true,
            rejectLegacyWrites: false
        });
    } finally {
        rolloutKeys.forEach((key) => {
            if (prior[key] === undefined) delete process.env[key];
            else process.env[key] = prior[key];
        });
    }
});

test('Catalog Credit write kill switch fails before a mutation starts', () => {
    const prior = process.env.CATALOG_CREDIT_WRITES_ENABLED;
    process.env.CATALOG_CREDIT_WRITES_ENABLED = 'false';
    try {
        assert.throws(() => requireCatalogCreditWrites(), CatalogCreditWritesDisabledError);
    } finally {
        if (prior === undefined) delete process.env.CATALOG_CREDIT_WRITES_ENABLED;
        else process.env.CATALOG_CREDIT_WRITES_ENABLED = prior;
    }
});

test('Catalog Credit write kill switch also fences initial Soundtrack attribution', () => {
    const prior = process.env.CATALOG_CREDIT_WRITES_ENABLED;
    process.env.CATALOG_CREDIT_WRITES_ENABLED = 'false';
    const track = new AudioTrack(
        'Undocumented recording',
        [] as unknown as [string],
        [] as unknown as [string],
        '',
        new SimpleDate(),
        '',
        new AudioFormat('MP3'),
        '',
        'admin-id'
    );
    track.credits = [];
    track.attributionStatus = 'unknown';
    try {
        assert.throws(() => track.save(), CatalogCreditWritesDisabledError);
    } finally {
        if (prior === undefined) delete process.env.CATALOG_CREDIT_WRITES_ENABLED;
        else process.env.CATALOG_CREDIT_WRITES_ENABLED = prior;
    }
});

test('Catalog Credit cutover rejects direct legacy relationship writes before database or upload work', async () => {
    const prior = process.env.CATALOG_CREDIT_REJECT_LEGACY_WRITES;
    process.env.CATALOG_CREDIT_REJECT_LEGACY_WRITES = 'true';
    const responses: Array<{ statusCode: number; body: unknown }> = [];
    const response = {
        statusCode: 200,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(body: unknown) {
            responses.push({ statusCode: this.statusCode, body });
            return this;
        }
    } as unknown as Response;
    const request = (body: Record<string, unknown>, params: Record<string, string> = {}) => ({
        auth: { userId: 'admin-id', role: 'admin' },
        body,
        params
    }) as unknown as Request;
    const next = ((error?: unknown) => {
        if (error) throw error;
    }) as NextFunction;

    try {
        await postArtist(request({ albumIds: ['legacy-album'] }), response, next);
        await updateArtist(request({ albumIds: ['legacy-album'] }, { artistId: 'artist-id' }), response, next);
        await postAudioTrack(request({ artistIds: ['legacy-artist'] }), response, next);
        await updateAudioTrack(
            request({ artistIds: ['legacy-artist'] }, { audioTrackId: 'track-id' }),
            response,
            next
        );
        assert.deepEqual(responses.map(({ statusCode }) => statusCode), [409, 409, 409, 409]);
    } finally {
        if (prior === undefined) delete process.env.CATALOG_CREDIT_REJECT_LEGACY_WRITES;
        else process.env.CATALOG_CREDIT_REJECT_LEGACY_WRITES = prior;
    }
});
