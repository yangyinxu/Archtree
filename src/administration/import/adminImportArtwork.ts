import { open } from 'node:fs/promises';
import { maxCoverArtInputBytes, validateCoverArtFile } from '../../services/image/imageStorageService';

/** Optional tag artwork is bounded independently of the audio size; unsupported metadata stays manual. */
export async function extractImportArtwork(file: Express.Multer.File): Promise<Express.Multer.File | null> {
    const handle = file.path ? await open(file.path, 'r') : null; let bytesRead = 0, nodes = 0;
    const maxRead = Math.min(maxCoverArtInputBytes + 128 * 1024, 8 * 1024 * 1024);
    const read = async (offset: number, length: number) => {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > file.size || (bytesRead += length) > maxRead) throw new Error('Artwork scan limit');
        if (!handle) return file.buffer.subarray(offset, offset + length);
        const buffer = Buffer.alloc(length); const result = await handle.read(buffer, 0, length, offset); if (result.bytesRead !== length) throw new Error('Truncated artwork'); return buffer;
    };
    const image = async (buffer: Buffer): Promise<Express.Multer.File | null> => {
        if (!buffer.length || buffer.length > maxCoverArtInputBytes) return null;
        const mimetype = buffer[0] === 0xff && buffer[1] === 0xd8 ? 'image/jpeg' : buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
        if (!mimetype) return null;
        const candidate = { fieldname: 'file', buffer, size: buffer.length, originalname: `embedded.${mimetype.split('/')[1]}`, mimetype, encoding: '7bit' } as Express.Multer.File;
        try { await validateCoverArtFile(candidate); return candidate; } catch { return null; }
    };
    const id3 = async (offset: number) => {
        const header = await read(offset, 10); if (header.toString('ascii', 0, 3) !== 'ID3' || ![3, 4].includes(header[3]) || header[5] !== 0 || [...header.subarray(6, 10)].some(byte => byte > 127)) return null;
        const size = header[6] * 2 ** 21 + header[7] * 2 ** 14 + header[8] * 2 ** 7 + header[9]; if (size > maxRead - 10) return null;
        const tags = await read(offset + 10, size); let cursor = 0;
        while (cursor + 10 <= tags.length && nodes++ < 128) {
            const name = tags.toString('ascii', cursor, cursor + 4); if (!/^[A-Z0-9]{4}$/.test(name)) break;
            const length = header[3] === 4 ? tags[cursor + 4] * 2 ** 21 + tags[cursor + 5] * 2 ** 14 + tags[cursor + 6] * 2 ** 7 + tags[cursor + 7] : tags.readUInt32BE(cursor + 4);
            if (!length || cursor + 10 + length > tags.length) break;
            if (name === 'APIC' && tags.readUInt16BE(cursor + 8) === 0) {
                const data = tags.subarray(cursor + 10, cursor + 10 + length), encoding = data[0]; let start = data.indexOf(0, 1); if (start < 0 || start > 100 || ![0, 1, 2, 3].includes(encoding)) return null; start += 2;
                if (encoding === 0 || encoding === 3) { const end = data.indexOf(0, start); if (end < 0) return null; start = end + 1; }
                else { let end = start; while (end + 1 < data.length && (data[end] !== 0 || data[end + 1] !== 0)) end += 2; if (end + 1 >= data.length) return null; start = end + 2; }
                const candidate = await image(data.subarray(start)); if (candidate) return candidate;
            }
            cursor += 10 + length;
        }
        return null;
    };
    const mp4 = async (start: number, end: number, depth = 0): Promise<Express.Multer.File | null> => {
        if (depth > 8) return null;
        for (let offset = start; offset + 8 <= end && nodes++ < 128;) {
            const head = await read(offset, 8); let size = head.readUInt32BE(0), header = 8; const type = head.toString('ascii', 4, 8);
            if (size === 1) { const large = await read(offset + 8, 8); const value = large.readBigUInt64BE(); if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null; size = Number(value); header = 16; }
            if (size === 0) size = end - offset; if (size < header || offset + size > end) return null;
            if (type === 'covr') { const data = await read(offset + header, Math.min(size - header, 16)); if (data.length >= 16 && data.toString('ascii', 4, 8) === 'data') { const length = data.readUInt32BE(0); if (length >= 16 && length <= size - header && length - 16 <= maxCoverArtInputBytes) return image(await read(offset + header + 16, length - 16)); } }
            if (['moov', 'udta', 'meta', 'ilst'].includes(type)) { const found = await mp4(offset + header + (type === 'meta' ? 4 : 0), offset + size, depth + 1); if (found) return found; }
            offset += size;
        }
        return null;
    };
    try {
        const signature = await read(0, Math.min(12, file.size));
        if (signature.toString('ascii', 0, 3) === 'ID3') return await id3(0);
        if (signature.toString('ascii', 0, 4) === 'fLaC') {
            for (let offset = 4; offset + 4 < file.size && nodes++ < 128;) {
                const header = await read(offset, 4), length = header.readUIntBE(1, 3), type = header[0] & 127;
                if (type === 6 && length <= maxCoverArtInputBytes + 4096) { const data = await read(offset + 4, length); let cursor = 4; if (data.length < 32) return null; const mimeLength = data.readUInt32BE(cursor); cursor += 4 + mimeLength; if (cursor + 4 > data.length) return null; const descLength = data.readUInt32BE(cursor); cursor += 4 + descLength + 16; if (cursor + 4 > data.length) return null; const imageLength = data.readUInt32BE(cursor); cursor += 4; if (cursor + imageLength > data.length) return null; return image(data.subarray(cursor, cursor + imageLength)); }
                offset += 4 + length; if (header[0] & 128) break;
            }
        }
        if (signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WAVE') {
            for (let offset = 12; offset + 8 <= file.size && nodes++ < 128;) { const header = await read(offset, 8), length = header.readUInt32LE(4); if (header.toString('ascii', 0, 4).toLowerCase() === 'id3 ') return await id3(offset + 8); offset += 8 + length + length % 2; }
        }
        if (signature.toString('ascii', 4, 8) === 'ftyp') return await mp4(0, file.size);
        return null;
    } catch { return null; } finally { await handle?.close(); }
}
