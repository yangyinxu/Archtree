import { NavLink } from 'react-router';
import { useAdminText } from './AdminAccess';
import styles from './adminStyles';
export function AdminNav() {
  const t = useAdminText();
  return <nav aria-label={t('workbench.title')} className={styles.nav}>
    <NavLink className={styles.navLink} to="/admin/imports">{t('workbench.title')}</NavLink>
    <NavLink className={styles.navLink} to="/admin/catalog">{t('catalog.title')}</NavLink>
    <NavLink className={styles.navLink} to="/admin/pages">{t('catalog.pages')}</NavLink>
  </nav>;
}
