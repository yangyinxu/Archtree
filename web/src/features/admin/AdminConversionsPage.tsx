import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ModalDialog } from '../../components/ModalDialog';
import { useLocalization } from '../../localization/LocalizationProvider';
import { AdminGate, useAdminAccess, useAdminText } from './AdminAccess';
import { AdminNav } from './AdminNav';
import { adminWorkspace } from './adminWorkspace';
import { conversionApi } from './conversionApi';
import type { ConversionBatch, ConversionTask, ConversionStore } from './conversionStore';
import type { conversionRunner as ConversionRunner } from './conversionRunner';
import { useOnline } from './useAdminOnline';
import styles from './adminStyles';

const uploadStamp = (batch: ConversionBatch, ids: string[]) => JSON.stringify(batch.tasks.filter(task => ids.includes(task.id)).map(task => ({ id: task.id, source: task.source, result: task.result, intent: task.intent })));
const errorKey = (code: string) => /cancelled/i.test(code) ? 'cancelled' : /source_changed|conflict/i.test(code) ? 'source_changed'
  : code.includes('unsupported') ? 'unsupported' : code.includes('corrupt') || code.includes('incomplete') ? 'corrupt' : /storage|quota/i.test(code) ? 'storage' : 'error';

/** The device queue is separate from server proofreading, while sharing the private Web workbench. */
function Conversions() {
  const t = useAdminText(), access = useAdminAccess(), online = useOnline(), navigate = useNavigate();
  const { t: sharedText } = useLocalization();
  const [params, setParams] = useSearchParams();
  const [batches, setBatches] = useState<ConversionBatch[]>([]);
  const [files, setFiles] = useState<File[]>([]), [rootLabel, setRootLabel] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [invalid, setInvalid] = useState(false);
  const [activeBatch, setActiveBatch] = useState<string | null>(null);
  const [store, setStore] = useState<ConversionStore | null>(null);
  const [runner, setRunner] = useState<typeof ConversionRunner | null>(null);
  const conversionStore = store!, conversionRunner = runner!;
  const [confirm, setConfirm] = useState<{ batch: ConversionBatch; ids: string[]; stamp: string } | null>(null);
  const [progress, setProgress] = useState<{ taskId: string; stage: string; progress: number } | null>(null);
  const folder = useRef<HTMLInputElement>(null), picker = useRef<HTMLInputElement>(null);
  const selectionRevision = useRef(0);
  const dialogFocus = useRef<HTMLElement>(null);
  const supported = Boolean(store?.storageSupported() && runner);
  const rawId = params.get('album') ?? params.get('track') ?? '';
  const sourceId = /^[a-f0-9]{24}$/.test(rawId) ? rawId : '';
  const kind = params.has('album') ? 'albums' : 'tracks';
  const source = useQuery({ queryKey: ['admin-imports', access.viewerId, access.epoch, access.generation, 'conversion-source', kind, sourceId],
    enabled: Boolean(sourceId && access.conversion && online), queryFn: ({ signal }) => conversionApi.source(kind, sourceId, adminWorkspace.capture(), signal),
    retry: false, gcTime: 0, refetchOnWindowFocus: false });
  useEffect(() => { folder.current?.setAttribute('webkitdirectory', ''); }, []);
  useEffect(() => {
    let current = true;
    void import('./conversionStore').then(module => { if (current) setStore(module.conversionStore); });
    void import('./conversionRunner').then(module => { if (current) setRunner(module.conversionRunner); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (!runner) return;
    const refresh = () => setActiveBatch(runner.getActiveBatch()); refresh();
    return runner.subscribe(refresh);
  }, [runner]);
  useEffect(() => {
    let current = true;
    if (!store) return;
    const refresh = () => { void conversionStore.list(access.viewerId).then(items => { if (current && access.active) setBatches(items); }).catch(() => { if (current) setError(true); }); };
    if (supported) refresh();
    const unsubscribe = conversionStore.subscribe(refresh);
    return () => { current = false; unsubscribe(); };
  }, [access.viewerId, access.epoch, access.generation, supported, store]);
  const work = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(false);
    try { await action(); } catch { if (adminWorkspace.getSnapshot().viewerId === access.viewerId) setError(true); }
    finally { setBusy(false); setProgress(null); }
  };
  const choose = (list: FileList | null, directory = false) => {
    if (!list) return;
    const selected = Array.from(list), revision = ++selectionRevision.current, guard = adminWorkspace.capture();
    const commit = (next: File[]) => {
      if (revision !== selectionRevision.current || !adminWorkspace.current(guard)) return;
      if (!next.length || next.length > 100 || next.some(file => file.size < 1 || file.size > 512 * 1024 ** 2)) { setFiles([]); setInvalid(true); return; }
      setFiles(next); setInvalid(false);
      const roots = new Set(next.map(file => (file.webkitRelativePath || '').split('/')[0]).filter(Boolean));
      const label = roots.size === 1 ? [...roots][0] : next[0].name.replace(/\.[^.]+$/, '');
      setRootLabel(label.normalize('NFC').slice(0, 200).replace(/[\uD800-\uDBFF]$/, ''));
    };
    if (!directory) { commit(selected); return; }
    setFiles([]); setInvalid(false);
    if (selected.length > 1024) { commit([]); return; }
    // A folder may contain covers/lyrics; recognize audio bytes without trusting extensions.
    void Promise.all(selected.map(async file => {
      if (/\.(flac|wav)$/i.test(file.name)) return file;
      const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const signature = String.fromCharCode(...header);
      return signature.startsWith('fLaC') || signature.startsWith('RIFF') && signature.slice(8, 12) === 'WAVE' ? file : null;
    })).then(items => commit(items.filter((file): file is File => file !== null))).catch(() => commit([]));
  };
  const download = async (task: ConversionTask) => {
    const guard = adminWorkspace.capture(), file = await conversionStore.getOutputFile(task);
    if (!adminWorkspace.current(guard)) return;
    const url = URL.createObjectURL(file), link = document.createElement('a');
    link.href = url; link.download = file.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const downloadSource = async (task: ConversionTask) => {
    const guard = adminWorkspace.capture(), source = await conversionStore.getSourceFile(task);
    if (!adminWorkspace.current(guard)) return;
    const extension = task.result?.sourceCodec === 'flac' ? '.flac' : '.wav';
    const name = !task.result || /\.(flac|wav)$/i.test(task.filename) ? task.filename : `${task.filename.replace(/\.[^.]+$/, '').slice(0, 250)}${extension}`;
    const file = new File([source], name, { type: 'application/octet-stream' });
    const url = URL.createObjectURL(file), link = document.createElement('a'); link.href = url; link.download = file.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const currentConfirmed = confirm && batches.find(batch => batch.id === confirm.batch.id);
  const stale = Boolean(confirm && (!currentConfirmed || uploadStamp(currentConfirmed, confirm.ids) !== confirm.stamp));
  return <section className={styles.page}><AdminNav />
    <h1 className={styles.title}>{t('conversion.title')}</h1>
    <p className={styles.muted}>{t('conversion.intro')}</p>
    <details className={styles.notice}><summary>{t('conversion.recovery_summary')}</summary><p>{t('conversion.limits')}</p><p>{t('conversion.recovery')}</p></details>
    {(!store || !runner) ? <p role="status">{t('common.loading')}</p> : (!supported || !access.conversion) && <p role="status" className={styles.notice}>{t('conversion.unavailable')}</p>}
    {error && <p role="alert" className={styles.error}>{t('conversion.error')}</p>}
    {busy && !activeBatch && <p role="status">{t('common.loading')}</p>}
    {sourceId && <section className={styles.panel}>
      <h2>{source.data?.album?.title || source.data?.tracks[0]?.title || t('conversion.source')}</h2>
      <p className={styles.muted}>{t('conversion.existing_help')}</p>
      {source.isError && <p role="alert">{t('common.error')}</p>}
      {source.isPending && access.conversion && online && <p role="status">{t('common.loading')}</p>}
      {source.data && <><p>{t('conversion.count', { count: source.data.tracks.length })}</p>
        {source.data.tracks.length === 0 && <p role="status">{sharedText('catalog.album.no_tracks')}</p>}
        <button className={`${styles.button} ${styles.primary}`} disabled={busy || Boolean(activeBatch) || !supported || !access.conversion || !source.data.tracks.length} onClick={() => void work(async () => {
          await conversionStore.createExisting(access.viewerId, source.data!); setParams({});
        })}>{t('conversion.capture')}</button>
        <details className={styles.details}><summary>{t('conversion.count', { count: source.data.tracks.length })}</summary><ul className={styles.files}>{source.data.tracks.map(track => <li key={track.id}>{track.title || track.originalFileName || t('common.untitled')}</li>)}</ul></details></>}
    </section>}
    <form className={styles.panel} onSubmit={event => { event.preventDefault(); if (!supported || !access.conversion) return; void work(async () => {
      await conversionStore.createLocal(access.viewerId, files, rootLabel.trim()); setFiles([]);
    }); }}>
      <h2>{t('conversion.select')}</h2>
      <div className={styles.actions}><button className={styles.button} type="button" disabled={busy || Boolean(activeBatch) || !supported || !access.conversion} onClick={() => picker.current?.click()}>{t('conversion.select')}</button>
        <button className={styles.button} type="button" disabled={busy || Boolean(activeBatch) || !supported || !access.conversion} onClick={() => folder.current?.click()}>{t('conversion.folder')}</button></div>
      <input hidden type="file" ref={picker} multiple accept=".flac,.wav,audio/flac,audio/wav,audio/x-wav" onChange={event => { choose(event.target.files); event.target.value = ''; }} />
      <input hidden type="file" ref={folder} multiple onChange={event => { choose(event.target.files, true); event.target.value = ''; }} />
      {invalid && <p role="alert">{t('conversion.invalid')}</p>}
      {files.length > 0 && <><label className={styles.field}>{t('conversion.root')}<input className={styles.input} required disabled={busy || Boolean(activeBatch)} maxLength={200} value={rootLabel} onChange={event => setRootLabel(event.target.value)} /></label>
        <p className={styles.meta}>{t('conversion.root_help')}</p>
        <button className={`${styles.button} ${styles.primary}`} type="submit" disabled={busy || Boolean(activeBatch) || !supported || !rootLabel.trim() || !access.conversion}>{t('conversion.capture')}</button>
        <details className={styles.details}><summary>{t('conversion.count', { count: files.length })}</summary><ul className={styles.files}>{files.map(file => <li key={file.webkitRelativePath || file.name}>{file.webkitRelativePath || file.name}</li>)}</ul></details></>}
    </form>
    <h2>{t('conversion.device')}</h2>
    {batches.length === 0 && <p className={styles.notice}>{t('conversion.empty')}</p>}
    <ul className={styles.cards}>{batches.map(batch => {
      const ready = batch.tasks.filter(task => task.result && !task.cacheRemoved && ['complete', 'needsAttention', 'uploading', 'uploaded'].includes(task.status));
      const eligible = batch.tasks.filter(task => task.intent || access.conversion && ready.includes(task));
      const canRun = batch.tasks.some(task => !task.cacheRemoved && (!task.result || task.error === 'conversion_cache_missing' || task.error === 'conversion_output_invalid'));
      return <li className={styles.card} key={batch.id}><h3>{batch.rootLabel}</h3><p className={styles.meta}>{t('conversion.count', { count: batch.tasks.length })}</p>
        <div className={styles.actions}><button className={`${styles.button} ${canRun ? styles.primary : ''}`} disabled={busy || Boolean(activeBatch) || !access.conversion || !canRun} onClick={() => void work(async () => {
          setActiveBatch(batch.id); try { await conversionRunner.run(batch.id, adminWorkspace.capture(), setProgress); } finally { setActiveBatch(null); }
        })}>{t('conversion.run')}</button>
          {activeBatch === batch.id && <button className={styles.button} onClick={() => conversionRunner.stop()}>{t('conversion.pause')}</button>}
          {batch.kind === 'existing' && <button className={`${styles.button} ${styles.primary}`} disabled={busy || !eligible.length || !online} onClick={() => {
            const ids = eligible.map(task => task.id); setConfirm({ batch: structuredClone(batch), ids, stamp: uploadStamp(batch, ids) });
          }}>{t('conversion.upload')}</button>}
          {batch.kind === 'local' && !batch.importIntent?.projectId && <button className={`${styles.button} ${styles.primary}`} disabled={busy || ready.length !== batch.tasks.length || !online || !access.imports} onClick={() => void work(async () => {
            const bridge = await import('./conversionImportBridge'); const id = await bridge.createConversionImport(batch, adminWorkspace.capture()); navigate(`/admin/imports/${id}`);
          })}>{t('conversion.import')}</button>}
          {batch.importIntent?.projectId && <><Link className={styles.link} to={`/admin/imports/${batch.importIntent.projectId}`}>{t('conversion.open_import')}</Link>
            <button className={styles.button} disabled={busy || !online} onClick={() => void work(async () => {
              const bridge = await import('./conversionImportBridge'); return bridge.cleanConversionImport(batch, adminWorkspace.capture());
            })}>{t('conversion.check')}</button></>}
        </div>
        {batch.kind === 'local' && <p className={styles.meta}>{t('conversion.import_help')}</p>}
        {progress && batch.tasks.length > 8 && batch.tasks.some(task => task.id === progress.taskId) && <p role="status">{batch.tasks.find(task => task.id === progress.taskId)?.title} · {t(`conversion.stage_${progress.stage}`)} · {Math.round(progress.progress * 100)}%</p>}
        <details open={batch.tasks.length <= 8}><summary>{t('conversion.count', { count: batch.tasks.length })}</summary><ul className={styles.files}>{batch.tasks.map(task => <li className={styles.panel} key={task.id}>
          <strong className={styles.filename}>{task.title || task.filename}</strong>
          <p role="status">{t(`conversion.status_${progress?.taskId === task.id ? 'encoding' : task.status}`)}</p>
          {progress?.taskId === task.id && <><p>{t(`conversion.stage_${progress.stage}`)}</p><progress aria-label={t(`conversion.stage_${progress.stage}`)} max={1} value={progress.progress} /></>}
          {task.result && <p className={styles.meta}>MP3 · 320 kbps · {task.result.sampleRate / 1000} kHz · {t(task.result.channels === 1 ? 'conversion.mono' : 'conversion.stereo')} · {(task.result.outputBytes / 1024 ** 2).toFixed(1)} MiB</p>}
          {task.source.complete && <p className={styles.meta}>{t('conversion.retained')}</p>}
          {task.cacheRemoved && <p>{t('conversion.removed')}</p>}
          {task.receipt?.cleanupPending && <p role="status">{t('conversion.cleanup_pending')}</p>}
          {task.error && <p role="alert" className={styles.error}>{t(`conversion.${errorKey(task.error)}`)}</p>}
          {task.result && !task.cacheRemoved && <button className={styles.button} disabled={busy} onClick={() => void work(() => download(task))}>{t('conversion.download')}</button>}
          {task.source.kind === 'remote' && task.source.complete && <button className={styles.button} disabled={busy} onClick={() => void work(() => downloadSource(task))}>{t('conversion.download_source')}</button>}
          {task.intent && !task.receipt?.ready && <button className={styles.button} disabled={busy || !online} onClick={() => void work(() => conversionRunner.cancel(task, adminWorkspace.capture()))}>{t('conversion.cancel_upload')}</button>}
        </li>)}</ul></details>
      </li>;
    })}</ul>
    {confirm && <ModalDialog title={t('conversion.upload')} description={t('conversion.upload_confirm')} initialFocusRef={dialogFocus} onClose={() => setConfirm(null)}
      headerContent={<div className={styles.target}><strong>{confirm.batch.rootLabel}</strong><p>{t('conversion.count', { count: confirm.ids.length })}</p></div>}>
      <ul className={styles.files}>{confirm.batch.tasks.filter(task => confirm.ids.includes(task.id)).map(task => <li key={task.id}>{task.title} · {task.filename} · 320 kbps</li>)}</ul>
      {stale && <p role="alert">{t('common.conflict')}</p>}
      <div className={styles.dialogActions}><button className={styles.button} onClick={() => setConfirm(null)}>{t('common.cancel')}</button>
        <button className={`${styles.button} ${styles.primary}`} disabled={busy || stale || !online} onClick={() => {
          const frozen = confirm; setConfirm(null); void work(async () => {
            setActiveBatch(frozen.batch.id); try { await conversionRunner.upload(frozen.batch.id, adminWorkspace.capture(), frozen.ids, frozen.batch.tasks.filter(task => frozen.ids.includes(task.id))); } finally { setActiveBatch(null); }
          });
        }}>{t('conversion.upload_submit')}</button></div>
    </ModalDialog>}
  </section>;
}
export const AdminConversionsPage = () => <AdminGate><Conversions /></AdminGate>;
