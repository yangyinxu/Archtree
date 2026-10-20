import { advanceAccountEpoch, captureAccountOperation } from '../../api/accountEpoch';
import { adminWorkspace } from './adminWorkspace';

beforeEach(() => adminWorkspace.reset());
test('only confirmed capabilities allow Admin; selecting a view changes no account epoch', () => {
  adminWorkspace.select('admin'); expect(adminWorkspace.getSnapshot().mode).toBe('user');
  const guard = captureAccountOperation('a');
  adminWorkspace.authorize(guard, true, false); adminWorkspace.select('admin');
  expect(adminWorkspace.capture()).toMatchObject(guard);
  adminWorkspace.select('user');
  expect(captureAccountOperation('a')).toEqual(guard);
});
test('view switch retains private edits but fences old reads, account change clears everything', () => {
  adminWorkspace.authorize(captureAccountOperation('a'), true, true); adminWorkspace.select('admin');
  const guard = adminWorkspace.capture(); adminWorkspace.retain('draft', { title: 'Manual' }, guard);
  adminWorkspace.select('user');
  expect(adminWorkspace.current(guard)).toBe(false);
  expect(adminWorkspace.current(guard, false)).toBe(true);
  expect(adminWorkspace.buffer('draft')).toEqual({ title: 'Manual' });
  advanceAccountEpoch();
  expect(adminWorkspace.buffer('draft')).toBeUndefined();
  expect(adminWorkspace.current(guard, false)).toBe(false);
  adminWorkspace.authorize(guard, true, true);
  expect(adminWorkspace.getSnapshot().authorized).toBe(false);
});
test('A to B to A never revives an earlier operation or editing buffer', () => {
  adminWorkspace.authorize(captureAccountOperation('a'), true, true); adminWorkspace.select('admin');
  const first = adminWorkspace.capture(); adminWorkspace.retain('draft', 'private', first);
  advanceAccountEpoch(); adminWorkspace.authorize(captureAccountOperation('b'), true, true);
  advanceAccountEpoch(); adminWorkspace.authorize(captureAccountOperation('a'), true, true);
  expect(adminWorkspace.current(first, false)).toBe(false);
  expect(adminWorkspace.buffer('draft')).toBeUndefined();
});
test('a reload request survives view selection, suspension and authorization, and a reset clears it', () => {
  const guard = captureAccountOperation('a'); adminWorkspace.authorize(guard, true, true); adminWorkspace.select('admin');
  adminWorkspace.requireReload(); expect(adminWorkspace.getSnapshot().reloadRequired).toBe(true);
  adminWorkspace.select('user'); adminWorkspace.suspend(); adminWorkspace.authorize(guard, true, true); adminWorkspace.select('admin');
  expect(adminWorkspace.getSnapshot().reloadRequired).toBe(true);
  adminWorkspace.reset(); expect(adminWorkspace.getSnapshot().reloadRequired).toBe(false);
});
