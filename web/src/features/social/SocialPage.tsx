import { lazy, Suspense, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { browserSessionQuery, browserSessionResolvingQuery } from '../../api/session';
import { getSocialPage, getSocialProfile, getSocialRelationship, lookupSocialProfile,
  type SocialListKind, type SocialProfile } from '../../api/social';
import { useLocalization } from '../../localization/LocalizationProvider';
import { useSocialActions } from './useSocialActions';
import { listenerCapabilitiesQuery } from '../../api/listenerCapabilities';
import { SocialAvatar } from './SocialAvatar';
import { aliasProblem, socialHandlePattern } from './socialIdentityInput';
import styles from './SocialPage.module.css';

const tabs: readonly SocialListKind[] = ['friends', 'incoming', 'outgoing', 'blocks'];
const ListeningSharingSettings = lazy(() => import('./ListeningSharingSettings').then(module => ({ default: module.ListeningSharingSettings })));
const FriendsListening = lazy(() => import('./FriendsListening').then(module => ({ default: module.FriendsListening })));
const RoomsPanel = lazy(() => import('./RoomsPanel').then(module => ({ default: module.RoomsPanel })));
const ReportDialog = lazy(() => import('./ReportDialog'));
type Report = (socialId: string, label: string, trigger: HTMLElement) => void;
const ConfirmActionDialog = lazy(() => import('./ConfirmActionDialog').then(module => ({ default: module.ConfirmActionDialog })));
/**
 * A Remove, Block or Deactivate gesture captured when its dialog opened; Remove keeps the relationship revision
 * observed then.
 */
type SafetyIntent = { action: 'remove'; targetSocialId: string; expectedRevision: number; alias: string }
  | { action: 'block'; targetSocialId: string; alias: string }
  | { action: 'deactivate' };

const safetyCopy = {
  remove: ['social.remove_confirm_title', 'social.remove_confirm_copy', 'social.remove'],
  block: ['social.block_confirm_title', 'social.block_confirm_copy', 'social.block'],
  deactivate: ['social.deactivate_confirm_title', 'social.deactivate_confirm', 'social.deactivate']
} as const;

/**
 * Removing a friend, blocking and deactivating cannot simply be undone (reconnecting needs a new request,
 * unblocking and reactivating restore nothing), so each asks first and says what changes. Confirming closes the
 * dialog and runs the captured gesture; its outcome appears in the page's shared action status. Closing returns focus
 * to the trigger.
 */
const SafetyConfirmation = ({ intent, actions, onClose, trigger }: { intent: SafetyIntent; actions: ReturnType<typeof useSocialActions>;
  onClose: () => void; trigger: RefObject<HTMLElement | null> }) => {
  const { t } = useLocalization();
  const [title, description, confirmLabel] = safetyCopy[intent.action];
  const variables = intent.action === 'deactivate' ? undefined : { alias: intent.alias };
  return <Suspense fallback={null}><ConfirmActionDialog title={t(title, variables)} description={t(description, variables)}
    confirmLabel={t(confirmLabel)} confirmDisabled={actions.busy || Boolean(actions.uncertain)} returnFocusRef={trigger}
    onCancel={onClose} onConfirm={() => {
      onClose();
      if (intent.action === 'deactivate') { void actions.run(intent); return; }
      const { alias: _alias, ...action } = intent;
      void actions.run(action);
    }} /></Suspense>;
};

const IdentityForm = ({ profile, actions }: { profile: SocialProfile | null; actions: ReturnType<typeof useSocialActions> }) => {
  const { t } = useLocalization();
  const id = useId();
  const [handle, setHandle] = useState(profile?.handle ?? '');
  const [alias, setAlias] = useState(profile?.alias ?? '');
  const [discoverable, setDiscoverable] = useState(profile?.discoverable ?? true);
  const [deactivating, setDeactivating] = useState(false);
  const deactivateTrigger = useRef<HTMLButtonElement>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // The browser already blocks an invalid nickname; this guard also covers programmatic submission.
    if (aliasProblem(alias)) return;
    void actions.run({ action: 'profile', expectedRevision: profile?.revision ?? 0, handle: handle.toLowerCase(), alias, discoverable });
  };
  // A suspended listener cannot edit or reactivate, so the form stays visible but read-only.
  const suspended = profile?.suspended === true;
  return <section className={styles.panel}>
    <h2>{t('social.identity')}</h2>
    {suspended ? <p className={styles.error} role="status">{t('social.suspended')}</p>
      : profile && !profile.active && <p className={styles.status}>{t('social.inactive')}</p>}
    <p className={styles.muted}>{t('social.identity_hint')}</p>
    <form aria-label={t('social.identity')} onSubmit={submit}>
      {/* The format hint matters only while the handle can still be chosen; a set handle is locked. */}
      <label className={styles.field}>{t('social.handle')}<input required autoComplete="off" pattern={socialHandlePattern} minLength={3} maxLength={24}
        title={profile ? undefined : t('social.handle_format')} aria-describedby={profile ? undefined : `${id}-handle`}
        value={handle} disabled={Boolean(profile)} onChange={event => setHandle(event.target.value)} /></label>
      {!profile && <p className={styles.fieldHint} id={`${id}-handle`}>{t('social.handle_format')}</p>}
      {/* No maxLength: it counts UTF-16 units, which would refuse 50 emoji the server accepts. */}
      <label className={styles.field}>{t('social.alias')}<input required autoComplete="off" aria-describedby={`${id}-alias`} value={alias} onChange={event => {
        const problem = aliasProblem(event.target.value);
        event.target.setCustomValidity(problem ? t(problem) : '');
        setAlias(event.target.value);
      }} /></label>
      <p className={styles.fieldHint} id={`${id}-alias`}>{t('social.alias_hint')}</p>
      <label className={styles.check}><input type="checkbox" checked={discoverable} onChange={event => setDiscoverable(event.target.checked)} />{t('social.discoverable')}</label>
      <button className={styles.button} disabled={suspended || actions.busy || Boolean(actions.uncertain)}>{t(profile ? profile.active ? 'social.save_profile' : 'social.reactivate' : 'social.create_profile')}</button>
    </form>
    {profile?.active && <div className={styles.actions}><button className={styles.danger} disabled={actions.busy || Boolean(actions.uncertain)} type="button"
      ref={deactivateTrigger} onClick={() => setDeactivating(true)}>{t('social.deactivate')}</button></div>}
    {deactivating && <SafetyConfirmation intent={{ action: 'deactivate' }} actions={actions} onClose={() => setDeactivating(false)} trigger={deactivateTrigger} />}
  </section>;
};

