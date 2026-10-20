import type { ImportDetail } from './adminApi';

/** The slot's current asset; a deleted asset no longer occupies the slot. */
export const liveAsset = (item: ImportDetail, slotId: string) => item.assets.find(asset => asset.slotId === slotId && asset.state !== 'deleted');
/** Staged sources stay locked while a publication is active or its cancelled cleanup is pending. */
export const uploadPublicationLocked = (item: ImportDetail) => ['preparing', 'needsAttention', 'complete'].includes(item.publication)
  || (item.publication === 'cancelled' && Boolean(item.publicationRecovery?.cleanupPending));

/** Reselected files resume only incomplete slots whose relative path and size both match the saved manifest. */
export function matchReselection(item: ImportDetail, files: readonly File[]): { matched: Record<string, File>; mismatched: string[] } {
  const matched: Record<string, File> = {}, mismatched: string[] = [];
  for (const file of files) {
    const path = file.webkitRelativePath || file.name, entry = item.manifest.files.find(entry => entry.relativePath === path);
    if (!entry) { if (/\.(mp3|m4a|aac|wav|flac|ogg|opus|aif|aiff)$/iu.test(file.name)) mismatched.push(path); continue; }
    if (liveAsset(item, entry.slotId)?.state === 'ready') continue;
    if (file.size < 1 || entry.byteLength !== null && entry.byteLength !== file.size) mismatched.push(path); else matched[entry.slotId] = file;
  }
  return { matched, mismatched };
}
