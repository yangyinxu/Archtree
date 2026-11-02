import { Link } from 'react-router';
import { useAdminAccess } from './AdminAccess';
import { useAdminDeliveryText } from './adminPageText';
import { useVideoCapabilities } from './useVideoCapabilities';
import styles from './VideoUpload.module.css';

/** The three parallel tools keep their existing capability boundaries and destination routes. */
export function VideoWorkbenchEntries() {
  const t = useAdminDeliveryText(['video.']), access = useAdminAccess(), capability = useVideoCapabilities();
  const cards = [
    { key: 'album', title: t('workbench.new'), to: '/admin/imports/new', enabled: access.imports, description: t('video.album_entry_help') },
    { key: 'video', title: t('video.new'), to: '/admin/videos/new', enabled: Boolean(capability?.enabled), description: capability?.enabled ? t('video.video_entry_help') : t('video.unavailable') },
    { key: 'conversion', title: t('conversion.title'), to: '/admin/conversions', enabled: true, description: t('video.conversion_entry_help') }
  ];
  return <div className={styles.entries}>{cards.map(card => {
    const content = <><h2>{card.title}</h2><p className={styles.help}>{card.description}</p></>;
    return card.enabled ? <Link className={styles.entryCard} aria-label={card.title} to={card.to} key={card.key}>{content}</Link>
      : <div className={styles.entryCard} key={card.key}><h2><button type="button" disabled aria-label={card.title}>{card.title}</button></h2><p className={styles.help}>{card.description}</p></div>;
  })}</div>;
}