const FriendLookup = ({ viewerId, enabled, actions, report }: { viewerId: string; enabled: boolean; actions: ReturnType<typeof useSocialActions>; report: Report }) => {
  const { t } = useLocalization();
  const hintId = useId();
  const [handle, setHandle] = useState('');
  const [submitted, setSubmitted] = useState('');
  const result = useQuery({ queryKey: ['social', viewerId, 'lookup', submitted],
    queryFn: ({ signal }) => lookupSocialProfile(viewerId, submitted, signal), enabled: Boolean(submitted) && enabled, retry: false });
  const profile = result.data?.profile;
  const relationship = useQuery({ queryKey: ['social', viewerId, 'relationship', profile?.socialId],
    queryFn: () => getSocialRelationship(viewerId, profile!.socialId), enabled: Boolean(profile), retry: false });
  const relation = relationship.data?.relationship;
  const [blocking, setBlocking] = useState<SafetyIntent | null>(null);
  const blockTrigger = useRef<HTMLButtonElement>(null);
  return <section className={styles.panel}>
    <h2>{t('social.find')}</h2><p className={styles.muted} id={hintId}>{t('social.find_hint')}</p>
    <form aria-label={t('social.find')} className={styles.search} onSubmit={event => { event.preventDefault(); setSubmitted(handle.trim().toLowerCase()); }}>
      <label className={styles.field}>{t('social.handle')}<input required maxLength={24} pattern={socialHandlePattern} title={t('social.handle_format')} aria-describedby={hintId}
        value={handle} disabled={!enabled} onChange={event => setHandle(event.target.value)} /></label>
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
      {/* Any identity can be blocked, including someone found by handle with no relationship yet. A missing
          relationship means the result is the viewer's own profile. */}
      {relation && relation.state !== 'blocked' && <button className={styles.secondary} disabled={actions.busy || Boolean(actions.uncertain)} ref={blockTrigger} onClick={() => setBlocking({ action: 'block', targetSocialId: profile.socialId, alias: profile.alias })}>{t('social.block')}</button>}
      {/* The pair state is null for the viewer's own handle, so a listener is never offered a self-report. */}
      {relation && <button className={styles.secondary} disabled={actions.busy || Boolean(actions.uncertain)} onClick={event => report(profile.socialId, `${profile.alias} (@${profile.handle})`, event.currentTarget)}>{t('social.report')}</button>}
    </div>}
    {/* Without the relationship no action can be offered safely, so a failed read says so instead of showing nothing. */}
    {profile && relationship.isError && <p className={styles.error} role="alert">{t('social.relationship_error')} <button type="button" className={styles.secondary}
      disabled={relationship.isFetching} onClick={() => relationship.refetch()}>{t('common.action.retry')}</button></p>}
    {blocking && <SafetyConfirmation intent={blocking} actions={actions} onClose={() => setBlocking(null)} trigger={blockTrigger} />}
  </section>;
};

