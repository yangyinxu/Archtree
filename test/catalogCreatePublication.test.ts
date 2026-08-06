import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';

import {
    Artist,
    ArtistCreationOutcomeUnknownError,
    confirmArtistCreationAfterWriteError
} from '../src/models/artist';
import {
    Album,
    AlbumCreationOutcomeUnknownError,
    confirmAlbumCreationAfterWriteError
} from '../src/models/album';
import { SimpleDate } from '../src/models/simpleDate';
import { publishNewArtist } from '../src/controllers/artistController';
import { publishNewAlbum } from '../src/controllers/albumController';
import { postArtist } from '../src/controllers/artistController';
import { postAlbum } from '../src/controllers/albumController';
import {
    createAlbumWeb,
    createArtistWeb
} from '../src/controllers/contentController';

const newArtist = () => new Artist(
    'Publication Artist',
    new SimpleDate(2000, 1, 2),
    'Biography',
    '',
    [] as unknown as [string],
    'admin-user',
    new ObjectId()
);

const newAlbum = () => new Album(
    'Publication Album',
    '',
    [] as unknown as [string],
    new SimpleDate(2026, 8, 5),
    'admin-user',
    new ObjectId()
);

test('new Artist publication attaches ready cover art before the single owner insert', async () => {
    const artist = newArtist();
    const imageId = new ObjectId().toHexString();
    let saveObserved = false;

    await publishNewArtist(
        artist,
        { imageId, coverArtUrl: `/content/images/${imageId}` },
        {
            saveArtist: async () => {
                saveObserved = true;
                assert.equal(artist.lifecycleStatus, 'ready');
                assert.equal(artist.coverArtId, imageId);
                assert.equal(artist.coverArtUrl, `/content/images/${imageId}`);
            }
        }
    );

    assert.equal(saveObserved, true);
});

test('new Album publication attaches ready cover art before the single owner insert', async () => {
    const album = newAlbum();
    const imageId = new ObjectId().toHexString();
    let saveObserved = false;

    await publishNewAlbum(
        album,
        { imageId, coverArtUrl: `/content/images/${imageId}` },
        {
            saveAlbum: async () => {
                saveObserved = true;
                assert.equal(album.lifecycleStatus, 'ready');
                assert.equal(album.coverArtId, imageId);
                assert.equal(album.coverArtUrl, `/content/images/${imageId}`);
            }
        }
    );

    assert.equal(saveObserved, true);
});

test('definite Artist creation failure deletes only its uploaded cover art', async () => {
    const artist = newArtist();
    const imageId = new ObjectId().toHexString();
    const writeError = new Error('owner insert rejected');
    const deletions: Array<[string, string]> = [];

    await assert.rejects(
        publishNewArtist(
            artist,
            { imageId, coverArtUrl: `/content/images/${imageId}` },
            {
                saveArtist: async () => { throw writeError; },
                deleteUploadedCoverArt: async (deletedImageId, ownerId) => {
                    deletions.push([deletedImageId, ownerId]);
                }
            }
        ),
        (error) => error === writeError
    );
    assert.deepEqual(deletions, [[imageId, artist._id!.toHexString()]]);
});

test('unknown Album creation outcome preserves uploaded cover evidence', async () => {
    const album = newAlbum();
    const imageId = new ObjectId().toHexString();
    const outcomeUnknown = Object.assign(new Error('confirmation unavailable'), {
        outcomeUnknown: true,
        cleanupPending: true
    });
    let cleanupAttempted = false;

    await assert.rejects(
        publishNewAlbum(
            album,
            { imageId, coverArtUrl: `/content/images/${imageId}` },
            {
                saveAlbum: async () => { throw outcomeUnknown; },
                deleteUploadedCoverArt: async () => { cleanupAttempted = true; }
            }
        ),
        (error) => error === outcomeUnknown
    );
    assert.equal(cleanupAttempted, false);
});

test('failed post-rejection cleanup reports reconciliation instead of losing evidence', async () => {
    const album = newAlbum();
    const imageId = new ObjectId().toHexString();

    await assert.rejects(
        publishNewAlbum(
            album,
            { imageId, coverArtUrl: `/content/images/${imageId}` },
            {
                saveAlbum: async () => { throw new Error('owner insert rejected'); },
                deleteUploadedCoverArt: async () => { throw new Error('storage unavailable'); }
            }
        ),
        (error: any) => error?.code === 'album_creation_cleanup_pending'
            && error?.statusCode === 503
            && error?.cleanupPending === true
            && error?.reconciliationRequired === true
    );
});

test('Artist insert response loss is recovered only from the exact ready owner and cover', async () => {
    const artist = newArtist();
    const imageId = new ObjectId().toHexString();
    artist.coverArtId = imageId;
    const result = await confirmArtistCreationAfterWriteError(
        artist,
        new Error('insert response lost'),
        async () => ({
            lifecycleStatus: 'ready',
            name: artist.name,
            createdBy: artist.createdBy,
            coverArtId: imageId
        })
    );
    assert.equal(result.insertedId.toHexString(), artist._id!.toHexString());

    await assert.rejects(
        confirmArtistCreationAfterWriteError(
            artist,
            new Error('insert response lost'),
            async () => ({
                lifecycleStatus: 'ready',
                name: artist.name,
                createdBy: artist.createdBy,
                coverArtId: new ObjectId().toHexString()
            })
        ),
        ArtistCreationOutcomeUnknownError
    );
});

