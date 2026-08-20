import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';

import { listenerOrganizationQuery } from '../../api/listener';
import { PageSection } from '../../components/PageSection';
import styles from './CatalogPages.module.css';

/** Presents one public Organization and the releases carrying its institutional Credits. */
export const OrganizationPage = () => {
  const { organizationId = '' } = useParams();
  const organizationQuery = useQuery(listenerOrganizationQuery(organizationId));

  if (organizationQuery.isPending) {
    return <div className={styles.page}><div className={styles.state} aria-busy="true">Loading Organization…</div></div>;
  }
  if (organizationQuery.isError) {
    return (
      <div className={styles.page}>
        <div className={styles.state} role="alert">
          <h1>This Organization is unavailable</h1>
          <p>It may have moved, or the catalog may be temporarily out of reach.</p>
          <button onClick={() => organizationQuery.refetch()} type="button">Try again</button>
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
          <p className={styles.eyebrow}>{organization.organizationType || 'Organization'}</p>
          <h1>{organization.name || 'Unknown organization'}</h1>
          {organization.description && <p className={styles.bio}>{organization.description}</p>}
        </div>
      </header>

      {releases.length > 0 ? (
        <PageSection
          id={`${organization.id}-releases`}
          items={releases}
          presentation="grid"
          title="Releases"
        />
      ) : (
        <div className={styles.empty}>No public releases credit this Organization yet.</div>
      )}
    </div>
  );
};
