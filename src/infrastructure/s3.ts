import { S3Client } from '@aws-sdk/client-s3';

let s3Client: S3Client | null = null;

const positiveNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Create the client lazily so environment variables have been loaded first.
export const getS3 = (): S3Client => {
  if (!s3Client) {
    s3Client = new S3Client({
      region: process.env.AWS_REGION,
      maxAttempts: positiveNumber(process.env.S3_MAX_ATTEMPTS, 2),
      requestHandler: {
        connectionTimeout: positiveNumber(process.env.S3_CONNECTION_TIMEOUT_MS, 5_000),
        requestTimeout: positiveNumber(process.env.S3_REQUEST_TIMEOUT_MS, 60_000)
      }
    });
  }

  return s3Client;
};
