interface ProbeOptions {
  deadlineMs?: number;
  cacheMs?: number;
  now?: () => number;
}

/**
 * One underlying operation owns the slot until it settles, even after its shared
 * response deadline. Repeated callers cannot enqueue work or retain extra waiters
 * on a hung driver operation. Identity changes never reuse an old ready result.
 */
export const createReadinessProbe = <Key>(
  operation: (key: Key, signal: AbortSignal) => Promise<boolean>,
  { deadlineMs = 1_000, cacheMs = 1_000, now = Date.now }: ProbeOptions = {}
) => {
  let pending: { key: Key; response: Promise<boolean> } | undefined;
  let cached: { key: Key; ready: boolean; expiresAt: number } | undefined;

  return (key: Key): Promise<boolean> => {
    if (pending) return pending.key === key ? pending.response : Promise.resolve(false);
    if (cached?.key === key && now() < cached.expiresAt) return Promise.resolve(cached.ready);

    const abort = new AbortController();
    let responded = false;
    let respond!: (ready: boolean) => void;
    const response = new Promise<boolean>(resolve => { respond = resolve; });
    const slot = { key, response };
    pending = slot;
    const publish = (ready: boolean) => {
      if (responded) return;
      responded = true;
      cached = { key, ready, expiresAt: now() + cacheMs };
      respond(ready);
    };
    const timer = setTimeout(() => {
      // This stops later probe stages; it does not pretend to cancel a Mongo command.
      abort.abort();
      publish(false);
    }, deadlineMs);
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      publish(ready);
      if (pending === slot) pending = undefined;
    };
    void Promise.resolve().then(() => operation(key, abort.signal)).then(finish, () => finish(false));
    return response;
  };
};
