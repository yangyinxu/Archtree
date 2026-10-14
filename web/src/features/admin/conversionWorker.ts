import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { AudioSampleSink, BlobSource, Conversion, EncodedPacketSink, FLAC, Input, MP3, Mp3OutputFormat, Output, Quality, StreamTarget, WAVE } from 'mediabunny';
import { ConversionSourceValidationError, conversionFileByteLimit, conversionOutputSampleRate, hashConversionFile, inspectLosslessConversionSource, isValidFlacFrameCrc, readConversionBytes, type LosslessSourceEvidence } from './conversionSourceValidation';
import type { ConversionEncodingResult, ConversionWorkerFailureCode, ConversionWorkerMessage, ConversionWorkerRequest, ConversionWorkerStage } from './conversionWorkerProtocol';

const scope = globalThis as unknown as { postMessage(message: ConversionWorkerMessage): void; onmessage: ((event: MessageEvent<unknown>) => void) | null };
registerMp3Encoder();
function validationFailure(code: ConversionWorkerFailureCode): never { throw new ConversionSourceValidationError(code); }
const maximumFrameSamples = 65536;
let admitted = false;

/** Sends bounded stage progress; changing stages is explicit and no filenames or decoder errors leave the Worker. */
function reporter(taskId: string) {
  let previousStage: ConversionWorkerStage | null = null, previousProgress = 0, lastSent = 0;
  return (stage: ConversionWorkerStage, value: number) => {
    if (!Number.isFinite(value)) return;
    const changed = stage !== previousStage;
    const progress = Math.max(changed ? 0 : previousProgress, Math.min(1, Math.max(0, value)));
    const now = performance.now();
    if (!changed && progress !== 1 && now - lastSent < 50) return;
    previousStage = stage; previousProgress = progress; lastSent = now;
    scope.postMessage({ type: 'progress', taskId, stage, progress });
  };
}

/** Checks every FLAC frame and then every PCM sample; a decodable prefix is never sufficient. */
async function validateDecodedSource(input: Input, evidence: LosslessSourceEvidence, progress: (value: number) => void) {
  const tracks = await input.getAudioTracks();
  if (tracks.length !== 1 || (await input.getVideoTracks()).length) validationFailure('conversion_source_unsupported');
  const track = tracks[0], codec = await track.getCodec();
  if (evidence.codec === 'flac' ? codec !== 'flac' : !codec?.startsWith('pcm')) validationFailure('conversion_source_invalid');
  if (await track.getSampleRate() !== evidence.sampleRate || await track.getNumberOfChannels() !== evidence.channels
    || !await track.canDecode()) validationFailure('conversion_source_unsupported');
  if (evidence.codec === 'flac') {
    let coveredBytes = 0;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      if (packet.data.length > 1024 * 1024 || !isValidFlacFrameCrc(packet.data)) validationFailure('conversion_source_corrupt');
      coveredBytes += packet.data.length;
      if (coveredBytes > evidence.audioBytes) validationFailure('conversion_source_corrupt');
      progress(0.25 + 0.15 * coveredBytes / evidence.audioBytes);
    }
    if (coveredBytes !== evidence.audioBytes) validationFailure('conversion_source_incomplete');
  }
  let frames = 0, previousEnd = 0;
  for await (const sample of new AudioSampleSink(track).samples()) {
    try {
      if (sample.numberOfFrames > maximumFrameSamples || sample.sampleRate !== evidence.sampleRate || sample.numberOfChannels !== evidence.channels
        || Math.abs(sample.timestamp - previousEnd) > 1 / evidence.sampleRate + 0.00001) validationFailure('conversion_source_corrupt');
      for (let channel = 0; channel < evidence.channels; channel++) {
        const values = new Float32Array(sample.numberOfFrames);
        sample.copyTo(values, { format: 'f32-planar', planeIndex: channel });
        // Over-range float input would otherwise be silently clipped by the encoder's PCM16 bridge.
        for (const value of values) if (!Number.isFinite(value) || Math.abs(value) > 1.000001) validationFailure('conversion_source_corrupt');
      }
      frames += sample.numberOfFrames; previousEnd = sample.timestamp + sample.duration;
      if (frames > evidence.frames) validationFailure('conversion_source_corrupt');
      progress(0.4 + 0.6 * frames / evidence.frames);
    } finally { sample.close(); }
  }
  if (frames !== evidence.frames) validationFailure('conversion_source_incomplete');
}

