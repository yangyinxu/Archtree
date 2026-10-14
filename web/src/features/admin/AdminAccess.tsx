import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router';
import { ApiError, apiRequest } from '../../api/client';
import { browserSessionQuery, browserSessionResolvingQuery } from '../../api/session';
import { captureAccountOperation, isAccountOperationCurrent } from '../../api/accountEpoch';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey, MessageVariables } from '../../localization/contract';
import { adminWorkspace, useAdminWorkspace } from './adminWorkspace';
import { Icon } from '../../components/Icon';
import page from '../../styles/Pages.module.css';
const styles: Record<string, string> = { view: page.view, viewButton: page.viewButton, workbenchLink: page.workbenchLink, menu: page.menu, page: page.page, title: page.pageTitle, muted: page.lede, button: `${page.button} ${page.buttonSecondary}`, link: page.secondaryLink };

/** One text wrapper keeps line breaks intact inside the shell flex button. */
export function AdminViewLabel({ label, role }: { label: string; role: string }) {
  const prefix = role && label.endsWith(role) ? label.slice(0, -role.length).trimEnd() : '';
  return <span>{prefix ? <>{prefix}<br /><span style={{ whiteSpace: 'nowrap' }}>{role}</span></> : label}</span>;
}

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

/** The shell owns capability refresh; view changes never replace the player or account session. */
export const AdminControls = ({ hideWorkbenchLink = false }: { hideWorkbenchLink?: boolean }) => {
  const t = useAdminText();
  const client = useQueryClient();
  const session = useQuery(browserSessionQuery());
  const resolving = useQuery(browserSessionResolvingQuery());
  const state = useAdminWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const viewerId = !resolving.data && session.isSuccess && session.data?.user.role === 'admin' ? session.data.user.id : '';
  const epoch = captureAccountOperation(viewerId).epoch;
  const capabilities = useQuery({
    queryKey: ['admin-capabilities', viewerId, epoch], enabled: Boolean(viewerId),
    queryFn: async ({ signal }) => {
      const authority = adminWorkspace.getSnapshot().authority;
      const { capabilitySchema } = await import('./adminCapabilities');
      signal.throwIfAborted();
      const data = await apiRequest('/api/admin/v1/capabilities', capabilitySchema, { accountViewer: viewerId, signal, cache: 'no-store' });
      return { ...data, authority };
    },
    retry: false, staleTime: 30_000, gcTime: 0, refetchOnWindowFocus: false
  });
  useLayoutEffect(() => {
    if (!viewerId) { adminWorkspace.reset(); return; }
    if (capabilities.isError) {
      if (capabilities.error instanceof ApiError && [401, 403].includes(capabilities.error.status ?? 0)) adminWorkspace.reset();
      else adminWorkspace.suspend();
      return;
    }
    if (capabilities.isSuccess && !capabilities.isFetching) {
      adminWorkspace.authorize({ viewerId, epoch }, capabilities.data.albumImports.enabled, capabilities.data.albumImports.analysisAvailable, capabilities.data.authority, capabilities.data.catalog, Boolean(capabilities.data.localMp3Conversion?.enabled));
    } else if (state.authorized) adminWorkspace.suspend();
  }, [viewerId, epoch, capabilities.data, capabilities.isError, capabilities.isSuccess, capabilities.isFetching]);
  useEffect(() => adminWorkspace.subscribe(() => {
    const next = adminWorkspace.getSnapshot();
    if (!next.authorized || next.mode !== 'admin') {
      void client.cancelQueries({ queryKey: ['admin-imports'] });
      client.removeQueries({ queryKey: ['admin-imports'] });
      void client.cancelQueries({ queryKey: ['admin-catalog-reviews'] });
      client.removeQueries({ queryKey: ['admin-catalog-reviews'] });
    }
  }), [client]);
  useEffect(() => { if (state.mode !== 'admin' && location.pathname.startsWith('/admin')) {
    // A direct User-view link shows the gate; only leaving an active workspace navigates Home.
    if (adminWorkspace.buffer<string>('lastRoute') === location.pathname) navigate('/', { replace: true });
  } }, [state.mode, location.pathname, navigate]);
  useEffect(() => { if (state.authorized && state.mode === 'admin' && location.pathname.startsWith('/admin')) {
    adminWorkspace.retain('lastRoute', location.pathname, state);
  } }, [location.pathname, state.mode, state.authorized]);
  if (!viewerId || capabilities.isFetching) return null;
  if (!state.authorized || state.viewerId !== viewerId || state.epoch !== epoch) return <button className={styles.button} type="button" title={t('view.required')} onClick={() => void capabilities.refetch()}>{t('common.retry')}</button>;
  const viewLabel = t(state.mode === 'admin' ? 'view.current_admin' : 'view.current_user');
  return <div className={styles.view}>
    <button type="button" className={`${styles.button} ${styles.viewButton}`} aria-label={viewLabel} aria-expanded={open} aria-controls="admin-view-options"
      onClick={() => setOpen(!open)}><AdminViewLabel label={viewLabel} role={t(`view.${state.mode}`)} /></button>
    {open && <div id="admin-view-options" className={styles.menu} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
      {(['admin', 'user'] as const).map(mode => <button key={mode} aria-pressed={state.mode === mode}
        className={styles.button} type="button" onClick={() => { if (mode === 'admin') void enterAdminView(); else adminWorkspace.select(mode); setOpen(false); }}>
        {t(`view.${mode}`)}</button>)}
    </div>}
    {state.mode === 'admin' && !hideWorkbenchLink && <Link aria-label={t('workbench.title')} title={t('workbench.title')} className={`${styles.link} ${styles.workbenchLink}`} to="/admin/imports"><Icon name="library" /><span>{t('workbench.title')}</span></Link>}
  </div>;
};

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
    const { capabilitySchema } = await import('./adminCapabilities');
    if (!adminWorkspace.current(previous, false)) return;
    const result = await apiRequest('/api/admin/v1/capabilities', capabilitySchema, { accountViewer: previous.viewerId, cache: 'no-store' });
    adminWorkspace.authorize(previous, result.albumImports.enabled, result.albumImports.analysisAvailable, previous.authority, result.catalog, Boolean(result.localMp3Conversion?.enabled));
    if (adminWorkspace.getSnapshot().authority === previous.authority) adminWorkspace.select('admin');
  } catch (error) { revokeOnAdminFailure(error); }
}

/** Permission failures revoke all private state, while ordinary transport failures remain retryable. */
export const revokeOnAdminFailure = (error: unknown) => {
  if (error instanceof ApiError && (error.status === 403 || error.status === 401)) adminWorkspace.reset();
};
