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
