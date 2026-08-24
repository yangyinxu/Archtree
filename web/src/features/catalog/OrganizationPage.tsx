import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';

import { listenerOrganizationQuery } from '../../api/listener';
import { PageSection } from '../../components/PageSection';
import styles from './CatalogPages.module.css';
import { useLocalization } from '../../localization/LocalizationProvider';

/** Presents one public Organization and the releases carrying its institutional Credits. */
export const OrganizationPage = () => {
  const { t } = useLocalization();
  const { organizationId = '' } = useParams();
  const organizationQuery = useQuery(listenerOrganizationQuery(organizationId));

  if (organizationQuery.isPending) {
    return <div className={styles.page}><div className={styles.state} aria-busy="true">{t('catalog.organization.loading')}</div></div>;
  }
  if (organizationQuery.isError) {
    return (
      <div className={styles.page}>
        <div className={styles.state} role="alert">
          <h1>{t('catalog.organization.unavailable')}</h1>
          <p>{t('catalog.error.copy')}</p>
          <button onClick={() => organizationQuery.refetch()} type="button">{t('common.action.try_again')}</button>
        </div>
      </div>
    );
  }

  const { organization, releases } = organizationQuery.data;
  return (
    <div className={styles.page}>
      <header className={`${styles.hero} ${styles.organizationHero}`}>
        <div className={styles.organizationMark} aria-hidden="true">
          {(organization.name.trim()[0] || 'O').toUpperCase()}
        </div>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>{organization.organizationType || t('common.label.organization')}</p>
          <h1>{organization.name || t('content.title.unknown_organization')}</h1>
          {organization.description && <p className={styles.bio}>{organization.description}</p>}
        </div>
      </header>

      {releases.length > 0 ? (
        <PageSection
          id={`${organization.id}-releases`}
          items={releases}
          presentation="grid"
          title={t('common.label.releases')}
        />
      ) : (
        <div className={styles.empty}>{t('catalog.organization.empty')}</div>
      )}
    </div>
  );
};
