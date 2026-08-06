const importTransition = async () => {
  vi.resetModules();
  return import('./sessionTransition');
};

test('reserves a distinct generation when each same-tab identity transition starts', async () => {
  let lockTail: Promise<unknown> = Promise.resolve();
  const lockRequest = vi.fn((
    _name: string,
    _options: { mode: 'exclusive' },
    callback: () => Promise<unknown>
  ) => {
    const result = lockTail.then(callback);
    lockTail = result.then(() => undefined, () => undefined);
    return result;
  });
  vi.stubGlobal('navigator', { locks: { request: lockRequest } });
  const { runBrowserSessionTransition } = await importTransition();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const started: number[] = [];
  const first = runBrowserSessionTransition(
    { kind: 'login', changesIdentity: true },
    async (capability, generation) => {
      expect(capability).toBe('web-locks-v1');
      started.push(generation!);
      await firstGate;
      return generation!;
    }
  );
  const second = runBrowserSessionTransition(
    { kind: 'logout', changesIdentity: true },
    async (_capability, generation) => {
      started.push(generation!);
      return generation!;
    }
  );

  await vi.waitFor(() => expect(started).toHaveLength(1));
  releaseFirst();
  const [firstGeneration, secondGeneration] = await Promise.all([first, second]);
  expect(secondGeneration).toBe(firstGeneration + 1);
  expect(started).toEqual([firstGeneration, secondGeneration]);
});

test('refuses credential-setting operations when Web Locks are unavailable', async () => {
  vi.stubGlobal('navigator', {});
  const transition = await importTransition();
  const operation = vi.fn(async () => undefined);
  await expect(transition.runBrowserSessionTransition(
    { kind: 'login', changesIdentity: true },
    operation
  )).rejects.toBeInstanceOf(transition.BrowserSessionTransitionUnavailableError);
  expect(operation).not.toHaveBeenCalled();
});

test('storage fallback cleanup never receives the credential-setting capability', async () => {
  vi.stubGlobal('navigator', {});
  const { runBrowserSessionTransition } = await importTransition();
  await expect(runBrowserSessionTransition(
    { kind: 'logout', changesIdentity: true },
    async (capability) => capability
  )).resolves.toBeUndefined();
});
