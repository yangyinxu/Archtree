import { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export type ByteRange = {
    start: number;
    end: number;
};

/** Honors resumable byte ranges only when the supplied entity validator matches. */
export const shouldHonorRange = (
    ifRangeHeader: string | undefined,
    currentEtag: string | undefined
) => {
    if (!ifRangeHeader) return true;
    if (!currentEtag || ifRangeHeader.startsWith('W/')) return false;
    return ifRangeHeader.trim() === currentEtag.trim();
};

/** Builds a safe attachment header without allowing filenames to inject headers or paths. */
export const attachmentContentDisposition = (
    requestedFilename: string | undefined,
    fallbackId: string
) => {
    const normalized = String(requestedFilename ?? '')
        .replace(/[\r\n\\/\0"]/g, '_')
        .trim()
        .slice(0, 180);
    const filename = normalized || `${fallbackId}.mp3`;
    const asciiFilename = filename
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/["\\]/g, '_');
    return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

type MediaMetrics = {
    activeRequests: number;
    peakActiveRequests: number;
    completedStreams: number;
    abortedStreams: number;
    failedStreams: number;
    rejectedRequests: number;
};

const metrics: MediaMetrics = {
    activeRequests: 0,
    peakActiveRequests: 0,
    completedStreams: 0,
    abortedStreams: 0,
    failedStreams: 0,
    rejectedRequests: 0
};

export const getMediaDeliveryMetrics = () => ({ ...metrics });

export const markMediaRequestStarted = () => {
    metrics.activeRequests += 1;
    metrics.peakActiveRequests = Math.max(metrics.peakActiveRequests, metrics.activeRequests);
};

export const markMediaRequestFinished = () => {
    metrics.activeRequests = Math.max(0, metrics.activeRequests - 1);
};

export const markMediaRequestRejected = () => {
    metrics.rejectedRequests += 1;
};

export const parseSingleByteRange = (
    rangeHeader: string,
    fileSize: number,
    maximumBytes: number
): ByteRange | null => {
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || rangeHeader.includes(',')) {
        return null;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match || (!match[1] && !match[2])) {
        return null;
    }

    let start: number;
    let end: number;
    const boundedMaximum = Math.max(1, Math.floor(maximumBytes));
    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
        start = Math.max(0, fileSize - Math.min(suffixLength, boundedMaximum));
        end = fileSize - 1;
    } else {
        start = Number(match[1]);
        const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0) {
            return null;
        }
        if (start >= fileSize || requestedEnd < start) {
            return null;
        }
        end = Math.min(requestedEnd, fileSize - 1);
    }

    end = Math.min(end, start + boundedMaximum - 1);
    return { start, end };
};

export const createMediaAbortContext = (req: Request, res: Response) => {
    const controller = new AbortController();
    let source: Readable | null = null;
    let aborted = false;

    const abort = () => {
        if (aborted || res.writableEnded) return;
        aborted = true;
        controller.abort();
        source?.destroy();
    };
    const onRequestAborted = () => abort();
    const onResponseClose = () => {
        if (!res.writableEnded) abort();
    };

    req.once('aborted', onRequestAborted);
    res.once('close', onResponseClose);

    return {
        signal: controller.signal,
        get aborted() {
            return aborted;
        },
        attachSource(stream: Readable) {
            source = stream;
            if (aborted) {
                stream.destroy();
            }
        },
        cleanup() {
            req.off('aborted', onRequestAborted);
            res.off('close', onResponseClose);
        }
    };
};

export const pipeMediaStream = async (
    req: Request,
    res: Response,
    stream: Readable,
    context: ReturnType<typeof createMediaAbortContext>
) => {
    context.attachSource(stream);
    try {
        await pipeline(stream, res);
        metrics.completedStreams += 1;
    } catch (error) {
        if (context.aborted || req.aborted) {
            metrics.abortedStreams += 1;
            return;
        }
        metrics.failedStreams += 1;
        throw error;
    } finally {
        context.cleanup();
    }
};
