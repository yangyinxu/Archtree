import { expect, test } from '@playwright/test';
import { artistEntry, capabilities, detail, entryKey, lookupResponse, projectId, session, slotId, slotTwo, viewer } from '../src/features/admin/adminFixtures.testSupport';

/** Independent track Credits are explicitly visible, deselectable and frozen in the publication request. */
test('a new Album reviews track Artists, deselects a guest from the keyboard and publishes only the reviewed selection', async ({ page }, info) => {
  let item = detail(); item.suggestions = []; item.draft.album.title = 'Lorem Album'; item.draft.album.artists = [artistEntry('Lorem Lead')];
  item.capabilities = { analysis: false, upload: true, publish: true }; item.upload = { ready: 2, total: 2, available: true }; item.publication = 'notStarted';
  item.draft.tracks.forEach((track, index) => { track.title = `Song ${index + 1}`; track.discNumber = 1; track.trackNumber = index + 1; });
  item.assets = [slotId, slotTwo].map(slotId => ({ slotId, state: 'ready' as const, byteLength: 100, sha256: 'a'.repeat(64), contentType: 'audio/mpeg', tags: null, recovery: null }));
  const lead = { ...item.draft.album.artists[0], identity: entryKey(1), joinPhrase: ' feat. ' }, guest = { ...artistEntry('Ipsum Guest', entryKey(2), 'featured'), identity: entryKey(2) };
  const headers = { 'X-Finitude-Account-Viewer': viewer, 'Cache-Control': 'no-store' }, writes: Record<string, any>[] = [];
  await page.route('**/auth/browser/session', route => route.fulfill({ json: session }));
  await page.route('**/api/listener/v1/capabilities', route => route.fulfill({ json: { playlists: false } }));
  await page.route('**/api/listener/v1/personalization-capabilities', route => route.fulfill({ json: { contractVersion: 1, deterministicDiscovery: false, artistFollows: false } }));
  await page.route('**/api/admin/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/capabilities')) return route.fulfill({ json: capabilities, headers });
    if (path.endsWith('/duplicate-candidates')) return route.fulfill({ json: { items: [], memberMatchesComplete: true }, headers });
    if (path.endsWith('/lookup')) return route.fulfill({ json: lookupResponse({ revision: item.revision, summary: { ...lookupResponse().summary,
      trackArtists: [{ slotId: slotTwo, entries: [lead, guest] }], trackIdentities: [{ key: guest.key, name: guest.name, musicBrainzId: null, slotIds: [slotTwo] }] } }), headers });
    if (path.endsWith('/publish')) {
      const body = request.postDataJSON(); writes.push(body);
      item = { ...item, revision: item.revision + 1, publication: 'complete', published: { albumId: '1'.repeat(24), artistIds: ['2'.repeat(24)], organizationId: null, trackIds: ['3'.repeat(24), '4'.repeat(24)] } };
      return route.fulfill({ status: 202, json: { item, receipt: { operationId: body.operationId, kind: 'publish', revision: item.revision } }, headers });
    }
    return route.fulfill({ json: { item, receipt: null }, headers });
  });
  await page.goto(`/finitude/admin/imports/${projectId}`);
  await page.getByRole('button', { name: 'Switch to Admin view' }).click();
  const summary = page.getByRole('region', { name: 'Review and publish', exact: true });
  await summary.getByText('Values that need no answer').click();
  await expect(summary.getByText('Track Artists: Lorem Lead feat. Ipsum Guest')).toBeVisible();
  await summary.screenshot({ path: info.outputPath('track-artists-summary.png') });
  await summary.getByRole('button', { name: 'Review and approve publishing' }).click();
  const dialog = page.getByRole('dialog'), select = dialog.getByRole('checkbox', { name: 'Use track Artists for Disc 1 · Track 2 · Song 2' });
  await expect(select).toBeChecked();
  await expect(dialog.getByText('Ipsum Guest · Featured · New')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  await select.focus(); await select.press('Space');
  await expect(select).not.toBeChecked();
  await expect(dialog.getByText('Uses Album primary Artists: Lorem Lead')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.screenshot({ path: info.outputPath('track-artists-confirmation-320.png') });
  await dialog.getByRole('button', { name: 'Publish Album', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('tab', { name: 'Publish', exact: true }).click();
  const published = page.getByRole('tabpanel', { name: 'Publish', exact: true });
  await expect(published.getByRole('status')).toHaveText('The Album publication is confirmed.');
  await expect(published.getByRole('link', { name: 'Edit published Album' })).toHaveAttribute('href', `/finitude/admin/catalog/album/${'1'.repeat(24)}`);
  expect(writes).toHaveLength(1);
  expect(writes[0].trackArtists).toEqual([{ slotId: slotTwo, selected: false }]);
  expect(writes[0].approvalDigest).toBe('e'.repeat(64));
  expect(writes[0].preselections.some((value: { entryKey: string | null }) => value.entryKey === guest.key)).toBe(false);
  expect(writes[0].musicBrainzIds).toEqual([]);
});