/** Verifies encoded frame boundaries and bitrate independently of metadata or a playable prefix. */
async function verifyMp3Frames(file: File, rate: number, channels: number, progress: (value: number) => void) {
  const start = await readConversionBytes(file, 0, Math.min(file.size, 10));
  let windowOffset = 0, window: Uint8Array = new Uint8Array();
  const read = async (offset: number, length: number) => {
    if (offset < windowOffset || offset + length > windowOffset + window.length) {
      window = await readConversionBytes(file, offset, Math.min(65536, file.size - offset)); windowOffset = offset;
    }
    if (offset + length > windowOffset + window.length) validationFailure('conversion_output_invalid');
    return window.subarray(offset - windowOffset, offset - windowOffset + length);
  };
  let offset = 0, frames = 0;
  if (start[0] === 73 && start[1] === 68 && start[2] === 51) {
    if (start.length < 10 || ![2, 3, 4].includes(start[3]) || start.subarray(6, 10).some(value => value & 128)) validationFailure('conversion_output_invalid');
    offset = 10 + start[6] * 2 ** 21 + start[7] * 2 ** 14 + start[8] * 2 ** 7 + start[9] + (start[5] & 16 ? 10 : 0);
  }
  while (offset < file.size) {
    const bytes = await read(offset, 4), header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    const bitrateIndex = header >>> 12 & 15, rateIndex = header >>> 10 & 3;
    const parsedRate = [44100, 48000, 32000][rateIndex];
    if (header >>> 21 !== 0x7ff || (header >>> 19 & 3) !== 3 || (header >>> 17 & 3) !== 1 || parsedRate !== rate
      || ((header >>> 6 & 3) === 3 ? 1 : 2) !== channels || bitrateIndex === 0 || bitrateIndex === 15) validationFailure('conversion_output_invalid');
    const bitrate = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][bitrateIndex] * 1000;
    const length = Math.floor(144 * bitrate / rate) + (header >>> 9 & 1);
    if (offset + length > file.size) validationFailure('conversion_output_invalid');
    if (bitrate !== 320000) {
      // The first Xing/Info indexing frame is metadata, not an encoded audio frame.
      // Xing indexes use the MPEG side-information offset, matching the muxer's getXingOffset convention.
      const frame = await read(offset, length), marker = 4 + (channels === 1 ? 17 : 32);
      const tag = String.fromCharCode(...frame.subarray(marker, marker + 4));
      if (frames !== 0 || !['Xing', 'Info'].includes(tag)) validationFailure('conversion_output_invalid');
    }
    offset += length; frames++; progress(offset / file.size * 0.2);
  }
  if (offset !== file.size || frames < 2) validationFailure('conversion_output_invalid');
}

/** Complete output decode confirms the exact profile and bounded encoder delay/padding. */
async function verifyOutput(file: File, evidence: LosslessSourceEvidence, rate: number, progress: (value: number) => void) {
  await verifyMp3Frames(file, rate, evidence.channels, progress);
  const input = new Input({ source: new BlobSource(file, { maxCacheSize: 2 * 1024 * 1024 }), formats: [MP3] });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || await track.getCodec() !== 'mp3' || await track.getSampleRate() !== rate
      || await track.getNumberOfChannels() !== evidence.channels || !await track.canDecode()) validationFailure('conversion_output_invalid');
    let frames = 0;
    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        if (sample.numberOfFrames > maximumFrameSamples || sample.sampleRate !== rate || sample.numberOfChannels !== evidence.channels) validationFailure('conversion_output_invalid');
        for (let channel = 0; channel < sample.numberOfChannels; channel++) {
          const values = new Float32Array(sample.numberOfFrames);
          sample.copyTo(values, { format: 'f32-planar', planeIndex: channel });
          for (const value of values) if (!Number.isFinite(value)) validationFailure('conversion_output_invalid');
        }
        frames += sample.numberOfFrames;
        if (frames / rate > evidence.frames / evidence.sampleRate + 0.1) validationFailure('conversion_output_invalid');
        progress(0.2 + 0.6 * Math.min(1, frames / rate / (evidence.frames / evidence.sampleRate)));
      } finally { sample.close(); }
    }
    const durationSeconds = frames / rate;
    if (!frames || Math.abs(durationSeconds - evidence.frames / evidence.sampleRate) > 0.1) validationFailure('conversion_output_invalid');
    const outputSha256 = await hashConversionFile(file, fraction => progress(0.8 + 0.2 * fraction));
    return { outputFrames: frames, durationSeconds, outputSha256 };
  } finally { input.dispose(); }
}

