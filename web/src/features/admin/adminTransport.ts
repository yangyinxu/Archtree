import { z } from 'zod';
import { apiRequest, ApiError } from '../../api/client';
import { ADMIN_RELOAD_REQUIRED, adminWorkspace } from './adminWorkspace';

const id = z.string().regex(/^[a-f0-9]{24}$/);
export type AdminGuard = ReturnType<typeof adminWorkspace.capture>;
export { ADMIN_RELOAD_REQUIRED };
/**
 * Server refusals, unlike the client-side ADMIN_RELOAD_REQUIRED (a strict-parse failure of this bundle): the project was
 * saved in a newer format and is read-only for this release, or an append's visibility differs from the target Album.
 * They live here, beside the transport, so a command hook can read them without loading the import schemas.
 */
export const ADMIN_IMPORT_RELOAD_REQUIRED = 'ADMIN_IMPORT_RELOAD_REQUIRED';
export const ADMIN_IMPORT_APPEND_VISIBILITY_MISMATCH = 'ADMIN_IMPORT_APPEND_VISIBILITY_MISMATCH';

/**
 * Read results belong to a view generation; admitted writes may finish while that same account uses User view.
 * The strict schema is applied here, after transport, so an outdated bundle becomes a reload request rather
 * than an unconfirmed operation; a caller's own receipt check never reaches this state.
 */
export async function adminEndpointRequest<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, guard = adminWorkspace.capture()): Promise<T> {
  if (!adminWorkspace.current(guard)) throw new DOMException('Admin view changed', 'AbortError');
  let raw: unknown;
  try {
    raw = await apiRequest(`/api/admin/v1${path}`, z.unknown(), { ...init, accountViewer: guard.viewerId, cache: 'no-store' });
  } catch (error) {
    if (adminWorkspace.current(guard, false) && error instanceof ApiError && [401, 403].includes(error.status ?? 0)) adminWorkspace.reset();
    throw error;
  }
  if (!adminWorkspace.current(guard, !init.method || init.method === 'GET')) throw new DOMException('Admin view changed', 'AbortError');
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    if (adminWorkspace.current(guard, false)) adminWorkspace.requireReload();
    throw new ApiError('The administrator workbench needs a reload.', 'invalid-response', 200, ADMIN_RELOAD_REQUIRED);
  }
  return parsed.data;
}
export const importPath = (value: string) => `/${id.parse(value)}`;

export async function adminRequest<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, guard = adminWorkspace.capture()) { return adminEndpointRequest(`/imports${path}`, schema, init, guard); }
