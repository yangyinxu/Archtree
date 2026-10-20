import { useEffect, useLayoutEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router';
import { ApiError } from '../../api/client';
import { browserSessionQuery, browserSessionResolvingQuery } from '../../api/session';
import { captureAccountOperation } from '../../api/accountEpoch';
import { enterAdminView, readCapabilities, useAdminText } from './AdminAccess';
import { adminWorkspace, useAdminWorkspace } from './adminWorkspace';
import { Icon } from '../../components/Icon';
import page from '../../styles/Pages.module.css';
// The shell's view switch lives apart from AdminAccess.tsx, which every admin route loads, so no route carries the switch.
const styles: Record<string, string> = { view: page.view, viewButton: page.viewButton, workbenchLink: page.workbenchLink, menu: page.menu, button: `${page.button} ${page.buttonSecondary}`, link: page.secondaryLink };

/** One text wrapper keeps line breaks intact inside the shell flex button. */
export function AdminViewLabel({ label, role }: { label: string; role: string }) {
  const prefix = role && label.endsWith(role) ? label.slice(0, -role.length).trimEnd() : '';
  return <span>{prefix ? <>{prefix}<br /><span style={{ whiteSpace: 'nowrap' }}>{role}</span></> : label}</span>;
}

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
      const data = await readCapabilities(viewerId, signal);
      return { ...data, authority };
    },
    // A refetch suspends the workspace, which would stop a running upload queue; reconnecting is not a reason to recheck.
    retry: false, staleTime: 30_000, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false
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
  /**
   * Only the explicit switch away from an active workspace navigates Home, as a new history entry: Back then
   * returns to the administration page, which shows the Admin view gate like any User-view visit to it.
   */
  const leaveAdminView = () => {
    const leaving = adminWorkspace.getSnapshot().mode === 'admin';
    adminWorkspace.select('user');
    if (leaving && adminWorkspace.getSnapshot().mode === 'user' && location.pathname.startsWith('/admin')) navigate('/');
  };
  if (!viewerId || capabilities.isFetching) return null;
  if (state.reloadRequired && !state.authorized) return <button className={styles.button} type="button" title={t('common.reload')} onClick={() => window.location.reload()}>{t('common.reload_action')}</button>;
  if (!state.authorized || state.viewerId !== viewerId || state.epoch !== epoch) return <button className={styles.button} type="button" title={t('view.required')} onClick={() => void capabilities.refetch()}>{t('common.retry')}</button>;
  const viewLabel = t(state.mode === 'admin' ? 'view.current_admin' : 'view.current_user');
  return <div className={styles.view}>
    <button type="button" className={`${styles.button} ${styles.viewButton}`} aria-label={viewLabel} aria-expanded={open} aria-controls="admin-view-options"
      onClick={() => setOpen(!open)}><AdminViewLabel label={viewLabel} role={t(`view.${state.mode}`)} /></button>
    {open && <div id="admin-view-options" className={styles.menu} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
      {(['admin', 'user'] as const).map(mode => <button key={mode} aria-pressed={state.mode === mode}
        className={styles.button} type="button" onClick={() => { if (mode === 'admin') void enterAdminView(); else leaveAdminView(); setOpen(false); }}>
        {t(`view.${mode}`)}</button>)}
    </div>}
    {state.mode === 'admin' && !hideWorkbenchLink && <Link aria-label={t('workbench.title')} title={t('workbench.title')} className={`${styles.link} ${styles.workbenchLink}`} to="/admin/imports"><Icon name="library" /><span>{t('workbench.title')}</span></Link>}
  </div>;
};
