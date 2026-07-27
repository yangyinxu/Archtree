import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getS3 } from '../infrastructure/s3';

export type S3StorageSummary = {
    objectCount: number;
    totalBytes: number;
    estimatedMonthlyStorageCost: number;
    storageCostPerGbMonth: number;
};

export type S3StorageSummaryResult = {
    summary: S3StorageSummary | null;
    errorCode?: string;
};

let cachedSummary: { value: S3StorageSummary; expiresAt: number } | null = null;
let inFlightSummary: Promise<S3StorageSummary> | null = null;
const cacheDurationMs = 5 * 60 * 1000;
const configuredSummaryObjectLimit = Number(process.env.MAX_STORAGE_SUMMARY_OBJECTS ?? 1_000_000);
const summaryObjectLimit = Number.isFinite(configuredSummaryObjectLimit) && configuredSummaryObjectLimit > 0
    ? Math.floor(configuredSummaryObjectLimit)
    : 1_000_000;

const calculateS3StorageSummary = async (): Promise<S3StorageSummary> => {
    const bucket = String(process.env.S3_BUCKET_NAME ?? '').trim();
    if (!bucket) {
        throw new Error('S3_BUCKET_NAME is not configured.');
    }

    let continuationToken: string | undefined;
    const seenContinuationTokens = new Set<string>();
    let objectCount = 0;
    let totalBytes = 0;
    do {
        const page = await getS3().send(new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken
        }));
        const objects = Array.isArray(page.Contents) ? page.Contents : [];
        objectCount += objects.length;
        if (objectCount > summaryObjectLimit) {
            throw new Error(`Storage summary exceeds the ${summaryObjectLimit} object safety limit.`);
        }
        totalBytes += objects.reduce((sum, object) => sum + Number(object.Size ?? 0), 0);
        const nextToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (nextToken && seenContinuationTokens.has(nextToken)) {
            throw new Error('S3 returned a repeated continuation token while calculating storage usage.');
        }
        if (nextToken) seenContinuationTokens.add(nextToken);
        continuationToken = nextToken;
    } while (continuationToken);

    const configuredRate = Number(process.env.S3_STORAGE_COST_PER_GB_MONTH ?? 0.023);
    const storageCostPerGbMonth = Number.isFinite(configuredRate) && configuredRate >= 0
        ? configuredRate
        : 0.023;
    const summary = {
        objectCount,
        totalBytes,
        estimatedMonthlyStorageCost: (totalBytes / (1024 ** 3)) * storageCostPerGbMonth,
        storageCostPerGbMonth
    };
    cachedSummary = {
        value: summary,
        expiresAt: Date.now() + cacheDurationMs
    };

    return summary;
};

const getS3StorageSummary = async (): Promise<S3StorageSummary> => {
    if (cachedSummary && cachedSummary.expiresAt > Date.now()) {
        return cachedSummary.value;
    }
    if (inFlightSummary) return inFlightSummary;

    inFlightSummary = calculateS3StorageSummary();
    try {
        return await inFlightSummary;
    } finally {
        inFlightSummary = null;
    }
};

export const loadS3StorageSummary = async (): Promise<S3StorageSummaryResult> => {
    if (inFlightSummary && (!cachedSummary || cachedSummary.expiresAt <= Date.now())) {
        return { summary: null, errorCode: 'SummaryRefreshInProgress' };
    }

    const configuredWaitTimeout = Number(process.env.S3_SUMMARY_WAIT_TIMEOUT_MS ?? 2_000);
    const waitTimeoutMs = Number.isFinite(configuredWaitTimeout) && configuredWaitTimeout > 0
        ? Math.floor(configuredWaitTimeout)
        : 2_000;
    let timeout: NodeJS.Timeout | undefined;
    try {
        const summary = await Promise.race([
            getS3StorageSummary(),
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                    () => reject(Object.assign(new Error('S3 storage summary timed out.'), { code: 'SummaryTimeout' })),
                    waitTimeoutMs
                );
            })
        ]);
        return { summary };
    } catch (error: any) {
        const errorCode = String(error?.code ?? error?.name ?? 'UnknownError');
        console.log('Unable to load S3 storage summary:', {
            errorCode,
            message: error?.message,
            statusCode: error?.statusCode
        });
        return { summary: null, errorCode };
    } finally {
        if (timeout) clearTimeout(timeout);
    }
};

export const formatStorageSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
    return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
};
