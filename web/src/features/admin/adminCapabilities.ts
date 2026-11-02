import { z } from 'zod';

/** Validates private capabilities only when an administrator requests the workbench. */
export const capabilitySchema = z.object({
  schemaVersion: z.literal(1), admin: z.literal(true),
  albumImports: z.object({ enabled: z.boolean(), analysisAvailable: z.boolean(), model: z.literal('gpt-6-luna'), maxFiles: z.literal(100) }).strict(),
  catalog: z.object({ editing: z.boolean(), visibility: z.boolean() }).strict(),
  localMp3Conversion: z.object({ enabled: z.boolean(), readSources: z.boolean(), replace: z.boolean(), preset: z.literal('mp3-320'), maxFiles: z.literal(100) }).strict().optional(),
  // Optional so an older server still parses; this server always sends it.
  metadataLookup: z.object({ available: z.boolean() }).strict().optional(),
  videoUploads: z.object({ enabled: z.boolean(), maxFileBytes: z.number().int().positive(),
    acceptedExtensions: z.array(z.enum(['mp4', 'mov', 'm4v'])).length(3).refine(values => values.join(',') === 'mp4,mov,m4v')
  }).strict().optional()
}).strict();
