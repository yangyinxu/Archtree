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
const cacheDurationMs = 5 * 60 * 1000;

const getS3StorageSummary = async (): Promise<S3StorageSummary> => {
    if (cachedSummary && cachedSummary.expiresAt > Date.now()) {
        return cachedSummary.value;
    }

    const bucket = String(process.env.S3_BUCKET_NAME ?? '').trim();
    if (!bucket) {
        throw new Error('S3_BUCKET_NAME is not configured.');
    }

    let continuationToken: string | undefined;
    let objectCount = 0;
    let totalBytes = 0;
    do {
        const page = await getS3().send(new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken
        }));
        const objects = Array.isArray(page.Contents) ? page.Contents : [];
        objectCount += objects.length;
        totalBytes += objects.reduce((sum, object) => sum + Number(object.Size ?? 0), 0);
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
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

export const loadS3StorageSummary = async (): Promise<S3StorageSummaryResult> => {
    try {
        return { summary: await getS3StorageSummary() };
    } catch (error: any) {
        const errorCode = String(error?.code ?? error?.name ?? 'UnknownError');
        console.log('Unable to load S3 storage summary:', {
            errorCode,
            message: error?.message,
            statusCode: error?.statusCode
        });
        return { summary: null, errorCode };
    }
};

export const formatStorageSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
    return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
};
