import { measureDecodedAudio, RoomAudioInspectionError, type DecodedAudioDemuxer } from './roomAudioInspectionDecoder';
import { boundedDuration, InvalidRoomAudio, maximumRoomAudioBytes, RoomAudioReader } from './roomAudioInspectionReader';

/**
 * Chooses the one demuxer a source's leading bytes name: FLAC (also behind an ID3v2 tag), AIFF/AIFC, RIFF WAVE, or an
 * MP4 family file such as ALAC in M4A. Anything else, including MP3, is left to room inspection alone.
 */
const demuxerFor = async (reader: RoomAudioReader): Promise<DecodedAudioDemuxer | null> => {
    const prefix = await reader.read(0, 12);
    const at = (offset: number, text: string) => prefix.toString('latin1', offset, offset + text.length) === text;
    if (at(0, 'fLaC')) return 'flac';
    if (at(0, 'FORM') && (at(8, 'AIFF') || at(8, 'AIFC'))) return 'aiff';
    if (at(0, 'RIFF') && at(8, 'WAVE')) return 'wav';
    if (at(4, 'ftyp')) return 'mov';
    if (at(0, 'ID3') && prefix.subarray(6, 10).every(byte => byte < 0x80)) {
        // Some taggers put an ID3v2 tag before the FLAC stream marker; its syncsafe size (plus an optional footer) skips it.
        const tagBytes = 10 + prefix.subarray(6, 10).reduce((size, byte) => size * 128 + byte, 0) + (prefix[5] & 0x10 ? 10 : 0);
        if (tagBytes + 4 <= reader.size && (await reader.read(tagBytes, 4)).toString('latin1') === 'fLaC') return 'flac';
    }
    return null;
};

/**
 * Measures the exact decoded duration of audio that room inspection does not support, such as FLAC, ALAC, AIFF and
 * high-resolution WAV. The result is catalog evidence only (metadata lookup compares it with release tracks); it never
 * makes a source seekable or eligible for rooms. Unrecognized or undecodable bytes return null; decoder faults, timeouts
 * and capacity remain retryable RoomAudioInspectionErrors, and cancellation rethrows, exactly as in room inspection.
 */
export const probeAudioDurationMs = async (
    file: Pick<Express.Multer.File, 'size' | 'path' | 'buffer'>,
    options: { signal?: AbortSignal } = {}
): Promise<number | null> => {
    let reader: RoomAudioReader | undefined;
    try {
        reader = await RoomAudioReader.create(file, options.signal);
        if (file.size > maximumRoomAudioBytes) return null;
        const demuxer = await demuxerFor(reader);
        if (!demuxer) return null;
        const durationMs = boundedDuration(await measureDecodedAudio(file, demuxer, options.signal));
        await reader.verifyUnchanged();
        return durationMs;
    } catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof RoomAudioInspectionError) throw error;
        if (error instanceof InvalidRoomAudio || error instanceof RangeError) return null;
        throw new RoomAudioInspectionError('analysis_failed');
    } finally { await reader?.close(); }
};
