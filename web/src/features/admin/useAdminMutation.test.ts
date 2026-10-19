import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminMutation } from './useAdminMutation';
import { detail, json, viewer } from './adminFixtures.testSupport';

beforeEach(() => { adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin'); });
afterEach(() => { vi.unstubAllGlobals(); adminWorkspace.reset(); });

test('an append to an Album without a primary Artist is a definite refusal of its own, and a corrected approval can follow', async () => {
  const bodies: string[] = []; let admitted = false;
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => {
    bodies.push(String(init.body)); const { operationId } = JSON.parse(String(init.body));
    return admitted ? json({ item: detail(), receipt: { operationId, kind: 'publish', revision: 2 } }) : json({ code: 'ADMIN_IMPORT_APPEND_PRIMARY_REQUIRED' }, 409);
  }));
  const operation = new AdminMutation(), completed = vi.fn();
  operation.run('/item/publish', 'POST', { expectedRevision: 1 }, completed);
  await vi.waitFor(() => expect(operation.getSnapshot().error).toBe('append_primary_required'));
  // Nothing is kept to retry or complete, and the bundle is current, so no reload is asked for.
  expect(operation.getSnapshot()).toEqual({ running: false, intent: null, error: 'append_primary_required', result: null });
  operation.retry(); expect(bodies).toHaveLength(1); expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
  // After the target Album gains a primary Artist (or the import creates a new Album), a new approval runs with a new operation ID.
  admitted = true; operation.run('/item/publish', 'POST', { expectedRevision: 2 }, completed);
  await vi.waitFor(() => expect(operation.getSnapshot().result?.receipt?.kind).toBe('publish'));
  expect(operation.getSnapshot()).toMatchObject({ running: false, intent: null, error: null });
  expect(completed).toHaveBeenCalledOnce(); expect(bodies).toHaveLength(2);
  expect(JSON.parse(bodies[1])).toEqual({ expectedRevision: 2, operationId: expect.any(String) }); expect(JSON.parse(bodies[1]).operationId).not.toBe(JSON.parse(bodies[0]).operationId);
});

test('the primary-required code is that refusal only as a 409; another 409 stays an edit conflict and the retired refusals are ordinary conflicts', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'ADMIN_IMPORT_APPEND_PRIMARY_REQUIRED' }, 400)));
  const invalid = new AdminMutation(); invalid.run('/item/publish', 'POST', { expectedRevision: 1 });
  await vi.waitFor(() => expect(invalid.getSnapshot().error).toBe('error'));
  for (const code of ['ADMIN_IMPORT_REVISION_CONFLICT', 'ADMIN_IMPORT_PUBLICATION_UNSUPPORTED', 'ADMIN_IMPORT_APPEND_VISIBILITY_MISMATCH']) {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code }, 409)));
    const conflict = new AdminMutation(); conflict.run('/item/publish', 'POST', { expectedRevision: 1 });
    await vi.waitFor(() => expect(conflict.getSnapshot().error).toBe('conflict'));
    expect(conflict.getSnapshot().intent).toBeNull();
  }
});
