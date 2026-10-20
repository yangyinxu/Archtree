import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, apiRequest } from '../../api/client';
import { browserSessionQuery, browserSessionResolvingQuery } from '../../api/session';
import { isAccountOperationCurrent } from '../../api/accountEpoch';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey, MessageVariables } from '../../localization/contract';
import { ADMIN_RELOAD_REQUIRED, adminWorkspace, useAdminWorkspace } from './adminWorkspace';
import page from '../../styles/Pages.module.css';
const styles: Record<string, string> = { page: page.page, title: page.pageTitle, muted: page.lede, button: `${page.button} ${page.buttonSecondary}` };

/** All admin copy comes from the shared catalog, including independently lazy-loaded surfaces. */
export const useAdminText = () => {
  const { t } = useLocalization();
  return (key: string, variables?: MessageVariables) => t(`admin.${key.replace(/[A-Z]/g, char => `_${char.toLowerCase()}`)}` as MessageKey, variables);
};

/** A render-time fence prevents old private UI flashing before effects clear its cache. */
export const useAdminAccess = () => {
  const state = useAdminWorkspace();
  const session = useQuery(browserSessionQuery());
  const resolving = useQuery(browserSessionResolvingQuery());
  const available = !resolving.data && session.isSuccess && session.data?.user.role === 'admin'
    && session.data.user.id === state.viewerId && state.authorized && isAccountOperationCurrent(state);
  return { ...state, available, active: Boolean(available && state.mode === 'admin') };
};

/** Shared by the shell's view switch and enterAdminView; an outdated strict capability schema requests a page reload instead of an ordinary retry. */
export async function readCapabilities(viewerId: string, signal?: AbortSignal) {
  const { capabilitySchema } = await import('./adminCapabilities');
  signal?.throwIfAborted();
  const raw = await apiRequest('/api/admin/v1/capabilities', z.unknown(), { accountViewer: viewerId, signal, cache: 'no-store' });
  const parsed = capabilitySchema.safeParse(raw);
  if (!parsed.success) { adminWorkspace.requireReload(); throw new ApiError('The administrator workbench needs a reload.', 'invalid-response', 200, ADMIN_RELOAD_REQUIRED); }
  return parsed.data;
}

export const AdminGate = ({ children }: { children: ReactNode }) => {
  const access = useAdminAccess();
  const t = useAdminText();
  if (!access.active) return <section className={styles.page}>
    <h1 className={styles.title}>{t('workbench.title')}</h1><p className={styles.muted}>{t('view.required')}</p>
    {access.available && <button className={styles.button} type="button" onClick={() => void enterAdminView()}>{t('view.switch_admin')}</button>}
  </section>;
  return <>{children}</>;
};

/** Entering Admin always confirms current capability; file-picker focus never tears down an editing form. */
export async function enterAdminView() {
  const previous = adminWorkspace.getSnapshot();
  if (!previous.authorized || !isAccountOperationCurrent(previous)) return;
  adminWorkspace.suspend();
  try {
    await import('./adminCapabilities');
    if (!adminWorkspace.current(previous, false)) return;
    const result = await readCapabilities(previous.viewerId);
    adminWorkspace.authorize(previous, result.albumImports.enabled, result.albumImports.analysisAvailable, previous.authority, result.catalog, Boolean(result.localMp3Conversion?.enabled));
    if (adminWorkspace.getSnapshot().authority === previous.authority) adminWorkspace.select('admin');
  } catch (error) { revokeOnAdminFailure(error); }
}

/** Permission failures revoke all private state, while ordinary transport failures remain retryable. */
export const revokeOnAdminFailure = (error: unknown) => {
  if (error instanceof ApiError && (error.status === 403 || error.status === 401)) adminWorkspace.reset();
};
