export interface NamingFile { slotId: string; filename: string; relativePath: string; byteLength: number | null }
export interface NamingManifest { rootLabel: string; files: NamingFile[] }
const audioExtension = /\.(mp3|m4a|aac|wav|flac|ogg|opus|aif|aiff)$/iu;
const validSegment = (value: string) => Boolean(value && value !== '.' && value !== '..' && value.trim() === value
  && !/[\u0000-\u001f\u007f-\u009f/:\\]/u.test(value));

/** Retains only the user's selected hierarchy, never File handles or absolute device paths. */
export const namingManifest = (
  files: readonly Pick<File, 'name' | 'size' | 'webkitRelativePath'>[],
  uuid: () => string = () => crypto.randomUUID()
): NamingManifest => {
  const audio = files.filter(file => audioExtension.test(file.name));
  if (!audio.length || audio.length > 100) throw new Error('Invalid audio selection');
  const entries = audio.map(file => {
    const path = file.webkitRelativePath || file.name;
    const segments = path.split('/');
    if (!validSegment(file.name) || segments.some(segment => !validSegment(segment))
      || segments.at(-1) !== file.name || path.length > 1_024 || segments.length > 16 || file.name.length > 255
      || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 8 * 1024 ** 3) throw new Error('Invalid audio selection');
    return { slotId: uuid(), filename: file.name, relativePath: path, byteLength: file.size };
  });
  if (new Set(entries.map(entry => entry.relativePath)).size !== entries.length) throw new Error('Ambiguous filenames; select their containing folders');
  const roots = new Set(entries.filter(entry => entry.relativePath.includes('/')).map(entry => entry.relativePath.split('/')[0]));
  const manifest = { rootLabel: roots.size === 1 ? [...roots][0] : '', files: entries };
  if (new TextEncoder().encode(JSON.stringify(manifest)).length > 24_000) throw new Error('Selection naming context is too large');
  return manifest;
};
