import { catalogItemSchema, catalogPatch } from './catalogApi';
import { suggestionSchema, detailSchema } from './adminApi';
import { detail, slotId } from './adminFixtures.testSupport';
export const catalogAlbum = () => ({ kind: 'album' as const, id: '111111111111111111111111', revision: `cr_${'a'.repeat(43)}`, visibility: 'public' as const, effectiveVisibility: 'public' as const, coverUrl: null, mediaUrl: null, capabilities: { editing: true, visibility: true }, fields: { title: 'Synthetic catalog Album', releaseDate: null, credits: null, attributionStatus: 'unknown' as const } });
test('catalog edits preserve unrelated fields and Credits plus attribution are an atomic group', () => {
  const item = catalogAlbum();
  expect(catalogPatch(item, { ...item.fields, title: 'Changed title' }, 'public')).toEqual({ expectedRevision: item.revision, fields: { title: 'Changed title' } });
  expect(catalogPatch(item, { ...item.fields, credits: [], attributionStatus: 'documented' }, 'hidden')).toEqual({ expectedRevision: item.revision, fields: { credits: [], attributionStatus: 'documented' }, visibility: 'hidden' });
  expect(catalogPatch(item, item.fields, 'hidden')).not.toHaveProperty('fields');
});
test('protected projections reject external previews and invalid calendar precision', () => {
  const item = catalogAlbum();
  expect(catalogItemSchema.safeParse(item).success).toBe(true);
  expect(catalogItemSchema.safeParse({ ...item, coverUrl: 'https://foreign.invalid/private' }).success).toBe(false);
  expect(catalogItemSchema.safeParse({ ...item, fields: { ...item.fields, releaseDate: { year: 2025, month: 2, day: 29 } } }).success).toBe(false);
  expect(catalogItemSchema.safeParse({ ...item, fields: { ...item.fields, releaseDate: { year: 2024, month: null, day: 1 } } }).success).toBe(false);
});
test('suggestions and embedded covers cannot address another file or mix field types', () => {
  const item = detail();
  expect(suggestionSchema.safeParse({ ...item.suggestions[0], value: 42 }).success).toBe(false);
  expect(detailSchema.safeParse({ ...item, selectedCoverSlotId: `embedded-${slotId}` }).success).toBe(false);
  expect(detailSchema.safeParse({ ...item, assets: [{ slotId: 'arbitrary', state: 'ready', sha256: 'a'.repeat(64), byteLength: 1, contentType: 'audio/mpeg', tags: null }] }).success).toBe(false);
});