const Relationships = ({ viewerId, actions, report }: { viewerId: string; actions: ReturnType<typeof useSocialActions>; report: Report }) => {
  const { t } = useLocalization();
  const [kind, setKind] = useState<SocialListKind>('friends');
  const result = useInfiniteQuery({ queryKey: ['social', viewerId, 'relationships', kind],
    queryFn: ({ pageParam, signal }) => getSocialPage(viewerId, kind, pageParam, signal),
    initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined, retry: false });
  const rows = [...new Map((result.data?.pages ?? []).flatMap(page => page.items).map(row => [row.socialId, row])).values()];
  const [confirming, setConfirming] = useState<SafetyIntent | null>(null);
  const confirmTrigger = useRef<HTMLElement | null>(null);
  const askFirst = (event: MouseEvent<HTMLElement>, intent: SafetyIntent) => { confirmTrigger.current = event.currentTarget; setConfirming(intent); };
  const id = useId();
  /**
   * WAI-ARIA tabs with automatic activation: arrows wrap, Home and End jump, and only the selected tab is in the
   * Tab order so one Tab press moves on to the list.
   */
  /** Roving tab focus for unmodified keys only, so browser shortcuts such as Alt+ArrowLeft (Back) still work. */
  const moveTab = (event: KeyboardEvent, from: SocialListKind) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = tabs.indexOf(from);
    const target = ({ ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 } as Record<string, number>)[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = tabs[(target + tabs.length) % tabs.length];
    setKind(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };
  const content = result.isPending ? <p className={styles.empty} role="status">{t('social.loading')}</p>
    : result.isError ? <p className={styles.error} role="alert">{t('social.error')}</p>
    : !rows.length ? <p className={styles.empty}>{t('social.empty')}</p>
    : <ul className={styles.list}>{rows.map(row => <li className={styles.row} key={row.socialId}>
      <SocialAvatar profile={row.profile} /><div className={styles.rowContent}><strong>{row.profile?.alias ?? t('social.blocked_profile')}</strong>
        <span>{row.profile ? `@${row.profile.handle}` : row.socialId.slice(-8)}</span></div>
      <div className={styles.rowActions}>
        {kind === 'incoming' && <button className={styles.button} disabled={actions.busy || Boolean(actions.uncertain)} onClick={() => actions.run({ action: 'accept', targetSocialId: row.socialId, expectedRevision: row.revision })}>{t('social.accept')}</button>}
        {/* Declining, cancelling and unblocking are easily redone, so only Remove and Block ask first. */}
        <button className={styles.secondary} disabled={actions.busy || Boolean(actions.uncertain)} onClick={event => kind === 'friends'
          ? askFirst(event, { action: 'remove', targetSocialId: row.socialId, expectedRevision: row.revision, alias: row.profile?.alias ?? row.socialId.slice(-8) })
          : actions.run({ action: kind === 'incoming' ? 'decline' : kind === 'outgoing' ? 'cancel' : 'unblock', targetSocialId: row.socialId, expectedRevision: row.revision })}>
          {t(kind === 'friends' ? 'social.remove' : kind === 'incoming' ? 'social.decline' : kind === 'outgoing' ? 'social.cancel_request' : 'social.unblock')}</button>
        {kind !== 'blocks' && <button className={styles.secondary} disabled={actions.busy || Boolean(actions.uncertain)} onClick={event => askFirst(event, { action: 'block', targetSocialId: row.socialId, alias: row.profile?.alias ?? row.socialId.slice(-8) })}>{t('social.block')}</button>}
        {/* Blocked rows stay reportable: blocking and then reporting is a common safety sequence. */}
        <button className={styles.secondary} disabled={actions.busy || Boolean(actions.uncertain)} onClick={event => report(row.socialId,
          row.profile ? `${row.profile.alias} (@${row.profile.handle})` : `${t('social.blocked_profile')} ${row.socialId.slice(-8)}`, event.currentTarget)}>{t('social.report')}</button>
      </div>
    </li>)}</ul>;
  return <section className={styles.panel}>
    <h2>{t('social.friends')}</h2>
    <div className={styles.tabs} role="tablist" aria-label={t('social.friends')}>{tabs.map(tab => <button type="button" className={styles.tab} role="tab" key={tab}
      id={`${id}-tab-${tab}`} aria-controls={`${id}-panel-${tab}`} aria-selected={kind === tab} tabIndex={kind === tab ? 0 : -1}
      onKeyDown={event => moveTab(event, tab)} onClick={() => setKind(tab)}>{t(`social.${tab}`)}</button>)}</div>
    {/* Every tab's panel exists so each aria-controls resolves; only the selected one is shown and filled. */}
    {tabs.map(tab => <div role="tabpanel" key={tab} id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0} hidden={kind !== tab}>
      {kind === tab && <>{content}
        {result.hasNextPage && <button className={styles.secondary} disabled={result.isFetchingNextPage} onClick={() => result.fetchNextPage()}>{t('common.action.load_more')}</button>}</>}
    </div>)}
    {confirming && <SafetyConfirmation intent={confirming} actions={actions} onClose={() => setConfirming(null)} trigger={confirmTrigger} />}
  </section>;
};

