import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocalization } from '../../localization/LocalizationProvider';
import type { MessageKey } from '../../localization/contract';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { adminEndpointRequest } from './adminApi';
import { catalogList, catalogResponse, creditRoles, type CatalogCredit, type CatalogItem } from './catalogApi';
import styles from './adminStyles';

type Fields = CatalogItem['fields'];
function CreditName({ credit }: { credit: CatalogCredit }) {
  const t = useAdminText(), access = useAdminAccess();
  const query = useQuery({ queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, 'credit', credit.subjectType, credit.subjectId], queryFn: ({ signal }) => adminEndpointRequest(`/catalog/${credit.subjectType}/${credit.subjectId}`, catalogResponse, { signal }), retry: false, gcTime: 0 });
  return <span>{query.data && 'name' in query.data.item.fields ? query.data.item.fields.name : t(query.isError ? 'common.error' : 'common.loading')}</span>;
}
function CreditEditor({ credits, onChange, disabled }: { credits: CatalogCredit[]; onChange: (credits: CatalogCredit[]) => void; disabled: boolean }) {
  const t = useAdminText(), access = useAdminAccess(), { t: sharedText } = useLocalization();
  const [kind, setKind] = useState<'artist' | 'organization'>('artist');
  const [text, setText] = useState(''); const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, 'credit-search', kind, search], queryFn: ({ signal }) => adminEndpointRequest(`/catalog/${kind}?query=${encodeURIComponent(search)}`, catalogList, { signal }), enabled: Boolean(search), retry: false, gcTime: 0 });
  const roleText = (role: string) => role === 'legacyUnspecified' ? t('catalog.unspecified') : sharedText(`catalog.credit.${role}` as MessageKey);
  return <fieldset disabled={disabled} className={styles.editor}><legend>{t('catalog.credits')}</legend>
    {credits.map((credit, index) => <div className={styles.actions} key={credit.creditId}>
      <CreditName credit={credit} />
      <label>{t('catalog.role')}<select className={styles.input} value={credit.role} onChange={event => onChange(credits.map(item => item.creditId === credit.creditId ? { ...item, role: event.target.value as CatalogCredit['role'] } : item))}>
        {creditRoles.filter(role => role === 'legacyUnspecified' || (credit.subjectType === 'artist' ? ['primary', 'featured', 'performer', 'composer', 'producer', 'remixer'] : ['label', 'publisher', 'distributor', 'presenter']).includes(role)).map(role => <option key={role} value={role}>{roleText(role)}</option>)}
      </select></label>
      <button className={styles.button} type="button" onClick={() => onChange(credits.filter((_, i) => i !== index).map((item, order) => ({ ...item, order })))}>{t('catalog.remove_credit')}</button>
    </div>)}
    <div className={styles.actions}>
      <label>{t('catalog.subject')}<select className={styles.input} value={kind} onChange={event => { setKind(event.target.value as typeof kind); setSearch(''); }}><option value="artist">{t('duplicates.artist')}</option><option value="organization">{t('catalog.organization')}</option></select></label>
      <label>{t('catalog.search')}<input className={styles.input} maxLength={100} value={text} onChange={event => setText(event.target.value)} /></label>
      <button className={styles.button} type="button" onClick={() => setSearch(text.trim())}>{t('catalog.search')}</button>
    </div>
    {query.isFetching && <p role="status">{t('common.loading')}</p>}{query.isError && <p role="alert">{t('common.error')}</p>}
    {query.data?.items.map(item => <button className={styles.button} key={item.id} type="button" disabled={credits.length >= 50 || credits.some(credit => credit.subjectId === item.id && credit.role === (kind === 'artist' ? 'primary' : 'label'))}
      onClick={() => onChange([...credits, { creditId: crypto.randomUUID(), subjectType: kind, subjectId: item.id, role: kind === 'artist' ? 'primary' : 'label', order: credits.length }])}>
      {t('catalog.add_credit')} · {'name' in item.fields ? item.fields.name : ''} · {t(`field.${item.visibility}`)}</button>)}
  </fieldset>;
}
export function CatalogFields({ item, fields, disabled, onChange }: { item: CatalogItem; fields: Fields; disabled: boolean; onChange: (fields: Fields) => void }) {
  const t = useAdminText();
  const set = (key: string, value: unknown) => onChange({ ...fields, [key]: value } as Fields);
  return <fieldset disabled={disabled} className={styles.editor}>
    {Object.entries(fields).filter(([key]) => !['credits', 'attributionStatus'].includes(key)).map(([key, value]) => {
      const label = t(`field.${key}`);
      if (key === 'releaseDate' || key === 'birthDate') {
        const date = value as { year: number; month: number | null; day: number | null } | null;
        return <fieldset className={styles.date} key={key}><legend>{label}</legend>{(['year', 'month', 'day'] as const).map(part => <label key={part}>{t(`field.${part}`)}<input className={styles.input} type="number" min={1} max={part === 'year' ? 9999 : part === 'month' ? 12 : 31} value={date?.[part] ?? ''} disabled={disabled || part !== 'year' && !date || part === 'day' && !date?.month} onChange={event => {
          const number = event.target.value ? Number(event.target.value) : null;
          set(key, part === 'year' ? number === null ? null : { year: number, month: date?.month ?? null, day: date?.day ?? null } : { ...date, [part]: number, ...(part === 'month' && number === null ? { day: null } : {}) });
        }} /></label>)}</fieldset>;
      }
      if (key === 'organizationType') return <label className={styles.field} key={key}>{label}<select className={styles.input} value={String(value)} onChange={event => set(key, event.target.value)}>{['label', 'publisher', 'distributor', 'archive', 'broadcaster', 'studio', 'other'].map(type => <option key={type} value={type}>{t(`organization.${type}`)}</option>)}</select></label>;
      if (key === 'bio' || key === 'description') return <label className={styles.field} key={key}>{label}<textarea className={styles.input} value={String(value)} maxLength={10000} rows={5} onChange={event => set(key, event.target.value)} /></label>;
      return <label className={styles.field} key={key}>{label}<input className={styles.input} type={key === 'trackNumber' ? 'number' : 'text'} min={1} max={9999} maxLength={key === 'name' ? 200 : 300} required={key === 'name' || key === 'title'} value={value == null ? '' : String(value)} onChange={event => set(key, key === 'trackNumber' ? event.target.value ? Number(event.target.value) : null : event.target.value)} /></label>;
    })}
    {'credits' in fields && <>
      <label className={styles.field}>{t('catalog.attribution')}<select className={styles.input} value={fields.attributionStatus} onChange={event => onChange({ ...fields, attributionStatus: event.target.value as 'unknown' | 'documented', credits: fields.credits ?? [] })}>
        <option value="unknown">{t('catalog.unknown')}</option><option value="documented">{t('catalog.documented')}</option>
      </select></label>
      <CreditEditor credits={fields.credits ?? []} disabled={disabled} onChange={credits => onChange({ ...fields, credits })} />
    </>}
    {item.kind === 'audioTrack' && <p className={styles.muted}>{t('catalog.automatic_order')}</p>}
  </fieldset>;
}
