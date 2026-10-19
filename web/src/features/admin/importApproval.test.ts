import type { ImportCandidate, ImportDecision } from './adminApi';
import { approvalBody, approvalChecklist, approvalTrackOrder, shownDecisions } from './importApproval';
import { artistEntry, detail, entryKey, labelEntry, slotId, slotTwo } from './adminFixtures.testSupport';

const fresh = { action: 'create-distinct', candidateId: null, candidateRevision: null } as const;
const artist = (n: number, change: Partial<ImportDecision> = {}): ImportDecision => ({ scope: 'artist', slotId: null, entryKey: entryKey(n), ...fresh, ...change });
const label = (change: Partial<ImportDecision> = {}): ImportDecision => ({ scope: 'label', slotId: null, entryKey: null, ...fresh, ...change });
const album = (change: Partial<ImportDecision> = {}): ImportDecision => ({ scope: 'album', slotId: null, entryKey: null, ...fresh, ...change });
const track = (slot: string, change: Partial<ImportDecision> = {}): ImportDecision => ({ scope: 'track', slotId: slot, entryKey: null, ...fresh, ...change });
const candidate = (kind: ImportCandidate['kind'], id: string, name: string, visibility: 'public' | 'hidden' = 'public'): ImportCandidate =>
  ({ kind, id, label: name, revision: `r-${id}`, albumId: null, visibility, match: 'name', matchedSlotIds: [], automaticReuse: false });
const reuse = (value: ImportCandidate) => ({ action: 'reuse' as const, candidateId: value.id, candidateRevision: value.revision });
/** A saved project of two primaries, a featured entry and a label, with both tracks titled. */
function saved() {
  const item = detail();
  item.draft.album = { ...item.draft.album, title: 'Synthetic Album', artists: [{ ...artistEntry('Lorem'), joinPhrase: ' & ' }, artistEntry('Ipsum', entryKey(2)), artistEntry('Dolor', entryKey(3), 'featured')], label: labelEntry('Sit Records') };
  item.draft.tracks = [{ slotId, title: 'First', discNumber: null, trackNumber: null }, { slotId: slotTwo, title: 'Second', discNumber: null, trackNumber: null }];
  return item;
}

test('the approved order is Disc Number with unknown as 1, then Track Number with unknown last, then draft order', () => {
  const tracks = [{ id: 'a', discNumber: 2, trackNumber: 1 }, { id: 'b', discNumber: null, trackNumber: null }, { id: 'c', discNumber: 1, trackNumber: 2 },
    { id: 'd', discNumber: null, trackNumber: 1 }, { id: 'e', discNumber: 1, trackNumber: null }, { id: 'f', discNumber: 2, trackNumber: null }];
  expect(approvalTrackOrder(tracks).map(value => value.id)).toEqual(['d', 'c', 'b', 'e', 'a', 'f']);
  expect(approvalTrackOrder([])).toEqual([]);
});

test('shown decisions are the unsaved Review edits at the current revision, else the saved ones, and none from an older revision', () => {
  const item = saved(); item.decisions = [artist(1), album()];
  const edits = { revision: item.revision, decisions: [artist(1), artist(2), label(), album(), track(slotId)] };
  expect(shownDecisions(item, item.draft, null)).toEqual(item.decisions);
  expect(shownDecisions(item, item.draft, edits)).toEqual(edits.decisions);
  expect(shownDecisions(item, item.draft, { ...edits, revision: item.revision - 1 })).toBeNull();
});

test('a renamed or removed entry or label in the shown draft drops its decision, while reordering, roles, phrases, Album and track decisions keep theirs', () => {
  const item = saved(); item.decisions = [artist(1), artist(2), artist(3), label(), album(), track(slotId), track(slotTwo)];
  const [lorem, ipsum, dolor] = item.draft.album.artists;
  const reordered = { ...item.draft, album: { ...item.draft.album, artists: [{ ...ipsum, joinPhrase: ' x ' }, { ...lorem, role: 'featured' as const }, dolor] } };
  expect(shownDecisions(item, reordered, null)).toEqual(item.decisions);
  const renamed = { ...item.draft, album: { ...item.draft.album, artists: [{ ...lorem, name: 'Lorem Renamed' }, dolor], label: labelEntry('Sit Records Ltd') } };
  expect(shownDecisions(item, renamed, null)).toEqual([artist(3), album(), track(slotId), track(slotTwo)]);
  expect(shownDecisions(item, { ...item.draft, album: { ...item.draft.album, label: null } }, null)?.map(value => value.scope)).toEqual(['artist', 'artist', 'artist', 'album', 'track', 'track']);
  // A decision on a slot the project does not have is never shown.
  expect(shownDecisions(item, item.draft, { revision: item.revision, decisions: [track('10000000-0000-4000-8000-000000000009'), album()] })).toEqual([album()]);
});

