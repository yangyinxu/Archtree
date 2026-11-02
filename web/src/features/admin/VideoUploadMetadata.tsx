import { useQuery } from '@tanstack/react-query';
import { useAdminAccess } from './AdminAccess';
import { useAdminDeliveryText } from './adminPageText';
import { adminEndpointRequest } from './adminTransport';
import type { CatalogKind } from './catalogApi';
import { VideoCatalogLookup, type VideoCatalogSelection } from './VideoCatalogLookup';
import type { VideoDraft, VideoProject } from './videoUploadApi';
import common from './adminStyles';
import styles from './VideoUpload.module.css';

const albumKinds = ['album'] as const, subjectKinds = ['artist', 'organization'] as const;

/** Resolves a locally selected identity after a route return without turning its name into identity. */
function useSelectedReference(kind: CatalogKind, id: string | null, saved: VideoCatalogSelection | null) {
  const access = useAdminAccess();
  const query = useQuery({ queryKey: ['admin-video-reference', access.viewerId, access.epoch, access.generation, kind, id],
    queryFn: async ({ signal }) => { const { catalogResponse } = await import('./catalogApi'); return adminEndpointRequest(`/catalog/${kind}/${id}`, catalogResponse.refine(value => value.item.id === id && value.item.kind === kind), { signal }); },
    enabled: access.active && Boolean(id) && !(saved?.id === id && saved.kind === kind), retry: false, gcTime: 0 });
  return saved?.id === id && saved.kind === kind ? saved : query.data ? { id: query.data.item.id, name: 'name' in query.data.item.fields ? query.data.item.fields.name : query.data.item.fields.title, revision: query.data.item.revision, kind } : null;
}

/** Edits ownership separately from public byline and optional Album membership. */
export function VideoUploadMetadata({ draft, project, disabled, onChange }: { draft: VideoDraft; project: VideoProject; disabled: boolean; onChange: (patch: Partial<VideoDraft>) => void }) {
  const t = useAdminDeliveryText(['video.']);
  const subject = useSelectedReference(draft.subjectType, draft.subjectId, project.references.subject ? { ...project.references.subject, kind: project.draft.subjectType } : null);
  const album = useSelectedReference('album', draft.albumId, project.references.album ? { ...project.references.album, name: project.references.album.title, kind: 'album' } : null);
  return <section><h2>{t('video.metadata')}</h2><fieldset className={styles.fields} disabled={disabled}>
    <label className={common.field}>{t('video.title')}<input className={common.input} value={draft.title} maxLength={200} onChange={event => onChange({ title: event.target.value })} required /></label>
    <div className={common.field}><span id="video-attribution-label">{t('video.attribution')}</span><div className={styles.choices} role="radiogroup" aria-labelledby="video-attribution-label">
      {(['self', 'catalog', 'unknown'] as const).map(attribution => <label key={attribution}><input type="radio" name="video-attribution" value={attribution} checked={draft.attribution === attribution} onChange={() => onChange({ attribution })} />{t(`video.attribution_${attribution}`)}</label>)}
    </div><p className={styles.help}>{t(`video.attribution_${draft.attribution}_help`)}</p></div>
    {draft.attribution === 'self' && <div className={common.field}><label htmlFor="video-public-name">{t('video.public_name')}</label><input id="video-public-name" className={common.input} value={draft.publicName} maxLength={80} aria-describedby="video-public-name-help" onChange={event => onChange({ publicName: event.target.value })} /><span id="video-public-name-help" className={styles.help}>{t('video.public_name_help')}</span></div>}
    {draft.attribution === 'catalog' && <VideoCatalogLookup label={t('video.subject')} kinds={subjectKinds} value={subject} disabled={disabled} onChange={value => onChange({ subjectId: value?.id ?? null, subjectType: value?.kind === 'organization' ? 'organization' : 'artist' })} />}
    <VideoCatalogLookup label={t('video.album')} kinds={albumKinds} value={album} disabled={disabled} allowNone onChange={value => onChange({ albumId: value?.id ?? null })} />
    <label className={common.field}>{t('video.visibility')}<select className={common.input} value={draft.visibility} onChange={event => onChange({ visibility: event.target.value as VideoDraft['visibility'] })}><option value="public">{t('field.public')}</option><option value="hidden">{t('field.hidden')}</option></select><span className={styles.help}>{t(draft.visibility === 'hidden' ? 'video.hidden_help' : 'video.private_help')}</span></label>
  </fieldset></section>;
}
