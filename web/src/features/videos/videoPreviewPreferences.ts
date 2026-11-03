const storageKey = 'finitude:video-preview-muted';
const listeners = new Set<() => void>();
let unavailableChoice: boolean | undefined;
let lastChoice = false;

/** A device-only default: missing or malformed storage means previews request sound. */
export const readVideoPreviewMuted = (): boolean => {
  if (unavailableChoice !== undefined) return unavailableChoice;
  try {
    if (typeof window === 'undefined') return false;
    lastChoice = window.localStorage.getItem(storageKey) === 'true';
    return lastChoice;
  } catch {
    return lastChoice;
  }
};

const notify = () => listeners.forEach(listener => listener());
const storageChanged = (event: StorageEvent) => {
  if (event.key !== storageKey && event.key !== null) return;
  unavailableChoice = undefined;
  notify();
};

/** Storage denial still permits a working setting for the current document. */
export const setVideoPreviewMuted = (muted: boolean) => {
  lastChoice = muted;
  try {
    window.localStorage.setItem(storageKey, String(muted));
    unavailableChoice = undefined;
  } catch {
    unavailableChoice = muted;
  }
  notify();
};

/** Same-tab subscribers update immediately; other tabs follow the browser's storage event. */
export const subscribeVideoPreviewPreferences = (listener: () => void) => {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', storageChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', storageChanged);
  };
};