const SocialSpace = ({ viewerId }: { viewerId: string }) => {
  const { t } = useLocalization();
  const profile = useQuery({ queryKey: ['social', viewerId, 'profile'], queryFn: ({ signal }) => getSocialProfile(viewerId, signal), retry: false });
  const actions = useSocialActions(viewerId);
  const [reporting, setReporting] = useState<{ socialId: string; label: string } | null>(null);
  const reportTrigger = useRef<HTMLElement | null>(null);
  const report: Report = (socialId, label, trigger) => { reportTrigger.current = trigger; setReporting({ socialId, label }); };
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
      <div className={styles.stack}><Relationships viewerId={viewerId} actions={actions} report={report} /><FriendLookup viewerId={viewerId} enabled={profile.data.profile?.active ?? false} actions={actions} report={report} /></div>
      {profile.data.profile?.active && !profile.isError && <Suspense fallback={null}><ListeningSharingSettings viewerId={viewerId} /><FriendsListening viewerId={viewerId} /></Suspense>}
      <IdentityForm key={profile.data.profile?.revision ?? 0} profile={profile.data.profile} actions={actions} />
    </div>}
    {reporting && <Suspense fallback={null}><ReportDialog target={reporting} busy={actions.busy || Boolean(actions.uncertain)} run={actions.run}
      onClose={() => setReporting(null)} returnFocusRef={reportTrigger} /></Suspense>}
  </>;
};

/**
 * Account-keyed route prevents one listener's social state from surviving identity changes. While social is
 * disabled the route is no longer advertised but stays reachable for the preserved reads and safety actions.
 */
export const SocialPage = () => {
  const { t } = useLocalization();
  const session = useQuery(browserSessionQuery());
  const resolving = useQuery(browserSessionResolvingQuery());
  const capabilities = useQuery(listenerCapabilitiesQuery());
  return <div className={styles.page}>
    {capabilities.data && !capabilities.data.social?.enabled && <p className={styles.status} role="status">{t('social.unavailable')}</p>}
    {session.isPending || resolving.data ? <p role="status">{t('social.loading')}</p> : session.isError
      ? <section className={styles.panel}><p role="alert">{t('social.error')}</p><button className={styles.secondary} onClick={() => session.refetch()}>{t('social.refresh')}</button></section> : session.data
      ? <SocialSpace key={session.data.user.id} viewerId={session.data.user.id} />
      : <section className={styles.panel}><h1>{t('social.title')}</h1><p className={styles.description}>{t('social.sign_in')}</p><div className={styles.actions}><Link className={styles.button} to="/login?returnTo=%2Fsocial">{t('common.action.log_in')}</Link></div></section>}
  </div>;
};