test('Album insert confirmation failure preserves an outcome-unknown state', async () => {
    const album = newAlbum();
    const writeError = new Error('insert response lost');

    await assert.rejects(
        confirmAlbumCreationAfterWriteError(
            album,
            writeError,
            async () => { throw new Error('confirmation read unavailable'); }
        ),
        (error: any) => error instanceof AlbumCreationOutcomeUnknownError
            && error.statusCode === 503
            && error.cleanupPending === true
            && error.outcomeUnknown === true
    );

    await assert.rejects(
        confirmAlbumCreationAfterWriteError(album, writeError, async () => null),
        (error) => error === writeError
    );

    const unknownCommit = Object.assign(new Error('commit response lost'), {
        hasErrorLabel: (label: string) => label === 'UnknownTransactionCommitResult'
    });
    await assert.rejects(
        confirmAlbumCreationAfterWriteError(album, unknownCommit, async () => null),
        AlbumCreationOutcomeUnknownError
    );
});

const adminRequest = (body: Record<string, unknown>) => ({
    auth: { userId: 'admin-user', email: 'admin@example.com', role: 'admin' },
    body,
    params: {},
    query: {},
    headers: {},
    get: () => undefined
});

const captureResponse = () => {
    const capture: { statusCode?: number; body?: any; redirect?: string } = {};
    const response = {
        status(statusCode: number) {
            capture.statusCode = statusCode;
            return this;
        },
        json(body: unknown) {
            capture.body = body;
            return this;
        },
        redirect(location: string) {
            capture.redirect = location;
            return this;
        }
    };
    return { capture, response };
};

test('JSON Artist/Album create paths return explicit reconciliation semantics for unknown inserts', async () => {
    const originalArtistSave = Artist.prototype.save;
    const originalAlbumSave = Album.prototype.save;
    Artist.prototype.save = async () => {
        throw Object.assign(new Error('unknown Artist insert'), { outcomeUnknown: true });
    };
    Album.prototype.save = async () => {
        throw Object.assign(new Error('unknown Album insert'), { outcomeUnknown: true });
    };
    try {
        const artistResponse = captureResponse();
        await postArtist(
            adminRequest({ name: 'Artist', birthDate: {}, bio: '', coverArtUrl: '', albumIds: [] }) as any,
            artistResponse.response as any,
            (error: unknown) => { throw error; }
        );
        assert.equal(artistResponse.capture.statusCode, 503);
        assert.equal(artistResponse.capture.body.cleanupPending, true);
        assert.equal(artistResponse.capture.body.reconciliationRequired, true);

        const albumResponse = captureResponse();
        await postAlbum(
            adminRequest({ title: 'Album', coverArtUrl: '', audioTrackIds: [], releaseDate: {} }) as any,
            albumResponse.response as any,
            (error: unknown) => { throw error; }
        );
        assert.equal(albumResponse.capture.statusCode, 503);
        assert.equal(albumResponse.capture.body.cleanupPending, true);
        assert.equal(albumResponse.capture.body.reconciliationRequired, true);
    } finally {
        Artist.prototype.save = originalArtistSave;
        Album.prototype.save = originalAlbumSave;
    }
});

test('Web Artist/Album create paths tell administrators to reconcile before retrying', async () => {
    const originalArtistSave = Artist.prototype.save;
    const originalAlbumSave = Album.prototype.save;
    Artist.prototype.save = async () => {
        throw Object.assign(new Error('unknown Artist insert'), { outcomeUnknown: true });
    };
    Album.prototype.save = async () => {
        throw Object.assign(new Error('unknown Album insert'), { outcomeUnknown: true });
    };
    try {
        const artistResponse = captureResponse();
        await createArtistWeb(
            adminRequest({ name: 'Artist', birthDate: '', bio: '', coverArtUrl: '', albumIds: '' }) as any,
            artistResponse.response as any,
            (error: unknown) => { throw error; }
        );
        assert.match(
            decodeURIComponent(artistResponse.capture.redirect ?? ''),
            /Artist creation outcome could not be confirmed\. Reconciliation is required before retrying\./
        );

        const albumResponse = captureResponse();
        await createAlbumWeb(
            adminRequest({ title: 'Album', coverArtUrl: '', audioTrackIds: '', releaseDate: '' }) as any,
            albumResponse.response as any,
            (error: unknown) => { throw error; }
        );
        assert.match(
            decodeURIComponent(albumResponse.capture.redirect ?? ''),
            /Album creation outcome could not be confirmed\. Reconciliation is required before retrying\./
        );
    } finally {
        Artist.prototype.save = originalArtistSave;
        Album.prototype.save = originalAlbumSave;
    }
});
