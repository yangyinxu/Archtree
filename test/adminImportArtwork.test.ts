import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { extractImportArtwork } from '../src/administration/adminImportArtwork';

const wrap = (buffer: Buffer) => ({ buffer, size: buffer.length, originalname: 'synthetic.mp3', mimetype: 'audio/mpeg' } as Express.Multer.File);
const atom = (name: string, body: Buffer) => { const header = Buffer.alloc(8); header.writeUInt32BE(body.length + 8); header.write(name, 4); return Buffer.concat([header, body]); };
const id3 = (png: Buffer) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from('image/png\0'), Buffer.from([3, 0]), png]); const frame = Buffer.alloc(10); frame.write('APIC'); frame.writeUInt32BE(body.length, 4);
    const tags = Buffer.concat([frame, body]), header = Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 0, 0]); for (let index = 0; index < 4; index++) header[9 - index] = (tags.length >>> (index * 7)) & 127; return Buffer.concat([header, tags]);
};
test('bounded embedded artwork reads ID3, FLAC, MP4 and RIFF metadata as actual image bytes', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#3268ab' } }).png().toBuffer();
    const picture = Buffer.alloc(32); picture.writeUInt32BE(3); picture.writeUInt32BE(0, 4); picture.writeUInt32BE(0, 8); picture.writeUInt32BE(png.length, 28); const flacHeader = Buffer.alloc(4); flacHeader[0] = 0x86; flacHeader.writeUIntBE(picture.length + png.length, 1, 3);
    const mp4 = Buffer.concat([atom('ftyp', Buffer.from('M4A \0\0\0\0')), atom('mdat', Buffer.alloc(100)), atom('moov', atom('udta', atom('meta', Buffer.concat([Buffer.alloc(4), atom('ilst', atom('covr', atom('data', Buffer.concat([Buffer.alloc(8), png]))))]))))]);
    const tag = id3(png), riffHeader = Buffer.alloc(20); riffHeader.write('RIFF'); riffHeader.writeUInt32LE(12 + tag.length, 4); riffHeader.write('WAVEid3 ', 8); riffHeader.writeUInt32LE(tag.length, 16);
    for (const source of [tag, Buffer.concat([Buffer.from('fLaC'), flacHeader, picture, png]), mp4, Buffer.concat([riffHeader, tag])]) { const result = await extractImportArtwork(wrap(source)); assert.equal(result?.mimetype, 'image/png'); assert.deepEqual(result?.buffer, png); }
});
test('malformed, over-budget, external-linked and undecodable artwork stays absent', async () => {
    const huge = Buffer.from([73, 68, 51, 3, 0, 0, 127, 127, 127, 127]);
    const malformed = Buffer.alloc(32); malformed.write('fLaC'); malformed[4] = 0x86; malformed.writeUIntBE(24, 5, 3); malformed.writeUInt32BE(0xffffffff, 12);
    for (const source of [huge, malformed, id3(Buffer.from('https://example.invalid/cover.png')), id3(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), atom('ftyp', atom('moov', Buffer.from([0, 0, 0, 2, 109, 111, 111, 118])))]) assert.equal(await extractImportArtwork(wrap(source)), null);
});
