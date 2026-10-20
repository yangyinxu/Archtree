import { NavLink } from 'react-router';
import { useAdminText } from './AdminAccess';
import { useAdminWorkspace } from './adminWorkspace';
import styles from './adminStyles';
/** Workbench navigation also carries the one reload request shared by every outdated admin response. */
export function AdminNav() {
  const t = useAdminText();
  const { reloadRequired } = useAdminWorkspace();
  return <>
    <nav aria-label={t('workbench.title')} className={styles.nav}>
      <NavLink className={styles.navLink} to="/admin/imports">{t('workbench.title')}</NavLink>
      <NavLink className={styles.navLink} to="/admin/catalog">{t('catalog.title')}</NavLink>
      <NavLink className={styles.navLink} to="/admin/pages">{t('catalog.pages')}</NavLink>
    </nav>
    {reloadRequired && <div role="alert" className={styles.error}><p>{t('common.reload')}</p>
      <button type="button" className={styles.button} onClick={() => window.location.reload()}>{t('common.reload_action')}</button></div>}
  </>;
}
