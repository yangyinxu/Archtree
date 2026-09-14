import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { browserSessionQuery, browserSessionResolvingQuery } from '../../api/session';
import { getSocialPage, getSocialProfile, getSocialRelationship, lookupSocialProfile,
  type SocialCard, type SocialListKind, type SocialProfile } from '../../api/social';
import { useLocalization } from '../../localization/LocalizationProvider';
import { useSocialActions } from './useSocialActions';
import styles from './SocialPage.module.css';

const tabs = ['friends', 'incoming', 'outgoing', 'blocks'] as const;
const ListeningSharingSettings = lazy(() => import('./ListeningSharingSettings').then(module => ({ default: module.ListeningSharingSettings })));
const FriendsListening = lazy(() => import('./FriendsListening').then(module => ({ default: module.FriendsListening })));
const RoomsPanel = lazy(() => import('./RoomsPanel').then(module => ({ default: module.RoomsPanel })));
/** Generated public identity uses only the explicitly chosen social alias. */
export const SocialAvatar = ({ profile }: { profile: SocialCard | null }) => <span className={styles.avatar} aria-hidden="true">
  {profile ? [...profile.alias][0].toLocaleUpperCase() : '·'}
</span>;

const IdentityForm = ({ profile, actions }: { profile: SocialProfile | null; actions: ReturnType<typeof useSocialActions> }) => {
  const { t } = useLocalization();
  const [handle, setHandle] = useState(profile?.handle ?? '');
  const [alias, setAlias] = useState(profile?.alias ?? '');
  const [discoverable, setDiscoverable] = useState(profile?.discoverable ?? true);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void actions.run({ action: 'profile', expectedRevision: profile?.revision ?? 0, handle: handle.toLowerCase(), alias, discoverable });
  };
  return <section className={styles.panel}>
    <h2>{t('social.identity')}</h2>
    {profile && !profile.active && <p className={styles.status}>{t('social.inactive')}</p>}
    <p className={styles.muted}>{t('social.identity_hint')}</p>
    <form aria-label={t('social.identity')} onSubmit={submit}>
      <label className={styles.field}>{t('social.handle')}<input required autoComplete="off" pattern="[a-zA-Z][a-zA-Z0-9_]{2,23}" minLength={3} maxLength={24} value={handle} disabled={Boolean(profile)} onChange={event => setHandle(event.target.value)} /></label>
      <label className={styles.field}>{t('social.alias')}<input required autoComplete="off" maxLength={50} value={alias} onChange={event => setAlias(event.target.value)} /></label>
      <label className={styles.check}><input type="checkbox" checked={discoverable} onChange={event => setDiscoverable(event.target.checked)} />{t('social.discoverable')}</label>
      <button className={styles.button} disabled={actions.busy || Boolean(actions.uncertain)}>{t(profile ? profile.active ? 'social.save_profile' : 'social.reactivate' : 'social.create_profile')}</button>
    </form>
    {profile?.active && <div className={styles.actions}><button className={styles.danger} disabled={actions.busy || Boolean(actions.uncertain)} type="button" onClick={() => {
      if (window.confirm(t('social.deactivate_confirm'))) void actions.run({ action: 'deactivate' });
    }}>{t('social.deactivate')}</button></div>}
  </section>;
};

