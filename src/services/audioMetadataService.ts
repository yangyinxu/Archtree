export const titleFromFileName = (fileName: string) => {
    return fileName
        .replace(/\.[^.]+$/, '')
        .trim();
};

export const formatDuration = (durationInSeconds: unknown) => {
    const totalSeconds = Math.round(Number(durationInSeconds));
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
        return '';
    }

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const minutePart = String(minutes).padStart(2, '0');
    const secondPart = String(seconds).padStart(2, '0');

    return hours > 0 ? `${hours}:${minutePart}:${secondPart}` : `${minutePart}:${secondPart}`;
};

export const inferAudioFormat = (fileName: string, mimeType: string, container?: string) => {
    const normalizedContainer = String(container ?? '').trim().toUpperCase();
    const knownContainers: Record<string, string> = {
        MPEG: 'MP3',
        'MPEG-4': 'M4A',
        WAVE: 'WAV',
        OGG: 'OGG'
    };
    if (normalizedContainer) {
        return knownContainers[normalizedContainer] ?? normalizedContainer;
    }

    const extension = fileName.split('.').pop()?.trim().toUpperCase();
    if (extension) {
        return extension === 'MPEG' ? 'MP3' : extension;
    }

    return mimeType.replace(/^audio\//i, '').toUpperCase() || 'AUDIO';
};
