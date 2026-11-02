import { z } from 'zod';
import { revision } from './catalogRevision';

/** The Grid read is complete so a save can bind every Video identity and its eligibility snapshot. */
const grid = z.object({
  revision,
  defaultView: z.enum(['grid', 'immersive']),
  items: z.array(z.object({
    id: z.string().regex(/^[a-f0-9]{24}$/), title: z.string(), coverUrl: z.string().nullable(), creator: z.string().nullable()
  }).strict()).max(5_000)
}).strict().refine(value => new Set(value.items.map(item => item.id)).size === value.items.length);

export const videoGridResponse = z.object({ grid }).strict();
export const videoGridMutationResponse = z.object({ grid, receipt: z.object({ operationId: z.string() }).strict() }).strict();
export type AdminVideoGrid = z.infer<typeof grid>;
