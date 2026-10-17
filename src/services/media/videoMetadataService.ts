import {
    parseBuffer,
    parseFile,
    type IAudioMetadata
} from 'music-metadata';

export interface ValidatedSoundtrackVideoMetadata {
    contentType: 'video/mp4';
    durationSeconds: number | null;
}

export class InvalidSoundtrackVideoError extends Error {
    readonly statusCode = 400;
    readonly code = 'invalid_soundtrack_video';
}

const codecDescription = (metadata: IAudioMetadata) => [
    metadata.format.codec,
    ...metadata.format.trackInfo.map((track) => track.codecName)
].filter(Boolean).join(' ');

const hasSupportedMp4Container = (container: string) => container
    .split(/[\s/,]+/)
    .some(brand => /^(?:mp4[0-9a-z]*|mpeg-?4|m4v|isom)$/i.test(brand));

/** Validates parsed metadata against the one interoperable Web/iOS v1 profile. */
export const validateParsedSoundtrackVideo = (
    metadata: IAudioMetadata
): ValidatedSoundtrackVideoMetadata => {
    const container = String(metadata.format.container ?? '');
    const codecs = codecDescription(metadata);
    const hasMp4Container = hasSupportedMp4Container(container);
    const hasAudio = metadata.format.hasAudio === true;
    const hasVideo = metadata.format.hasVideo === true;
    const hasAvcVideo = /avc1|avc3|h\.?264|\bavc\b/i.test(codecs);
    const hasAacAudio = /aac|mp4a/i.test(codecs);

    if (!hasMp4Container || !hasAudio || !hasVideo || !hasAvcVideo || !hasAacAudio) {
        throw new InvalidSoundtrackVideoError(
            'Video must be a playable MP4 containing H.264/AVC video and AAC audio.'
        );
    }

    const duration = Number(metadata.format.duration);
    return {
        contentType: 'video/mp4',
        durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null
    };
};

type VideoMetadataParser = (uploadFile: Express.Multer.File) => Promise<IAudioMetadata>;

const defaultVideoMetadataParser: VideoMetadataParser = async (uploadFile) => {
    if (uploadFile.path) {
        return parseFile(uploadFile.path, { duration: true, skipCovers: true });
    }
    if (uploadFile.buffer?.length) {
        return parseBuffer(
            Uint8Array.from(uploadFile.buffer),
            { mimeType: uploadFile.mimetype || 'video/mp4', size: uploadFile.size },
            { duration: true, skipCovers: true }
        );
    }
    throw new InvalidSoundtrackVideoError('The uploaded video file is empty.');
};

/** Parses the actual file rather than trusting its multipart MIME type or name. */
export const validateSoundtrackVideoFile = async (
    uploadFile: Express.Multer.File,
    parser: VideoMetadataParser = defaultVideoMetadataParser
) => {
    if (!Number.isSafeInteger(uploadFile.size) || uploadFile.size <= 0) {
        throw new InvalidSoundtrackVideoError('The uploaded video file is empty.');
    }
    if (String(uploadFile.mimetype ?? '').toLowerCase() !== 'video/mp4') {
        throw new InvalidSoundtrackVideoError('Only MP4 video uploads are supported.');
    }
    try {
        return validateParsedSoundtrackVideo(await parser(uploadFile));
    } catch (error) {
        if (error instanceof InvalidSoundtrackVideoError) throw error;
        throw new InvalidSoundtrackVideoError('The uploaded MP4 could not be decoded safely.');
    }
};
