import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { browserSessionQuery } from '../api/session';
import { Avatar } from '../components/Avatar';
import { useLocalization } from '../localization/LocalizationProvider';
import styles from './AppShell.module.css';

/** Loads private account presentation independently of the shell's route and search controls. */
export const AccountEntry = () => {
  const session = useQuery(browserSessionQuery());
  const user = session.data?.user;
  const { t } = useLocalization();
  const label = user?.displayName.trim()
    || user?.email
    || (session.isPending ? t('shell.account.checking') : t('shell.account.log_in'));
  return <Link className={styles.account} to={user ? '/account' : '/login'} aria-label={label}>
    <Avatar avatar={user?.avatar} displayName={user?.displayName} email={user?.email} viewerId={user?.id} />
    <span>{label}</span>
  </Link>;
};
