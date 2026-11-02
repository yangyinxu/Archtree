import { useEffect, useId, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, Search } from 'lucide-react';
import { useAdminAccess } from './AdminAccess';
import { adminEndpointRequest } from './adminTransport';
import type { CatalogKind, CatalogItem } from './catalogApi';
import { useAdminDeliveryText } from './adminPageText';
import common from './adminStyles';
import styles from './VideoUpload.module.css';

export interface VideoCatalogSelection { id: string; kind: CatalogKind; name: string; revision: string }
const catalogName = (item: CatalogItem) => ('name' in item.fields ? item.fields.name : item.fields.title).trim();

/** Searches the private ready catalog; a transient query never clears a committed selection. */
export function VideoCatalogLookup({ label, kinds, value, onChange, disabled, allowNone = false }: {
  label: string; kinds: readonly CatalogKind[]; value: VideoCatalogSelection | null;
  onChange: (value: VideoCatalogSelection | null) => void; disabled: boolean; allowNone?: boolean;
}) {
  const t = useAdminDeliveryText(['video.']), access = useAdminAccess(), id = useId();
  const field = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [text, setText] = useState(''), [search, setSearch] = useState('');
  const [active, setActive] = useState(-1);
  const close = (focus = false) => { if (focus) input.current?.focus({ preventScroll: true }); setOpen(false); setText(''); setActive(-1); };
  const show = () => { setText(value?.name ?? ''); setOpen(true); setActive(-1); };
  useEffect(() => { const timer = window.setTimeout(() => { setSearch(text.trim()); setActive(-1); }, 250); return () => clearTimeout(timer); }, [text]);
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (!field.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  const query = useInfiniteQuery({
    queryKey: ['admin-video-lookup', access.viewerId, access.epoch, access.generation, kinds, search],
    initialPageParam: Object.fromEntries(kinds.map(kind => [kind, null])) as Record<string, string | null>,
    queryFn: async ({ signal, pageParam }) => {
      const { catalogList } = await import('./catalogApi');
      const pages = await Promise.all(Object.entries(pageParam).map(async ([kind, cursor]) => {
        const result = await adminEndpointRequest(`/catalog/${kind}?${new URLSearchParams({ query: search, ...(cursor ? { cursor } : {}) })}`,
          catalogList.refine(result => result.items.every(item => item.kind === kind)), { signal });
        return { kind, ...result };
      }));
      return { items: pages.flatMap(page => page.items), next: Object.fromEntries(pages.filter(page => page.nextCursor).map(page => [page.kind, page.nextCursor])) as Record<string, string> };
    },
    getNextPageParam: page => Object.keys(page.next).length ? page.next : undefined,
    enabled: access.active && open && !disabled, retry: false, gcTime: 0
  });
  const rows = [...new Map((query.data?.pages.flatMap(page => page.items) ?? []).map(item => [`${item.kind}:${item.id}`, item])).values()];
  const optionCount = rows.length + (allowNone ? 1 : 0);
  const choose = (index: number) => {
    if (allowNone && index === 0) onChange(null);
    else { const item = rows[index - (allowNone ? 1 : 0)]; if (item) onChange({ id: item.id, kind: item.kind, name: catalogName(item), revision: item.revision }); }
    close(true);
  };
  return <div ref={field} className={`${common.field} ${styles.lookup}`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } }}>
    <label htmlFor={id}>{label}</label>
    <div className={styles.lookupInput}><Search size={18} aria-hidden="true" />
      <input ref={input} id={id} className={common.input} disabled={disabled} value={open ? text : value?.name ?? ''} maxLength={100}
        role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-results`} aria-activedescendant={open && active >= 0 && active < optionCount ? `${id}-${active}` : undefined}
        autoComplete="off" onFocus={show} onClick={() => { if (!open) show(); }} onChange={event => { setText(event.target.value); setOpen(true); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActive(index => !optionCount ? -1 : index < 0 ? event.key === 'ArrowDown' ? 0 : optionCount - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + optionCount) % optionCount); }
          if (event.key === 'Enter' && open && active >= 0 && active < optionCount) { event.preventDefault(); choose(active); }
        }} />
      <button type="button" disabled={disabled} className={styles.toggle} aria-label={t(open ? 'video.lookup_close' : 'video.lookup_open')} aria-expanded={open} aria-controls={`${id}-results`}
        onClick={() => { if (open) close(true); else { input.current?.focus({ preventScroll: true }); show(); } }}><ChevronDown size={18} aria-hidden="true" /></button>
    </div>
    {open && <div className={styles.results}>
      <div id={`${id}-results`} role="listbox" aria-label={label}>
        {allowNone && <button id={`${id}-0`} role="option" tabIndex={-1} aria-selected={!value} data-active={active === 0 || undefined} type="button" onPointerDown={event => event.preventDefault()} onClick={() => choose(0)}>{t('video.no_album')}</button>}
        {rows.map((item, index) => <button id={`${id}-${index + (allowNone ? 1 : 0)}`} key={`${item.kind}:${item.id}`} type="button" role="option" tabIndex={-1} aria-selected={value?.id === item.id && value.kind === item.kind} data-active={active === index + (allowNone ? 1 : 0) || undefined}
          onPointerDown={event => event.preventDefault()} onClick={() => choose(index + (allowNone ? 1 : 0))}>{catalogName(item)}<small>{t(`catalog.${item.kind}`)}</small></button>)}
      </div>
      {query.isPending && <p role="status">{t('common.loading')}</p>}
      {query.isError && <button className={common.button} type="button" onClick={() => void query.refetch()}>{t('common.retry')}</button>}
      {query.isSuccess && !rows.length && <p>{t('video.lookup_empty')}</p>}
      {query.hasNextPage && <button className={common.button} type="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{t('workbench.more')}</button>}
    </div>}
  </div>;
}