/** Only writes the supplied temporary output handle; ownership, locks and cleanup remain with the runner. */
async function encode(request: ConversionWorkerRequest): Promise<ConversionEncodingResult> {
  const progress = reporter(request.taskId);
  progress('validating', 0);
  const evidence = await inspectLosslessConversionSource(request.source);
  // A small, highly compressed source can exceed the output bound; avoid hours of futile encoding.
  if (Math.ceil(evidence.frames / evidence.sampleRate * 40000) + 8192 > conversionFileByteLimit) validationFailure('conversion_storage_unavailable');
  const sourceSha256 = await hashConversionFile(request.source, fraction => progress('validating', fraction * 0.25));
  const sourceInput = new Input({ source: new BlobSource(request.source, { maxCacheSize: 2 * 1024 * 1024 }), formats: [FLAC, WAVE] });
  try { await validateDecodedSource(sourceInput, evidence, fraction => progress('validating', fraction)); }
  finally { sourceInput.dispose(); }
  const sampleRate = conversionOutputSampleRate(evidence.sampleRate);
  const writer = await request.output.createWritable();
  let closed = false;
  const input = new Input({ source: new BlobSource(request.source, { maxCacheSize: 2 * 1024 * 1024 }), formats: [FLAC, WAVE] });
  const output = new Output({ format: new Mp3OutputFormat({ xingHeader: true }), target: new StreamTarget(new WritableStream({
    async write(chunk) {
      if (!Number.isSafeInteger(chunk.position) || chunk.position < 0 || chunk.position + chunk.data.length > conversionFileByteLimit) validationFailure('conversion_storage_unavailable');
      await writer.write({ type: 'write', position: chunk.position, data: chunk.data as Uint8Array<ArrayBuffer> });
    },
    async close() { await writer.close(); closed = true; },
    async abort() { await writer.abort(); closed = true; }
  }), { chunked: true, chunkSize: 65536 }) });
  try {
    let processed = 0;
    const conversion = await Conversion.init({ input, output, tags: {}, copy: false, showWarnings: false, video: { discard: true }, audio: {
      codec: 'mp3', quality: new Quality({ bitrate: 320000, bitrateMode: 'constant' }), sampleRate,
      process(sample) { processed += sample.numberOfFrames; return sample; }
    } });
    if (!conversion.isValid || conversion.discardedTracks.length !== 0) validationFailure('conversion_encoder_unavailable');
    conversion.onProgress = fraction => progress('encoding', fraction);
    progress('encoding', 0);
    await conversion.execute();
    if (output.state !== 'finalized' || !closed || Math.abs(processed - evidence.frames * sampleRate / evidence.sampleRate) > 2) validationFailure('conversion_encoder_failed');
    const file = await request.output.getFile();
    if (!file.size) validationFailure('conversion_output_invalid');
    progress('verifying', 0);
    const verified = await verifyOutput(file, evidence, sampleRate, fraction => progress('verifying', fraction));
    progress('verifying', 1);
    return { preset: request.preset, codec: 'mp3', bitrate: 320000, sourceCodec: evidence.codec, sourceSha256, sourceBytes: request.source.size,
      sourceFrames: evidence.frames, sourceSampleRate: evidence.sampleRate, sourceChannels: evidence.channels, sourceDurationSeconds: evidence.frames / evidence.sampleRate,
      outputBytes: file.size, ...verified, sampleRate, channels: evidence.channels, resampled: sampleRate !== evidence.sampleRate };
  } finally {
    input.dispose();
    if (!closed) { try { await writer.abort(); } catch { /* Worker termination or an earlier failure may already close it. */ } }
  }
}

scope.onmessage = async ({ data }) => {
  if (admitted) return;
  const request = data as Partial<ConversionWorkerRequest>;
  if (request?.type !== 'convert' || typeof request.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(request.taskId)) return;
  admitted = true;
  if (request.preset !== 'mp3-320' || !(request.source instanceof File) || request.output?.kind !== 'file'
    || typeof request.output.createWritable !== 'function') {
    scope.postMessage({ type: 'failed', taskId: request.taskId, code: 'conversion_source_invalid' }); return;
  }
  try { scope.postMessage({ type: 'complete', taskId: request.taskId, result: await encode(request as ConversionWorkerRequest) }); }
  catch (error) {
    const code = error instanceof ConversionSourceValidationError ? error.code
      : error instanceof DOMException && ['QuotaExceededError', 'NotAllowedError', 'NotFoundError', 'InvalidStateError', 'NoModificationAllowedError'].includes(error.name)
        ? 'conversion_storage_unavailable' : 'conversion_encoder_failed';
    scope.postMessage({ type: 'failed', taskId: request.taskId, code });
  }
};
