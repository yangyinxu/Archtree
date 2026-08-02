import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
    normalizeAvatar
} from '../src/services/avatarStorageService';
import { maxAvatarUploadMb } from '../src/middleware/imageUpload';

const upload = (buffer: Buffer, mimetype = 'image/png') => ({
    fieldname: 'avatar',
    originalname: 'profile.png',
    encoding: '7bit',
    mimetype,
    size: buffer.length,
    buffer
}) as Express.Multer.File;

test('normalizes avatars to a square metadata-free JPEG', async () => {
    const source = await sharp({
        create: {
            width: 320,
            height: 180,
            channels: 3,
            background: '#336699'
        }
    })
        .withMetadata({ orientation: 6 })
        .png()
        .toBuffer();

    const normalized = await normalizeAvatar(upload(source));
    const metadata = await sharp(normalized).metadata();

    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 1_024);
    assert.equal(metadata.height, 1_024);
    assert.equal(metadata.exif, undefined);
});

test('rejects a declared unsupported avatar type', async () => {
    const source = await sharp({
        create: {
            width: 10,
            height: 10,
            channels: 3,
            background: '#ffffff'
        }
    }).png().toBuffer();

    await assert.rejects(
        normalizeAvatar(upload(source, 'image/gif')),
        /valid JPG, PNG, or WebP/
    );
});

test('rejects oversized avatar input before decoding', async () => {
    const oversized = Buffer.alloc(maxAvatarUploadMb * 1024 * 1024 + 1);

    await assert.rejects(
        normalizeAvatar(upload(oversized)),
        /maximum size/
    );
});
