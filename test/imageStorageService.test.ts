import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import sharp from 'sharp';

import {
    coverArtVariantEtag,
    coverArtVariantWidths,
    getCoverArtObject,
    getCoverArtVariant,
    isCoverArtVariantWidth,
    isPublicCoverArtAsset,
    resolvePublicCoverArtAsset,
    transformCoverArtVariant,
    validateCoverArtFile
} from '../src/services/imageStorageService';

const imageId = '507f1f77bcf86cd799439011';
const readyAsset = (ownerType: 'artist' | 'album' | 'audioTrack' | 'user') => ({
    ownerType,
    ownerId: '507f191e810c19729de860ea',
    uploadStatus: 'ready' as const,
    s3Key: `images/${imageId}`,
    contentType: 'image/jpeg'
});
const attachedOwner = { coverArtId: imageId };
const uploadedFile = (buffer: Buffer, mimetype: string): Express.Multer.File => ({
    fieldname: 'coverArtFile',
    originalname: 'cover-art',
    encoding: '7bit',
    mimetype,
    size: buffer.length,
    stream: Readable.from(buffer),
    destination: '',
    filename: '',
    path: '',
    buffer
});

test('public cover art accepts ready catalog images', () => {
    assert.equal(isPublicCoverArtAsset(readyAsset('artist')), true);
    assert.equal(isPublicCoverArtAsset(readyAsset('album')), true);
    assert.equal(isPublicCoverArtAsset(readyAsset('audioTrack')), true);
});

test('public cover art rejects private avatars and incomplete catalog images', () => {
    assert.equal(isPublicCoverArtAsset(readyAsset('user')), false);
    assert.equal(isPublicCoverArtAsset({ ownerType: 'album', uploadStatus: 'pending' }), false);
    assert.equal(isPublicCoverArtAsset(null), false);
});

test('public cover art rejects a ready private avatar before requesting storage', async () => {
    let storageCalls = 0;
    const result = await getCoverArtObject('private-avatar', {}, {
        findAsset: async () => ({
            ownerType: 'user',
            ownerId: 'listener',
            uploadStatus: 'ready',
            s3Key: 'avatars/private-avatar'
        }) as any,
        getObject: async () => {
            storageCalls += 1;
            throw new Error('Private storage must not be reached.');
        }
    });

    assert.equal(result, null);
    assert.equal(storageCalls, 0);
});

test('cover-art upload validation decodes allowed bytes instead of trusting signatures', async () => {
    const validPng = await sharp({
        create: { width: 12, height: 12, channels: 3, background: '#336699' }
    }).png().toBuffer();
    await validateCoverArtFile(uploadedFile(validPng, 'image/png'));

    const signatureOnlyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await assert.rejects(
        validateCoverArtFile(uploadedFile(signatureOnlyPng, 'image/png')),
        (error: any) => error?.statusCode === 400
    );

    const pixels = Buffer.alloc(128 * 128 * 3);
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 31) % 251;
    const completePng = await sharp(pixels, {
        raw: { width: 128, height: 128, channels: 3 }
    }).png({ compressionLevel: 0 }).toBuffer();
    const truncatedPng = completePng.subarray(0, Math.floor(completePng.length * 0.6));
    await assert.rejects(
        validateCoverArtFile(uploadedFile(truncatedPng, 'image/png')),
        (error: any) => error?.statusCode === 400
    );
});

test('public cover art requires the current owner to retain the image reference', async () => {
    let storageCalls = 0;
    const detached = await getCoverArtObject(imageId, {}, {
        findAsset: async () => readyAsset('album'),
        findOwner: async () => ({ coverArtId: '507f1f77bcf86cd799439012' }),
        getObject: async () => {
            storageCalls += 1;
            return {};
        }
    });
    assert.equal(detached, null);
    assert.equal(storageCalls, 0);

    const attached = await resolvePublicCoverArtAsset(imageId, {
        findAsset: async () => readyAsset('album'),
        findOwner: async () => attachedOwner
    });
    assert.equal(attached?.s3Key, `images/${imageId}`);
});

test('original artwork keeps forwarding its own conditional validator after owner validation', async () => {
    let received: unknown;
    const result = await getCoverArtObject(imageId, { ifNoneMatch: '"source"' }, {
        findAsset: async () => readyAsset('artist'),
        findOwner: async () => attachedOwner,
        getObject: async (input) => {
            received = input;
            return { Body: Readable.from(Buffer.from('source')) };
        }
    });

    assert.equal(result?.notModified, false);
    assert.deepEqual(received, {
        s3Key: `images/${imageId}`,
        ifNoneMatch: '"source"',
        abortSignal: undefined
    });
});

test('original artwork never reflects wildcard or multi-value request validators', async () => {
    for (const ifNoneMatch of ['*', '"old", "current"']) {
        const result = await getCoverArtObject(imageId, { ifNoneMatch }, {
            findAsset: async () => readyAsset('artist'),
            findOwner: async () => attachedOwner,
            getObject: async () => {
                throw { $metadata: { httpStatusCode: 304 } };
            }
        });
        assert.equal(result?.notModified, true);
        assert.equal(result?.etag, undefined);
    }

    const result = await getCoverArtObject(imageId, { ifNoneMatch: '"current"' }, {
        findAsset: async () => readyAsset('artist'),
        findOwner: async () => attachedOwner,
        getObject: async () => {
            throw {
                $metadata: { httpStatusCode: 304 },
                $response: { headers: { etag: '"current"' } }
            };
        }
    });
    assert.equal(result?.etag, '"current"');
});