const FriendLookup = ({ viewerId, enabled, actions }: { viewerId: string; enabled: boolean; actions: ReturnType<typeof useSocialActions> }) => {
  const { t } = useLocalization();
  const [handle, setHandle] = useState('');
  const [submitted, setSubmitted] = useState('');
  const result = useQuery({ queryKey: ['social', viewerId, 'lookup', submitted],
    queryFn: ({ signal }) => lookupSocialProfile(viewerId, submitted, signal), enabled: Boolean(submitted) && enabled, retry: false });
  const profile = result.data?.profile;
  const relationship = useQuery({ queryKey: ['social', viewerId, 'relationship', profile?.socialId],
    queryFn: () => getSocialRelationship(viewerId, profile!.socialId), enabled: Boolean(profile), retry: false });
  const relation = relationship.data?.relationship;
  return <section className={styles.panel}>
    <h2>{t('social.find')}</h2><p className={styles.muted}>{t('social.find_hint')}</p>
    <form aria-label={t('social.find')} className={styles.search} onSubmit={event => { event.preventDefault(); setSubmitted(handle.trim().toLowerCase()); }}>
      <label className={styles.field}>{t('social.handle')}<input required maxLength={24} pattern="[a-zA-Z][a-zA-Z0-9_]{2,23}" value={handle} disabled={!enabled} onChange={event => setHandle(event.target.value)} /></label>
      <button className={styles.button} disabled={!enabled || result.isFetching}>{t('social.lookup')}</button>
    </form>
    {result.isFetching && <p className={styles.empty} role="status">{t('social.loading')}</p>}
    {result.isError && <p className={styles.error} role="alert">{t('social.error')}</p>}
    {result.data && !profile && <p className={styles.empty}>{t('social.not_found')}</p>}
    {profile && <div className={styles.row}><SocialAvatar profile={profile} /><div className={styles.rowContent}><strong>{profile.alias}</strong><span>@{profile.handle}</span></div>
      {relation?.state === 'none' && <button className={styles.button} disabled={actions.busy || Boolean(actions.uncertain)} onClick={() => actions.run({ action: 'request', targetSocialId: profile.socialId, expectedRevision: relation.revision })}>{t('social.request')}</button>}
      {relation?.state === 'outgoing' && <span className={styles.muted}>{t('social.outgoing')}</span>}
      {relation?.state === 'friends' && <span className={styles.muted}>{t('social.friends')}</span>}
      {relation?.state === 'incoming' && <button className={styles.button} disabled={actions.busy || Boolean(actions.uncertain)} onClick={() => actions.run({ action: 'accept', targetSocialId: profile.socialId, expectedRevision: relation.revision })}>{t('social.accept')}</button>}
    </div>}
  </section>;
};

const Relationships = ({ viewerId, actions }: { viewerId: string; actions: ReturnType<typeof useSocialActions> }) => {
  const { t } = useLocalization();
  const [kind, setKind] = useState<SocialListKind>('friends');
  const result = useInfiniteQuery({ queryKey: ['social', viewerId, 'relationships', kind],
    queryFn: ({ pageParam, signal }) => getSocialPage(viewerId, kind, pageParam, signal),
    initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined, retry: false });
  const rows = [...new Map((result.data?.pages ?? []).flatMap(page => page.items).map(row => [row.socialId, row])).values()];
  return <section className={styles.panel}>
    <h2>{t('social.friends')}</h2>
    <div className={styles.tabs} role="tablist" aria-label={t('social.friends')}>{tabs.map(tab => <button type="button" className={styles.tab} role="tab" aria-selected={kind === tab} key={tab} onClick={() => setKind(tab)}>{t(`social.${tab}`)}</button>)}</div>
    {result.isPending ? <p className={styles.empty} role="status">{t('social.loading')}</p>
      : result.isError ? <p className={styles.error} role="alert">{t('social.error')}</p>
      : !rows.length ? <p className={styles.empty}>{t('social.empty')}</p>
      : <ul className={styles.list}>{rows.map(row => <li className={styles.row} key={row.socialId}>
        <SocialAvatar profile={row.profile} /><div className={styles.rowContent}><strong>{row.profile?.alias ?? t('social.blocked_profile')}</strong>
          <span>{row.profile ? `@${row.profile.handle}` : row.socialId.slice(-8)}</span></div>
        <div className={styles.rowActions}>
          {kind === 'incoming' && <button className={styles.button} disabled={actions.busy || Boolean(actions.uncertain)} onClick={() => actions.run({ action: 'accept', targetSocialId: row.socialId, expectedRevision: row.revision })}>{t('social.accept')}</button>}
          <button className={styles.secondary} disabled={actions.busy || Boolean(actions.uncertain)} onClick={() => actions.run({ action: kind === 'friends' ? 'remove' : kind === 'incoming' ? 'decline' : kind === 'outgoing' ? 'cancel' : 'unblock', targetSocialId: row.socialId, expectedRevision: row.revision })}>
            {t(kind === 'friends' ? 'social.remove' : kind === 'incoming' ? 'social.decline' : kind === 'outgoing' ? 'social.cancel_request' : 'social.unblock')}</button>
          {kind !== 'blocks' && <button className={styles.secondary} disabled={actions.busy || Boolean(actions.uncertain)} onClick={() => actions.run({ action: 'block', targetSocialId: row.socialId })}>{t('social.block')}</button>}
        </div>
      </li>)}</ul>}
    {result.hasNextPage && <button className={styles.secondary} disabled={result.isFetchingNextPage} onClick={() => result.fetchNextPage()}>{t('common.action.load_more')}</button>}
  </section>;
};

