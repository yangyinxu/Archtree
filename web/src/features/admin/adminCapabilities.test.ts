import { capabilitySchema } from './adminCapabilities';

/** The server's capabilities (src/administration/adminCapabilityService.ts) with imports and lookup configured. */
const server = {
  schemaVersion: 1, admin: true,
  albumImports: { enabled: true, analysisAvailable: true, model: 'gpt-6-luna', maxFiles: 100 },
  catalog: { editing: true, visibility: true },
  localMp3Conversion: { enabled: true, readSources: true, replace: true, preset: 'mp3-320', maxFiles: 100 },
  metadataLookup: { available: true }
};

test('the server capabilities parse with and without metadata lookup, and lookup carries only its availability', () => {
  expect(capabilitySchema.parse(server).metadataLookup).toEqual({ available: true });
  const { metadataLookup: _lookup, ...older } = server;
  expect(capabilitySchema.parse(older).metadataLookup).toBeUndefined();
  expect(capabilitySchema.safeParse({ ...server, metadataLookup: { available: false } }).success).toBe(true);
  expect(capabilitySchema.safeParse({ ...server, metadataLookup: { available: true, contact: 'operator@example.invalid' } }).success).toBe(false);
  expect(capabilitySchema.safeParse({ ...server, metadataLookup: { available: 'yes' } }).success).toBe(false);
  expect(capabilitySchema.safeParse({ ...server, metadataLookup: {} }).success).toBe(false);
  expect(capabilitySchema.safeParse({ ...server, lookup: { available: true } }).success).toBe(false);
});

test('Video capabilities are optional for older servers and expose only safe admission limits', () => {
  const videoUploads = { enabled: false, maxFileBytes: 512 * 1024 ** 2, acceptedExtensions: ['mp4', 'mov', 'm4v'] };
  expect(capabilitySchema.parse({ ...server, videoUploads }).videoUploads).toEqual(videoUploads);
  expect(capabilitySchema.safeParse({ ...server, videoUploads: { ...videoUploads, bucket: 'private' } }).success).toBe(false);
  expect(capabilitySchema.safeParse({ ...server, videoUploads: { ...videoUploads, maxFileBytes: 0 } }).success).toBe(false);
  for (const acceptedExtensions of [['mov', 'mp4', 'm4v'], ['mp4', 'mov', 'm4v', 'avi'], ['mp4', 'mov']]) expect(capabilitySchema.safeParse({ ...server, videoUploads: { ...videoUploads, acceptedExtensions } }).success).toBe(false);
});
