import { captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';
import { AdminMutation } from './useAdminMutation';
import { detail, json, viewer } from './adminFixtures.testSupport';

beforeEach(() => { adminWorkspace.reset(); adminWorkspace.authorize(captureAccountOperation(viewer), true, true); adminWorkspace.select('admin'); });
afterEach(() => { vi.unstubAllGlobals(); adminWorkspace.reset(); });

test('a publication or Artist decision refused as unsupported is a definite refusal of its own, and a corrected approval can follow', async () => {
  const bodies: string[] = []; let admitted = false;
  vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => {
    bodies.push(String(init.body)); const { operationId } = JSON.parse(String(init.body));
    return admitted ? json({ item: detail(), receipt: { operationId, kind: 'publish', revision: 2 } }) : json({ code: 'ADMIN_IMPORT_PUBLICATION_UNSUPPORTED' }, 409);
  }));
  const decision = new AdminMutation(); decision.run('/item/decisions', 'POST', { expectedRevision: 1, decisions: [] });
  await vi.waitFor(() => expect(decision.getSnapshot().error).toBe('publication_unsupported'));
  const operation = new AdminMutation(), completed = vi.fn();
  operation.run('/item/publish', 'POST', { expectedRevision: 1 }, completed);
  await vi.waitFor(() => expect(operation.getSnapshot().error).toBe('publication_unsupported'));
  // Nothing is kept to retry or complete, and the bundle is current, so no reload is asked for.
  expect(operation.getSnapshot()).toEqual({ running: false, intent: null, error: 'publication_unsupported', result: null });
  operation.retry(); expect(bodies).toHaveLength(2); expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
  // After the draft is reduced to what this release publishes, a new approval runs with a new operation ID.
  admitted = true; operation.run('/item/publish', 'POST', { expectedRevision: 2 }, completed);
  await vi.waitFor(() => expect(operation.getSnapshot().result?.receipt?.kind).toBe('publish'));
  expect(operation.getSnapshot()).toMatchObject({ running: false, intent: null, error: null });
  expect(completed).toHaveBeenCalledOnce(); expect(bodies).toHaveLength(3);
  expect(JSON.parse(bodies[2])).toEqual({ expectedRevision: 2, operationId: expect.any(String) }); expect(JSON.parse(bodies[2]).operationId).not.toBe(JSON.parse(bodies[1]).operationId);
});

test('the unsupported code means a refused publication only as a 409; another 409 stays an edit conflict', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'ADMIN_IMPORT_PUBLICATION_UNSUPPORTED' }, 400)));
  const invalid = new AdminMutation(); invalid.run('/item/publish', 'POST', { expectedRevision: 1 });
  await vi.waitFor(() => expect(invalid.getSnapshot().error).toBe('error'));
  vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'ADMIN_IMPORT_REVISION_CONFLICT' }, 409)));
  const conflict = new AdminMutation(); conflict.run('/item/publish', 'POST', { expectedRevision: 1 });
  await vi.waitFor(() => expect(conflict.getSnapshot().error).toBe('conflict'));
  expect(conflict.getSnapshot().intent).toBeNull();
});
