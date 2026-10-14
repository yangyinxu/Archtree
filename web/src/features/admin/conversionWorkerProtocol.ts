/** Conversion runs once per dedicated Worker; the runner owns cancellation and durable task state. */
export interface ConversionWorkerRequest {
  type: 'convert';
  taskId: string;
  source: File;
  output: FileSystemFileHandle;
  preset: 'mp3-320';
}

export const conversionWorkerFailureCodes = [
  'conversion_source_invalid', 'conversion_source_unsupported', 'conversion_source_incomplete',
  'conversion_source_corrupt', 'conversion_storage_unavailable', 'conversion_encoder_unavailable',
  'conversion_encoder_failed', 'conversion_output_invalid', 'conversion_cancelled'
] as const;
export type ConversionWorkerFailureCode = typeof conversionWorkerFailureCodes[number];
export type ConversionWorkerStage = 'validating' | 'encoding' | 'verifying';

/** Measured source and verified output facts bind a temporary result to its immutable encoding profile. */
export interface ConversionEncodingResult {
  preset: 'mp3-320';
  codec: 'mp3';
  bitrate: 320000;
  sourceCodec: 'flac' | 'wav-pcm' | 'wav-float';
  sourceSha256: string;
  sourceBytes: number;
  sourceFrames: number;
  sourceSampleRate: number;
  sourceChannels: number;
  sourceDurationSeconds: number;
  outputSha256: string;
  outputBytes: number;
  outputFrames: number;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  resampled: boolean;
}

export type ConversionWorkerMessage =
  | { type: 'progress'; taskId: string; stage: ConversionWorkerStage; progress: number }
  | { type: 'complete'; taskId: string; result: ConversionEncodingResult }
  | { type: 'failed'; taskId: string; code: ConversionWorkerFailureCode };
