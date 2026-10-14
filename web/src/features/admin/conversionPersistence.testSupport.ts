import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { adminWorkspace } from './adminWorkspace';
import { captureAccountOperation } from '../../api/accountEpoch';
import type { ConversionPersistence, ConversionBatch } from './conversionStore';
import type { ConversionManifest } from './conversionApi';
import { hashConversionFile } from './conversionSourceValidation';
import type { ConversionEncodingResult } from './conversionWorkerProtocol';

export const owner = '111111111111111111111111';
export const ownerB = '222222222222222222222222';
export const authorize = (viewer = owner, conversion = true) => {
  adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true, undefined, { editing: true, visibility: true }, conversion);
  adminWorkspace.select('admin'); return adminWorkspace.capture();
};
export const installFiles = () => { vi.stubGlobal('File', NodeFile); vi.stubGlobal('Blob', NodeBlob); };
export const file = (value: number[] = Array.from({ length: 64 }, (_, index) => index), name = 'Lorem.wav') => new NodeFile([Uint8Array.from(value)], name, { type: 'audio/wav' }) as unknown as File;
export const manifest = (count = 1): ConversionManifest => ({ schemaVersion: 1,
  album: { id: '333333333333333333333333', title: 'Lorem Album', revision: `cr_${'a'.repeat(43)}`, membershipRevision: `cm_${'b'.repeat(43)}` },
  tracks: Array.from({ length: count }, (_, index) => ({ id: index.toString(16).padStart(24, '0'), albumId: '333333333333333333333333', revision: `cr_${'c'.repeat(43)}`,
    sourceRevision: `mr_${'d'.repeat(32)}`, title: `Lorem ${index}`, originalFileName: `Lorem ${index}.flac`,
    format: { container: 'FLAC', codec: 'FLAC', lossless: true, sampleRate: 44100, channels: 1, bitDepth: 16, duration: 1 },
    mediaUrl: `/api/admin/v1/catalog/audioTrack/${index.toString(16).padStart(24, '0')}/media` })) });
export const locks = () => {
  const held = new Set<string>();
  return { request: async (name: string, options: unknown, callback?: (lock: Lock | null) => unknown) => {
    const run = typeof options === 'function' ? options as (lock: Lock | null) => unknown : callback!;
    if (held.has(name)) return run(null); held.add(name);
    try { return await run({ name, mode: 'exclusive' } as Lock); } finally { held.delete(name); }
  }, query: async () => ({ held: [...held].map(name => ({ name, mode: 'exclusive' as const })), pending: [] }) } as unknown as LockManager;
};
export const memoryPersistence = () => {
  const batches = new Map<string, unknown>(), files = new Map<string, Uint8Array<ArrayBuffer>>();
  let writes = 0, closes = 0;
  const fault = { write: 0, close: 0, commit: false, remove: false, onWrite: undefined as (() => void) | undefined };
  const key = (ownerId: string, id: string) => `${ownerId}:${id}`;
  const fileKey = (ownerId: string, id: string, kind: string) => `${key(ownerId, id)}:${kind}`;
  const persistence: ConversionPersistence = {
    supported: () => true,
    list: async viewer => [...batches.values()].filter(row => (row as ConversionBatch).ownerId === viewer).map(row => structuredClone(row)),
    get: async (viewer, id) => structuredClone(batches.get(key(viewer, id))),
    create: async batch => { if (fault.commit) throw new Error('Synthetic commit'); batches.set(key(batch.ownerId, batch.id), structuredClone(batch)); },
    mutate: async (viewer, id, update) => { if (fault.commit) throw new Error('Synthetic commit'); batches.set(key(viewer, id), structuredClone(update(structuredClone(batches.get(key(viewer, id)))))); },
    file: async (viewer, id, kind, create) => {
      const name = fileKey(viewer, id, kind);
      if (!files.has(name)) { if (!create) throw new DOMException('Synthetic missing', 'NotFoundError'); files.set(name, new Uint8Array()); }
      return { kind: 'file', name: kind,
        getFile: async () => new NodeFile([files.get(name)!], `${kind}.bin`) as unknown as File,
        createWritable: async (options?: FileSystemCreateWritableOptions) => {
          let pending = options?.keepExistingData ? new Uint8Array(files.get(name)!) : new Uint8Array(), position = 0;
          return { seek: async (value: number) => { position = value; },
            write: async (input: Blob | Uint8Array<ArrayBuffer>) => { if (++writes === fault.write) throw new Error('Synthetic write'); fault.onWrite?.();
              const value = input instanceof NodeBlob ? new Uint8Array(await input.arrayBuffer()) : new Uint8Array(input as Uint8Array);
              const next = new Uint8Array(Math.max(pending.length, position + value.length)); next.set(pending); next.set(value, position); pending = next; position += value.length; },
            close: async () => { if (++closes === fault.close) throw new Error('Synthetic close'); files.set(name, pending); }, abort: async () => undefined
          } as unknown as FileSystemWritableFileStream;
        }
      } as FileSystemFileHandle;
    },
    removeOutput: async (viewer, id) => { if (fault.remove) throw new Error('Synthetic remove'); files.delete(fileKey(viewer, id, 'output')); },
    estimate: async () => ({ usage: 0, quota: 1024 ** 4 }), persist: async () => true
  };
  return { persistence, batches, files, fault, key, fileKey };
};
export const encoding = async (source: File, output: File): Promise<ConversionEncodingResult> => ({ preset: 'mp3-320', codec: 'mp3', bitrate: 320000,
  sourceCodec: 'wav-pcm', sourceSha256: await hashConversionFile(source), sourceBytes: source.size, sourceFrames: 44100, sourceSampleRate: 44100,
  sourceChannels: 1, sourceDurationSeconds: 1, outputSha256: await hashConversionFile(output), outputBytes: output.size,
  outputFrames: 44100, sampleRate: 44100, channels: 1, durationSeconds: 1, resampled: false });
