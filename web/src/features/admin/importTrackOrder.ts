/**
 * Approved order: Disc Number (unknown counts as 1), then Track Number (unknown last), then draft order. A module of its own so
 * the summary orders tracks without loading the approval helpers (importApproval.ts re-exports it).
 */
export function approvalTrackOrder<T extends { discNumber: number | null; trackNumber: number | null }>(tracks: readonly T[]): T[] {
  const unknownLast = (left: number | null, right: number | null) => left === right ? 0 : left === null ? 1 : right === null ? -1 : left - right;
  return tracks.map((track, index) => ({ track, index }))
    .sort((left, right) => (left.track.discNumber ?? 1) - (right.track.discNumber ?? 1) || unknownLast(left.track.trackNumber, right.track.trackNumber) || left.index - right.index)
    .map(({ track }) => track);
}
