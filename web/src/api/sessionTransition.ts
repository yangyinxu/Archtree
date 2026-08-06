import { advanceAccountEpoch } from './accountEpoch';

export type BrowserSessionTransitionKind =
  | 'login'
  | 'refresh'
  | 'logout'
  | 'logout-all'
  | 'account-delete';
export type BrowserSessionTransitionCapability = 'web-locks-v1' | undefined;

interface BrowserSessionTransitionOptions<Output> {
  kind: BrowserSessionTransitionKind;
  changesIdentity?: boolean;
  /** Restores the only safe terminal state if a storage lease is lost mid-response. */
  onConflict?: (result: Output | undefined) => Promise<void>;
}

interface BrowserLockManager {
  request<Output>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<Output>
  ): Promise<Output>;
}

interface StoredLease {
  owner: string;
  expiresAt: number;
}

const transitionLockName = 'finitude:browser-session-transition';
const transitionLeaseKey = `${transitionLockName}:lease`;
const leaseDurationMs = 2_000;
const leaseRenewalMs = 500;
const leaseSettleMs = 30;
const leaseAcquireTimeoutMs = 10_000;
let localTail: Promise<unknown> = Promise.resolve();

export class BrowserSessionTransitionUnavailableError extends Error {
  constructor() {
    super('This browser cannot safely coordinate account changes across tabs.');
    this.name = 'BrowserSessionTransitionUnavailableError';
  }
}

export class BrowserSessionTransitionConflictError extends Error {
  constructor() {
    super('Another tab changed the browser session during this account action.');
    this.name = 'BrowserSessionTransitionConflictError';
  }
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, milliseconds);
});

const availableStorage = () => {
  try {
    const storage = window.localStorage;
    storage.getItem(transitionLeaseKey);
    return storage;
  } catch {
    return null;
  }
};

const readLease = (storage: Storage): StoredLease | null => {
  try {
    const serialized = storage.getItem(transitionLeaseKey);
    if (!serialized || serialized.length > 500) return null;
    const candidate = JSON.parse(serialized) as Partial<StoredLease>;
    if (typeof candidate.owner !== 'string'
      || !candidate.owner
      || candidate.owner.length > 200
      || !Number.isFinite(candidate.expiresAt)) return null;
    return { owner: candidate.owner, expiresAt: Number(candidate.expiresAt) };
  } catch {
    return null;
  }
};

const writeLease = (storage: Storage, lease: StoredLease) => {
  storage.setItem(transitionLeaseKey, JSON.stringify(lease));
};

const acquireStorageLease = async (storage: Storage) => {
  const owner = crypto.randomUUID();
  const deadline = Date.now() + leaseAcquireTimeoutMs;
  while (Date.now() < deadline) {
    const current = readLease(storage);
    if (!current || current.expiresAt <= Date.now()) {
      try {
        writeLease(storage, { owner, expiresAt: Date.now() + leaseDurationMs });
        // A settle window makes simultaneous empty-lock contenders observe the
        // final shared writer before either is allowed to change cookies.
        await delay(leaseSettleMs);
        if (readLease(storage)?.owner === owner) return owner;
      } catch {
        throw new BrowserSessionTransitionUnavailableError();
      }
    }
    await delay(leaseSettleMs);
  }
  throw new BrowserSessionTransitionConflictError();
};

const releaseStorageLease = (storage: Storage, owner: string) => {
  try {
    if (readLease(storage)?.owner === owner) storage.removeItem(transitionLeaseKey);
  } catch {
    // Expiry still bounds an abandoned lease if storage becomes unavailable.
  }
};

const recoverAfterConflict = async <Output>(
  storage: Storage,
  onConflict: BrowserSessionTransitionOptions<Output>['onConflict'],
  result: Output | undefined
) => {
  if (!onConflict) return;
  let recoveryOwner: string | undefined;
  try {
    recoveryOwner = await acquireStorageLease(storage);
    await onConflict(result);
  } catch {
    // A caller must not receive or publish the stale transition result even if
    // the best-effort signed-out recovery cannot reach the server.
  } finally {
    if (recoveryOwner) releaseStorageLease(storage, recoveryOwner);
  }
};

const runWithStorageLease = async <Output>(
  storage: Storage,
  options: BrowserSessionTransitionOptions<Output>,
  operation: () => Promise<Output>
) => {
  const owner = await acquireStorageLease(storage);
  let lost = false;
  const renewal = window.setInterval(() => {
    try {
      if (readLease(storage)?.owner !== owner) {
        lost = true;
        return;
      }
      writeLease(storage, { owner, expiresAt: Date.now() + leaseDurationMs });
      if (readLease(storage)?.owner !== owner) lost = true;
    } catch {
      lost = true;
    }
  }, leaseRenewalMs);

  let result: Output | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  } finally {
    window.clearInterval(renewal);
    if (readLease(storage)?.owner !== owner) lost = true;
    releaseStorageLease(storage, owner);
  }

  if (lost) {
    await recoverAfterConflict(storage, options.onConflict, result);
    throw new BrowserSessionTransitionConflictError();
  }
  if (operationError) throw operationError;
  return result as Output;
};

const runShared = async <Output>(
  options: BrowserSessionTransitionOptions<Output>,
  operation: (capability: BrowserSessionTransitionCapability) => Promise<Output>
) => {
  const locks = (navigator as Navigator & { locks?: BrowserLockManager }).locks;
  if (locks) {
    return locks.request(
      transitionLockName,
      { mode: 'exclusive' },
      () => operation('web-locks-v1')
    );
  }

  // A storage lease coordinates cleanup, but only Web Locks is accepted as the
  // capability for an endpoint that can install or rotate credentials.
  if (options.kind === 'login' || options.kind === 'refresh') {
    throw new BrowserSessionTransitionUnavailableError();
  }

  const storage = availableStorage();
  if (storage) {
    try {
      return await runWithStorageLease(storage, options, () => operation(undefined));
    } catch (error) {
      if (!(error instanceof BrowserSessionTransitionUnavailableError)) throw error;
    }
  }
  // A cookie-clearing request remains a fail-closed fallback when shared
  // storage itself is unavailable.
  return operation(undefined);
};

/** Serializes one complete cookie-changing operation without nested lock acquisition. */
export const runBrowserSessionTransition = <Output>(
  options: BrowserSessionTransitionOptions<Output>,
  operation: (
    capability: BrowserSessionTransitionCapability,
    generation: number | undefined
  ) => Promise<Output>
) => {
  const generation = options.changesIdentity ? advanceAccountEpoch() : undefined;
  const result = localTail.then(() => runShared(
    options,
    (capability) => operation(capability, generation)
  ));
  localTail = result.then(() => undefined, () => undefined);
  return result;
};
