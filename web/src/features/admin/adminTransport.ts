import { z } from 'zod';
import { apiRequest, ApiError } from '../../api/client';
import { adminWorkspace } from './adminWorkspace';

const id = z.string().regex(/^[a-f0-9]{24}$/);
export type AdminGuard = ReturnType<typeof adminWorkspace.capture>;

/** Read results belong to a view generation; admitted writes may finish while that same account uses User view. */
export async function adminEndpointRequest<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, guard = adminWorkspace.capture()): Promise<T> {
  if (!adminWorkspace.current(guard)) throw new DOMException('Admin view changed', 'AbortError');
  try {
    const result = await apiRequest(`/api/admin/v1${path}`, schema, { ...init, accountViewer: guard.viewerId, cache: 'no-store' });
    if (!adminWorkspace.current(guard, !init.method || init.method === 'GET')) throw new DOMException('Admin view changed', 'AbortError');
    return result;
  } catch (error) {
    if (adminWorkspace.current(guard, false) && error instanceof ApiError && [401, 403].includes(error.status ?? 0)) adminWorkspace.reset();
    throw error;
  }
}
export const importPath = (value: string) => `/${id.parse(value)}`;

export async function adminRequest<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, guard = adminWorkspace.capture()) { return adminEndpointRequest(`/imports${path}`, schema, init, guard); }
