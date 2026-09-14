import { useId, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { RoomMedia } from '../../api/rooms';
import { useLocalization } from '../../localization/LocalizationProvider';
import styles from './SocialPage.module.css';

interface RoomMediaPickerProps {
  viewerId: string;
  scopeKey: string;
  selected: RoomMedia[];
  onSelectionChange: (items: RoomMedia[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  disabledMediaIds?: ReadonlySet<string>;
}

/** A bounded catalog picker keeps an explicit draft across searches without creating playback or room commands. */
export const RoomMediaPicker = ({ viewerId, scopeKey, selected, onSelectionChange, multiple = false,
  disabled = false, disabledMediaIds }: RoomMediaPickerProps) => {
  const { t } = useLocalization();
  const inputId = useId(), selectionName = useId();
  const [input, setInput] = useState(''), [query, setQuery] = useState('');
  const result = useInfiniteQuery({ queryKey: ['social', viewerId, 'room-media-search', scopeKey, query],
    queryFn: async ({ pageParam, signal }) => {
      const api = await import('../../api/roomMedia'); signal.throwIfAborted();
      return api.searchRoomMedia(viewerId, { query: query || undefined, cursor: pageParam }, signal);
    },
    initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined,
    retry: false });
  const items = result.isError ? [] : [...new Map((result.data?.pages ?? []).flatMap(page => page.items)
    .map(item => [item.mediaTrackId, item])).values()];
  const limit = multiple ? 100 : 1;
  const pick = (item: RoomMedia, checked: boolean) => {
    if (disabled || disabledMediaIds?.has(item.mediaTrackId)) return;
    if (!checked) { onSelectionChange(selected.filter(value => value.mediaTrackId !== item.mediaTrackId)); return; }
    if (selected.some(value => value.mediaTrackId === item.mediaTrackId) || multiple && selected.length >= limit) return;
    onSelectionChange(multiple ? [...selected, item] : [item]);
  };
  return <div className={styles.stack}>
    <p className={styles.muted}>{t('room.media_eligibility')}</p>
    <form className={styles.actions} aria-label={t('room.media_search_label')} onSubmit={event => {
      event.preventDefault(); if (!disabled) setQuery(input.trim());
    }}>
      <label className={styles.field} htmlFor={inputId}>{t('room.media_search_label')}<input id={inputId} type="search"
        autoComplete="off" maxLength={200} value={input} disabled={disabled} onChange={event => setInput([...event.target.value].slice(0, 100).join(''))} /></label>
      <button className={styles.secondary} type="submit" disabled={disabled}>{t('common.action.search')}</button>
    </form>
    {selected.length > 0 && <div>
      <h3>{t('room.media_selected', { count: selected.length })}</h3>
      <ul className={`${styles.list} ${styles.queue}`} aria-label={t('room.media_selected', { count: selected.length })}>
        {selected.map(item => <li key={item.mediaTrackId} className={styles.row}>
          <div className={styles.rowContent}><strong>{item.title}</strong></div>
          <button className={styles.secondary} type="button" disabled={disabled} aria-label={t('room.media_remove', { title: item.title })}
            onClick={() => onSelectionChange(selected.filter(value => value.mediaTrackId !== item.mediaTrackId))}>×</button>
        </li>)}
      </ul>
    </div>}
    {multiple && selected.length >= limit && <p className={styles.muted} role="status">{t('room.media_selection_limit')}</p>}
    {result.isPending ? <p role="status">{t('social.loading')}</p>
      : result.isError ? <p className={styles.error} role="alert">{t('social.error')} <button className={styles.secondary} type="button" disabled={disabled || result.isFetching}
        onClick={() => result.refetch()}>{t('social.refresh')}</button></p>
        : !items.length && !result.hasNextPage && <p className={styles.empty}>{t(query ? 'room.media_no_results' : 'room.no_media', { query })}</p>}
    {items.length > 0 && <div role={multiple ? 'group' : 'radiogroup'} aria-label={t(multiple ? 'room.choose_music' : 'room.request_track')}>
      <ul className={`${styles.list} ${styles.queue}`} aria-label={t('room.media_results')}>
        {items.map(item => {
          const checked = selected.some(value => value.mediaTrackId === item.mediaTrackId);
          const pending = disabledMediaIds?.has(item.mediaTrackId) ?? false;
          return <li key={item.mediaTrackId}>
            <label className={styles.check}>
              <input type={multiple ? 'checkbox' : 'radio'} name={selectionName} checked={checked}
                disabled={disabled || pending || multiple && !checked && selected.length >= limit} onChange={event => pick(item, event.target.checked)} />
              <span className={styles.rowContent}><strong>{item.title}</strong><span className={styles.muted}>
                {`${Math.floor(item.durationMs / 60_000)}:${String(Math.floor(item.durationMs / 1000) % 60).padStart(2, '0')}`}
                {pending && ` · ${t('room.media_pending')}`}</span></span>
            </label>
          </li>;
        })}
      </ul>
    </div>}
    {result.hasNextPage && !result.isError && <button className={styles.secondary} type="button" disabled={disabled || result.isFetching}
      onClick={() => result.fetchNextPage()}>{t('common.action.load_more')}</button>}
    {result.isFetching && !result.isPending && <p role="status">{t('social.loading')}</p>}
  </div>;
};