test('the v1 derivative width contract is a fixed allowlist', () => {
    assert.deepEqual(coverArtVariantWidths, [96, 192, 320, 480, 640, 960, 1280]);
    for (const width of coverArtVariantWidths) assert.equal(isCoverArtVariantWidth(String(width)), true);
    for (const width of [0, 95, 97, 192.5, 256, 1281, '96px', '096', '96.0', ' 96 ', '']) {
        assert.equal(isCoverArtVariantWidth(width), false);
    }
});

test('invalid derivative widths fail before database, storage, or Sharp work', async () => {
    let calls = 0;
    await assert.rejects(
        getCoverArtVariant(imageId, 97, {}, {
            findAsset: async () => {
                calls += 1;
                return readyAsset('album');
            },
            findOwner: async () => {
                calls += 1;
                return attachedOwner;
            },
            getObject: async () => {
                calls += 1;
                return {};
            },
            transform: async () => {
                calls += 1;
                return Buffer.alloc(0);
            }
        }),
        (error: any) => error?.statusCode === 400
    );
    assert.equal(calls, 0);
});

test('a matching v1 validator checks ownership but skips S3 and Sharp', async () => {
    let ownerCalls = 0;
    let storageCalls = 0;
    let transformCalls = 0;
    const etag = coverArtVariantEtag(imageId, 320);
    const result = await getCoverArtVariant(imageId, 320, {
        ifNoneMatch: `"unrelated", W/${etag}`
    }, {
        findAsset: async () => readyAsset('audioTrack'),
        findOwner: async () => {
            ownerCalls += 1;
            return attachedOwner;
        },
        getObject: async () => {
            storageCalls += 1;
            return {};
        },
        transform: async () => {
            transformCalls += 1;
            return Buffer.alloc(0);
        }
    });

    assert.equal(ownerCalls, 1);
    assert.equal(storageCalls, 0);
    assert.equal(transformCalls, 0);
    assert.deepEqual(result, {
        asset: readyAsset('audioTrack'),
        etag,
        notModified: true
    });
});

test('a v1 derivative never forwards its representation validator to S3', async () => {
    const source = await sharp({
        create: { width: 16, height: 12, channels: 3, background: '#224466' }
    }).png().toBuffer();
    let storageInput: Record<string, unknown> | undefined;
    let transformedWidth = 0;
    const result = await getCoverArtVariant(imageId, 192, {
        ifNoneMatch: '"stale-variant"'
    }, {
        findAsset: async () => readyAsset('album'),
        findOwner: async () => attachedOwner,
        getObject: async (input) => {
            storageInput = input;
            return { Body: Readable.from(source), ContentLength: source.length };
        },
        transform: async (input, width) => {
            assert.deepEqual(input, source);
            transformedWidth = width;
            return Buffer.from('derived');
        }
    });

    assert.deepEqual(storageInput, {
        s3Key: `images/${imageId}`,
        abortSignal: undefined
    });
    assert.equal(Object.hasOwn(storageInput ?? {}, 'ifNoneMatch'), false);
    assert.equal(transformedWidth, 192);
    assert.equal(result?.body?.toString(), 'derived');
    assert.equal(result?.etag, coverArtVariantEtag(imageId, 192));
    assert.equal(result?.notModified, false);
});

test('Sharp applies orientation and emits an exact metadata-free square WebP', async () => {
    const source = await sharp({
        create: { width: 40, height: 20, channels: 3, background: '#884422' }
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const output = await transformCoverArtVariant(source, 320);
    const metadata = await sharp(output).metadata();

    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 320);
    assert.equal(metadata.height, 320);
    assert.equal(metadata.orientation, undefined);
    assert.equal(metadata.exif, undefined);
});

test('derivative decoding enforces the configured pixel ceiling', async () => {
    const source = await sharp({
        create: { width: 20, height: 20, channels: 3, background: '#112233' }
    }).png().toBuffer();
    await assert.rejects(
        transformCoverArtVariant(source, 96, { maxInputPixels: 100 }),
        /pixel limit/i
    );
});

test('declared and streamed derivative inputs are byte-bounded before Sharp', async () => {
    for (const includeDeclaredLength of [true, false]) {
        let transformCalls = 0;
        await assert.rejects(
            getCoverArtVariant(imageId, 96, {}, {
                findAsset: async () => readyAsset('album'),
                findOwner: async () => attachedOwner,
                getObject: async () => ({
                    Body: Readable.from(Buffer.from('12345')),
                    ...(includeDeclaredLength ? { ContentLength: 5 } : {})
                }),
                maxInputBytes: 4,
                transform: async () => {
                    transformCalls += 1;
                    return Buffer.alloc(0);
                }
            }),
            (error: any) => error?.statusCode === 413
        );
        assert.equal(transformCalls, 0);
    }
});