test('the checklist names each identity as new, reused (marking a hidden record), needing a decision or changed, and counts what blocks approval', () => {
  const item = saved(), ipsum = candidate('artist', '1'.repeat(24), 'Ipsum', 'hidden'), sit = candidate('organization', '2'.repeat(24), 'Sit Records');
  const decisions = [artist(1), artist(2, reuse(ipsum)), label(reuse(sit)), album(), track(slotId, { action: 'skip' }), track(slotTwo)];
  const checklist = approvalChecklist(item.draft, decisions, [ipsum, sit]);
  expect(checklist.append).toBe(false);
  expect(checklist.artists.map(entry => [entry.name, entry.role, entry.joinPhrase, entry.identity])).toEqual([
    ['Lorem', 'primary', ' & ', { kind: 'new' }], ['Ipsum', 'primary', null, { kind: 'reused', label: 'Ipsum', hidden: true }], ['Dolor', 'featured', null, { kind: 'needsDecision' }]]);
  expect(checklist.label).toEqual({ name: 'Sit Records', identity: { kind: 'reused', label: 'Sit Records', hidden: false } });
  expect(checklist.album).toEqual({ kind: 'new' });
  // A skipped track is no catalog content.
  expect(checklist.tracks.map(value => [value.slotId, value.existing, value.identity])).toEqual([[slotTwo, false, { kind: 'new' }]]);
  expect(checklist.blocked).toBe(1);
  // A reused record no longer listed at its reviewed revision is a changed match; a skipped Artist or a missing Album decision needs one.
  const changed = approvalChecklist(item.draft, [artist(1, { action: 'skip' }), artist(2, reuse(ipsum)), artist(3), label(reuse(sit))], [{ ...ipsum, revision: 'r-newer' }]);
  expect([changed.artists.map(entry => entry.identity.kind), changed.label?.identity.kind, changed.album.kind, changed.tracks.map(value => value.identity.kind), changed.blocked])
    .toEqual([['needsDecision', 'changed', 'new'], 'changed', 'needsDecision', ['needsDecision', 'needsDecision'], 6]);
  expect(approvalChecklist({ ...item.draft, album: { ...item.draft.album, label: null } }, [], []).label).toBeNull();
});

test('an append applies no entry or label, orders only the tracks it adds, and lists existing members after them in draft order', () => {
  const item = saved(), target = candidate('album', '3'.repeat(24), 'Existing Album'), member = candidate('track', '4'.repeat(24), 'Second');
  const third = '10000000-0000-4000-8000-000000000003', fourth = '10000000-0000-4000-8000-000000000004', other = candidate('track', '5'.repeat(24), 'Stored Title');
  // The members' draft positions (Disc 1 before the new tracks) are not what the append keeps: it keeps each member's stored position.
  item.draft.tracks = [{ slotId, title: 'First', discNumber: 2, trackNumber: 1 }, { slotId: slotTwo, title: 'Second', discNumber: 1, trackNumber: 5 },
    { slotId: third, title: 'Third', discNumber: 1, trackNumber: 2 }, { slotId: fourth, title: 'Draft Title', discNumber: 1, trackNumber: 1 }];
  const checklist = approvalChecklist(item.draft, [album(reuse(target)), track(slotId), track(slotTwo, reuse(member)), track(third), track(fourth, reuse(other))], [target, member, other]);
  expect([checklist.append, checklist.artists.map(entry => entry.identity.kind), checklist.label?.identity.kind, checklist.album, checklist.blocked])
    .toEqual([true, ['notApplied', 'notApplied', 'notApplied'], 'notApplied', { kind: 'reused', label: 'Existing Album', hidden: false }, 0]);
  expect(checklist.tracks.map(value => [value.slotId, value.existing, value.identity])).toEqual([[third, false, { kind: 'new' }], [slotId, false, { kind: 'new' }],
    [slotTwo, true, { kind: 'reused', label: 'Second', hidden: false }], [fourth, true, { kind: 'reused', label: 'Stored Title', hidden: false }]]);
});

test('the publish body carries the shown changes and decisions with the saved cover, revision and approval digest', () => {
  const item = saved(); item.revision = 7; item.selectedCoverSlotId = 'cover';
  const changes = [{ path: 'album.title', base: 'Synthetic Album', value: 'Retitled' }], decisions = [artist(1), album()];
  expect(approvalBody(item, changes, decisions)).toEqual({ expectedRevision: 7, changes, decisions, selectedCoverSlotId: 'cover', approvalDigest: 'e'.repeat(64) });
});

test('an append whose Album or member Track is no longer listed at its reviewed revision is a changed match that blocks approval', () => {
  const item = saved(), target = candidate('album', '3'.repeat(24), 'Existing Album'), member = candidate('track', '4'.repeat(24), 'Second');
  const decisions = [album(reuse(target)), track(slotId), track(slotTwo, reuse(member))];
  const gone = approvalChecklist(item.draft, decisions, [{ ...target, revision: 'r-newer' }]);
  // Still an append: its entries and label stay not applied, while the changed Album and member each block.
  expect([gone.append, gone.album, gone.tracks.map(value => [value.existing, value.identity.kind]), gone.artists.every(entry => entry.identity.kind === 'notApplied'), gone.blocked])
    .toEqual([true, { kind: 'changed' }, [[false, 'new'], [true, 'changed']], true, 2]);
});
