export type AccountSessionChangeReason =
  | 'login'
  | 'logout'
  | 'logout-all'
  | 'account-deleted'
  | 'viewer-mismatch';

export interface AccountSessionChangeEvent {
  id: string;
  reason: AccountSessionChangeReason;
}

type AccountSessionChangeListener = (event: AccountSessionChangeEvent) => void;

export const accountSessionChangeStorageKey = 'finitude:browser-session-change';
const listeners = new Set<AccountSessionChangeListener>();
const observedIds = new Set<string>();
let broadcastChannel: BroadcastChannel | undefined;

const parseEvent = (value: unknown): AccountSessionChangeEvent | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AccountSessionChangeEvent>;
  if (typeof candidate.id !== 'string' || !candidate.id || candidate.id.length > 200) {
    return null;
  }
  if (!/^(login|logout(-all)?|account-deleted|viewer-mismatch)$/
    .test(candidate.reason as string)) return null;
  return candidate as AccountSessionChangeEvent;
};

const dispatch = (event: AccountSessionChangeEvent) => {
  if (observedIds.has(event.id)) return;
  if (observedIds.size >= 100) observedIds.clear();
  observedIds.add(event.id);
  for (const listener of listeners) listener(event);
};

const receive = (value: unknown) => {
  const event = parseEvent(value);
  if (event) dispatch(event);
};

window.addEventListener('storage', (event) => {
  if (event.key !== accountSessionChangeStorageKey
    || !event.newValue
    || event.newValue.length > 2_000) return;
  try {
    receive(JSON.parse(event.newValue));
  } catch {
    // Ignore malformed storage events from unrelated or older clients.
  }
});
try {
  broadcastChannel = new BroadcastChannel(accountSessionChangeStorageKey);
  broadcastChannel.onmessage = (message: MessageEvent<unknown>) => receive(message.data);
} catch {
  // The storage fallback still synchronizes supported tabs.
}

interface PublishAccountSessionChangeOptions {
  /** Reconciles this document as well as notifying every other same-origin tab. */
  includeCurrentTab?: boolean;
}

/** Publishes a credential transition without persisting account identity or credentials. */
export const publishAccountSessionChange = (
  reason: AccountSessionChangeReason,
  options: PublishAccountSessionChangeOptions = {}
) => {
  const event: AccountSessionChangeEvent = {
    id: crypto.randomUUID(),
    reason
  };
  if (reason === 'viewer-mismatch' || options.includeCurrentTab) dispatch(event);
  try {
    broadcastChannel?.postMessage(event);
  } catch {
    // The local dispatch and storage fallback still reconcile this tab.
  }
  try {
    window.localStorage.setItem(accountSessionChangeStorageKey, JSON.stringify(event));
  } catch {
    // Private browsing or a full quota may make localStorage unavailable.
  }
};

/** Receives local, BroadcastChannel, and storage-fallback session transitions once. */
export const subscribeToAccountSessionChanges = (listener: AccountSessionChangeListener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