const SocialSpace = ({ viewerId }: { viewerId: string }) => {
  const { t } = useLocalization();
  const profile = useQuery({ queryKey: ['social', viewerId, 'profile'], queryFn: ({ signal }) => getSocialProfile(viewerId, signal), retry: false });
  const actions = useSocialActions(viewerId);
  useEffect(() => {
    if (profile.data?.profile && !profile.data.profile.active) void import('./roomSession').then(module => module.roomSession.stop());
  }, [profile.data]);
  return <>
    <div className={styles.hero}><div><p className={styles.eyebrow}>Finitude · {t('social.nav')}</p><h1>{t('social.title')}</h1><p className={styles.description}>{t('social.description')}</p></div>
      <div className={styles.actions}><Link className={styles.secondary} to="/social/shares">{t('music_shares.title')}</Link><button className={styles.secondary} onClick={() => actions.refresh()}>{t('social.refresh')}</button></div></div>
    {actions.message && <div className={actions.uncertain ? styles.error : styles.status} role="status">{t(actions.message)}
      {actions.uncertain && <div className={styles.actions}><button className={styles.secondary} disabled={actions.busy} onClick={actions.check}>{t('social.check_outcome')}</button><button className={styles.secondary} disabled={actions.busy} onClick={actions.retry}>{t('social.retry_same')}</button></div>}
    </div>}
    {profile.isError && <p className={styles.error} role="alert">{t('social.error')}</p>}
    {profile.isPending ? <p role="status">{t('social.loading')}</p> : profile.data && <div className={styles.grid}>
      {profile.data.profile?.active && <Suspense fallback={<section className={styles.panel} role="status">{t('social.loading')}</section>}><RoomsPanel viewerId={viewerId} profile={profile.data.profile} /></Suspense>}
      <div className={styles.stack}><Relationships viewerId={viewerId} actions={actions} /><FriendLookup viewerId={viewerId} enabled={profile.data.profile?.active ?? false} actions={actions} /></div>
      {profile.data.profile?.active && !profile.isError && <Suspense fallback={null}><ListeningSharingSettings viewerId={viewerId} /><FriendsListening viewerId={viewerId} /></Suspense>}
      <IdentityForm key={profile.data.profile?.revision ?? 0} profile={profile.data.profile} actions={actions} />
    </div>}
  </>;
};

/** Account-keyed route prevents one listener's social state from surviving identity changes. */
export const SocialPage = () => {
  const { t } = useLocalization();
  const session = useQuery(browserSessionQuery());
  const resolving = useQuery(browserSessionResolvingQuery());
  return <div className={styles.page}>
    {session.isPending || resolving.data ? <p role="status">{t('social.loading')}</p> : session.isError
      ? <section className={styles.panel}><p role="alert">{t('social.error')}</p><button className={styles.secondary} onClick={() => session.refetch()}>{t('social.refresh')}</button></section> : session.data
      ? <SocialSpace key={session.data.user.id} viewerId={session.data.user.id} />
      : <section className={styles.panel}><h1>{t('social.title')}</h1><p className={styles.description}>{t('social.sign_in')}</p><div className={styles.actions}><Link className={styles.button} to="/login">{t('common.action.log_in')}</Link></div></section>}
  </div>;
};
