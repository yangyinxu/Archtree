import type { ServerResponse } from 'node:http';

interface ResponseCompletion {
  completed: boolean;
  callbacks: Set<() => void>;
}

const completions = new WeakMap<ServerResponse, ResponseCompletion>();

/** Shares transport completion hooks while keeping pending business work independent. */
export const onResponseComplete = (res: ServerResponse, callback: () => void) => {
  let state = completions.get(res);
  if (!state) {
    state = { completed: false, callbacks: new Set() };
    completions.set(res, state);
    const current = state;
    const complete = () => {
      current.completed = true;
      res.off('finish', complete);
      res.off('close', complete);
      const callbacks = [...current.callbacks];
      current.callbacks.clear();
      for (const notify of callbacks) notify();
    };
    if (res.writableFinished || res.destroyed) complete();
    else {
      res.once('finish', complete);
      res.once('close', complete);
    }
  }
  if (state.completed) callback();
  else state.callbacks.add(callback);
};
