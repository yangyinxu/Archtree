import { S3Client } from '@aws-sdk/client-s3';

let s3Client: S3Client | null = null;

// Create the client lazily so environment variables have been loaded first.
export const getS3 = (): S3Client => {
  if (!s3Client) {
    s3Client = new S3Client({
      region: process.env.AWS_REGION
    });
  }

  return s3Client;
};
