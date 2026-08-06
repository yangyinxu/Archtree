import { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export type ByteRange = {
    start: number;
    end: number;
};

export const mediaResourceClasses = [
    'playback',
    'download',
    'artwork',
    'avatar',
    'video'
] as const;
export type MediaResourceClass = typeof mediaResourceClasses[number];
export type MediaRejectionReason = 'global' | 'perIp' | 'playbackReserved';
export type MediaResponseOutcome = 'success' | 'clientError' | 'serverError' | 'aborted' | 'other';

export interface MediaAdmissionLimitsSnapshot {
    global: number;
    perIp: number;
    playbackReservedGlobal: number;
    playbackReservedPerIp: number;
}

type MediaMetricSet = {
    acceptedRequests: number;
    activeRequests: number;
    peakActiveRequests: number;
    completedStreams: number;
    abortedStreams: number;
    failedStreams: number;
    rejectedRequests: number;
    rejectionReasons: Record<MediaRejectionReason, number>;
    responseOutcomes: Record<MediaResponseOutcome, number>;
};

export interface MediaDeliveryMetricsSnapshot extends MediaMetricSet {
    limits: MediaAdmissionLimitsSnapshot;
    byResource: Record<MediaResourceClass, MediaMetricSet>;
}

export interface MediaDeliveryMetricsRegistry {
    setAdmissionLimits(limits: MediaAdmissionLimitsSnapshot): void;
    markRequestAccepted(resourceClass: MediaResourceClass): void;
    markRequestFinished(resourceClass: MediaResourceClass, outcome: MediaResponseOutcome): void;
    markRequestRejected(resourceClass: MediaResourceClass, reason: MediaRejectionReason): void;
    markStreamCompleted(resourceClass: MediaResourceClass): void;
    markStreamAborted(resourceClass: MediaResourceClass): void;
    markStreamFailed(resourceClass: MediaResourceClass): void;
    snapshot(): MediaDeliveryMetricsSnapshot;
}

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

const emptyMetricSet = (): MediaMetricSet => ({
    acceptedRequests: 0,
    activeRequests: 0,
    peakActiveRequests: 0,
    completedStreams: 0,
    abortedStreams: 0,
    failedStreams: 0,
    rejectedRequests: 0,
    rejectionReasons: {
        global: 0,
        perIp: 0,
        playbackReserved: 0
    },
    responseOutcomes: {
        success: 0,
        clientError: 0,
        serverError: 0,
        aborted: 0,
        other: 0
    }
});

const copyMetricSet = (metrics: MediaMetricSet): MediaMetricSet => ({
    ...metrics,
    rejectionReasons: { ...metrics.rejectionReasons },
    responseOutcomes: { ...metrics.responseOutcomes }
});

/** Owns bounded, identity-free counters for one application media runtime. */
export const createMediaDeliveryMetricsRegistry = (): MediaDeliveryMetricsRegistry => {
    const total = emptyMetricSet();
    const byResource = Object.fromEntries(
        mediaResourceClasses.map((resourceClass) => [resourceClass, emptyMetricSet()])
    ) as Record<MediaResourceClass, MediaMetricSet>;
    let limits: MediaAdmissionLimitsSnapshot = {
        global: 0,
        perIp: 0,
        playbackReservedGlobal: 0,
        playbackReservedPerIp: 0
    };

    const updateBoth = (
        resourceClass: MediaResourceClass,
        update: (metrics: MediaMetricSet) => void
    ) => {
        update(total);
        update(byResource[resourceClass]);
    };

    return {
        setAdmissionLimits(nextLimits) {
            limits = { ...nextLimits };
        },
        markRequestAccepted(resourceClass) {
            updateBoth(resourceClass, (metrics) => {
                metrics.acceptedRequests += 1;
                metrics.activeRequests += 1;
                metrics.peakActiveRequests = Math.max(
                    metrics.peakActiveRequests,
                    metrics.activeRequests
                );
            });
        },
        markRequestFinished(resourceClass, outcome) {
            updateBoth(resourceClass, (metrics) => {
                metrics.activeRequests = Math.max(0, metrics.activeRequests - 1);
                metrics.responseOutcomes[outcome] += 1;
            });
        },
        markRequestRejected(resourceClass, reason) {
            updateBoth(resourceClass, (metrics) => {
                metrics.rejectedRequests += 1;
                metrics.rejectionReasons[reason] += 1;
            });
        },
        markStreamCompleted(resourceClass) {
            updateBoth(resourceClass, (metrics) => {
                metrics.completedStreams += 1;
            });
        },
        markStreamAborted(resourceClass) {
            updateBoth(resourceClass, (metrics) => {
                metrics.abortedStreams += 1;
            });
        },
        markStreamFailed(resourceClass) {
            updateBoth(resourceClass, (metrics) => {
                metrics.failedStreams += 1;
            });
        },
        snapshot() {
            return {
                ...copyMetricSet(total),
                limits: { ...limits },
                byResource: Object.fromEntries(
                    mediaResourceClasses.map((resourceClass) => [
                        resourceClass,
                        copyMetricSet(byResource[resourceClass])
                    ])
                ) as Record<MediaResourceClass, MediaMetricSet>
            };
        }
    };
};

export const defaultMediaDeliveryMetrics = createMediaDeliveryMetricsRegistry();

export const getMediaDeliveryMetrics = () => defaultMediaDeliveryMetrics.snapshot();

// Retain the original aggregate hooks for callers outside the classified middleware.
export const markMediaRequestStarted = (resourceClass: MediaResourceClass = 'playback') => {
    defaultMediaDeliveryMetrics.markRequestAccepted(resourceClass);
};

export const markMediaRequestFinished = (resourceClass: MediaResourceClass = 'playback') => {
    defaultMediaDeliveryMetrics.markRequestFinished(resourceClass, 'other');
};

export const markMediaRequestRejected = (resourceClass: MediaResourceClass = 'playback') => {
    defaultMediaDeliveryMetrics.markRequestRejected(resourceClass, 'global');
};

type MediaDeliveryResponseLocals = {
    resourceClass: MediaResourceClass;
    metrics: MediaDeliveryMetricsRegistry;
};

const metricsForResponse = (res: Response): MediaDeliveryResponseLocals => {
    const candidate = res.locals?.mediaDelivery as MediaDeliveryResponseLocals | undefined;
    if (candidate && mediaResourceClasses.includes(candidate.resourceClass)) {
        return candidate;
    }
    return {
        resourceClass: 'playback',
        metrics: defaultMediaDeliveryMetrics
    };
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
    const delivery = metricsForResponse(res);
    context.attachSource(stream);
    try {
        await pipeline(stream, res);
        delivery.metrics.markStreamCompleted(delivery.resourceClass);
    } catch (error) {
        if (context.aborted || req.aborted) {
            delivery.metrics.markStreamAborted(delivery.resourceClass);
            return;
        }
        delivery.metrics.markStreamFailed(delivery.resourceClass);
        throw error;
    } finally {
        context.cleanup();
    }
};
