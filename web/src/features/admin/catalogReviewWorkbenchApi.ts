import { z } from 'zod';
import { reviewWorkbenchSchema as queueSchema } from './catalogReviewApi';
import { lookupBriefSchema } from './lookupBrief';

const item = queueSchema.shape.items.element;
/**
 * The Album completions queue (GET /catalog-reviews) as the workbench reads it: each item also carries `lookup`, the review's
 * lookup brief, absent from a server before lookup briefs and null without a readable run.
 */
export const reviewWorkbenchSchema = z.object({ ...queueSchema.shape,
  items: z.array(z.object({ ...item.shape, lookup: lookupBriefSchema.nullable().optional() }).strict()).max(25) }).strict();
