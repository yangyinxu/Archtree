import { useEffect, useRef, useState } from 'react';
import type { ImportDetail } from './adminApi';
import { useAdminAccess, useAdminText } from './AdminAccess';
import { adminWorkspace } from './adminWorkspace';
import { useOnline } from './useAdminOnline';
import { matchReselection, uploadPublicationLocked, type useImportUploadQueue } from './importUploadQueue';
import styles from './adminStyles';

/** Progress, reselection and Resume for incomplete files; Resume is the only control that sends file bytes. */
export function ImportUploads({ item, uploads, onReselect }: { item: ImportDetail; uploads: ReturnType<typeof useImportUploadQueue>; onReselect: () => void }) {
  const t = useAdminText(), access = useAdminAccess(), online = useOnline();
  const folder = useRef<HTMLInputElement>(null), files = useRef<HTMLInputElement>(null);
  const [mismatched, setMismatched] = useState<string[] | null>(null);
  useEffect(() => { folder.current?.setAttribute('webkitdirectory', ''); }, []);
  const bufferKey = `files:${item.id}`, local = adminWorkspace.buffer<Record<string, File>>(bufferKey) ?? {};
  const incomplete = item.manifest.files.filter(file => !item.assets.some(asset => asset.slotId === file.slotId && asset.state === 'ready'));
  const locked = uploadPublicationLocked(item) || !item.capabilities.upload || !online || !access.imports;
  const current = uploads.current === 'cover' ? t('media.manual_cover') : item.manifest.files.find(file => file.slotId === uploads.current)?.relativePath;
  const reselect = (list: FileList | null) => {
    if (!list?.length) return;
    const result = matchReselection(item, Array.from(list));
    adminWorkspace.retain(bufferKey, { ...adminWorkspace.buffer<Record<string, File>>(bufferKey), ...result.matched }, access);
    setMismatched(result.mismatched.length || !Object.keys(result.matched).length ? result.mismatched : null); onReselect();
  };
  return <section className={styles.editor} aria-labelledby={`uploads-${item.id}`}>
    <h3 id={`uploads-${item.id}`}>{t('upload.title')}</h3>
    <p>{t('upload.progress', { completed: item.manifest.files.length - incomplete.length, total: item.manifest.files.length })}</p>
    <p role="status">{uploads.running && current ? t('upload.current', { name: current }) : ''}</p>
    {uploads.stopped && <p role="alert">{t(uploads.stopped === 'reload' ? 'common.reload' : `upload.stopped_${uploads.stopped}`)}</p>}
    {incomplete.length > 0 && <>
      <div className={styles.actions}>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={uploads.running || locked || !incomplete.some(file => local[file.slotId])}
          onClick={() => uploads.queue.start(item, adminWorkspace.buffer<Record<string, File>>(bufferKey) ?? {}, adminWorkspace.capture())}>{t('upload.resume')}</button>
        <button type="button" className={styles.button} disabled={uploads.running || locked} onClick={() => folder.current?.click()}>{t('upload.reselect_folder')}</button>
        <button type="button" className={styles.button} disabled={uploads.running || locked} onClick={() => files.current?.click()}>{t('upload.reselect_files')}</button>
        <input hidden ref={folder} type="file" multiple disabled={uploads.running || locked} onChange={event => { reselect(event.target.files); event.target.value = ''; }} />
        <input hidden ref={files} type="file" multiple disabled={uploads.running || locked} accept=".mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.aif,.aiff" onChange={event => { reselect(event.target.files); event.target.value = ''; }} />
      </div>
      <p className={styles.muted}>{t('upload.reselect_help')}</p>
    </>}
    {mismatched && <div role="alert"><p>{t('upload.refused_mismatch')}</p>{mismatched.length > 0 && <ul className={styles.files}>{mismatched.map(path => <li key={path}>{path}</li>)}</ul>}</div>}
  </section>;
}
