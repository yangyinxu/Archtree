import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AdminGate, useAdminAccess, useAdminText } from './AdminAccess';
import { adminWorkspace } from './adminWorkspace';
import { namingManifest, type NamingManifest } from './manifest';
import { useAdminMutation } from './useAdminMutation';
import { MutationStatus, useOnline } from './AdminShared';
import { AdminNav } from './AdminNav';
import styles from './adminStyles';

function CreateImport() {
  const t = useAdminText();
  const access = useAdminAccess();
  const navigate = useNavigate();
  const online = useOnline();
  const folder = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const [manifest, setManifest] = useState<NamingManifest | null>(() => adminWorkspace.buffer('create-manifest') ?? null);
  const [invalid, setInvalid] = useState(false);
  const mutation = useAdminMutation('create');
  const locked = mutation.running || Boolean(mutation.intent);
  useEffect(() => { folder.current?.setAttribute('webkitdirectory', ''); }, []);
  useEffect(() => { if (manifest) adminWorkspace.retain('create-manifest', manifest, access); }, [manifest]);
  useEffect(() => { if (mutation.result) {
    const sources = adminWorkspace.buffer<Record<string, File>>('create-files');
    if (sources) adminWorkspace.retain(`files:${mutation.result.item.id}`, sources, access);
    adminWorkspace.forget('create-files');
    adminWorkspace.forget('create-manifest'); adminWorkspace.forget('mutation:create'); navigate(`/admin/imports/${mutation.result.item.id}`, { replace: true });
  } }, [mutation.result, navigate]);
  const select = (list: FileList | null) => {
    if (!list || locked) return;
    try { const files = Array.from(list), next = namingManifest(files);
      adminWorkspace.retain('create-files', Object.fromEntries(next.files.map(entry => [entry.slotId, files.find(file => (file.webkitRelativePath || file.name) === entry.relativePath)!])), access);
      setManifest(next); setInvalid(false);
    } catch { setInvalid(true); }
  };
  return <section className={styles.page}><AdminNav />
    <Link className={styles.back} to="/admin/imports">{t('common.back')}</Link>
    <h1 className={styles.title}>{t('workbench.new')}</h1><p className={styles.muted}>{t('import.intro')}</p>
    <p className={styles.panel}>{t('import.manifest_only')}</p>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); if (manifest && access.imports) mutation.operation.run('', 'POST', { manifest }); }}>
      <div className={styles.actions}>
        <button className={styles.button} type="button" disabled={locked || !access.imports} onClick={() => folder.current?.click()}>{t('import.folder')}</button>
        <button className={styles.button} type="button" disabled={locked || !access.imports} onClick={() => files.current?.click()}>{t('import.files')}</button>
        <input hidden ref={folder} type="file" multiple onChange={event => { select(event.target.files); event.target.value = ''; }} />
        <input hidden ref={files} type="file" multiple accept=".mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.aif,.aiff" onChange={event => { select(event.target.files); event.target.value = ''; }} />
      </div>
      {invalid && <p role="alert">{t('import.invalid_files')}</p>}
      {manifest && <>
        <label className={styles.field}>{t('import.root')}<input className={styles.input} required maxLength={200} pattern="[^/\\\\]+" value={manifest.rootLabel} disabled={locked} onChange={event => setManifest({ ...manifest, rootLabel: event.target.value })} /></label>
        <p className={styles.muted}>{t('import.root_help')}</p>
        <p>{t('import.file_count', { count: manifest.files.length })}</p>
        <ul className={styles.files}>{manifest.files.map(file => <li key={file.slotId}>{file.relativePath}</li>)}</ul>
      </>}
      {!online && <p role="status">{t('common.offline')}</p>}
      <MutationStatus mutation={mutation} />
      <div><button className={`${styles.button} ${styles.primary}`} type="submit" disabled={!manifest?.rootLabel.trim() || locked || !online || !access.imports}>{t('import.create')}</button></div>
    </form>
  </section>;
}
export const AdminCreateImportPage = () => <AdminGate><CreateImport /></AdminGate>;
