import type { Request, RequestHandler } from 'express';
import type { Server, ServerResponse } from 'node:http';
import { onResponseComplete } from '../infrastructure/responseCompletion';

const requestLifecycles = new WeakMap<Request, ServerLifecycle>();

interface RequestWorkState {
  pending: number;
  responseFinished: boolean;
  responseObserved: boolean;
  completionListeners: Set<() => void>;
}

const requestWork = new WeakMap<Request, RequestWorkState>();

/** Keeps request work observable even in isolated Routers without an application lifecycle. */
const workState = (req: Request) => {
  let state = requestWork.get(req);
  if (!state) {
    state = { pending: 0, responseFinished: false, responseObserved: false, completionListeners: new Set() };
    requestWork.set(req, state);
  }
  return state;
};

/** Releases resources only when neither transport nor an admitted operation can still use them. */
const notifyRequestCompletion = (state: RequestWorkState) => {
  if (!state.responseFinished || state.pending) return;
  const listeners = [...state.completionListeners];
  state.completionListeners.clear();
  for (const complete of listeners) complete();
};

const observeResponse = (req: Request, res: ServerResponse) => {
  const state = workState(req);
  if (!state.responseObserved) {
    state.responseObserved = true;
    onResponseComplete(res, () => {
      state.responseFinished = true;
      notifyRequestCompletion(state);
    });
  }
  return state;
};

/** Registers a synchronous resource release after response close AND all tracked work settles. */
export const onRequestWorkComplete = (req: Request, res: ServerResponse, complete: () => void) => {
  const state = observeResponse(req, res);
  state.completionListeners.add(complete);
  notifyRequestCompletion(state);
};

/** A response closing does not mean its transaction or upload promise has completed. */
export const runRequestWork = <T>(req: Request, operation: () => T | Promise<T>): Promise<T> => {
  const state = workState(req);
  if (state.responseFinished) {
    return Promise.reject(Object.assign(new Error('The request has already ended.'), { statusCode: 503 }));
  }
  state.pending += 1;
  const execute = () => {
    // A callback parser can finish after disconnect, even before this microtask begins.
    if (state.responseFinished) {
      throw Object.assign(new Error('The request has already ended.'), { statusCode: 503 });
    }
    return operation();
  };
  const work = requestLifecycles.get(req)?.track(execute) ?? Promise.resolve().then(execute);
  return work.finally(() => {
    state.pending -= 1;
    notifyRequestCompletion(state);
  });
};

/** Owns admission and bounded shutdown for one application instance. */
export class ServerLifecycle {
  draining = false;
  private shutdown?: Promise<'graceful' | 'forced'>;
  private responses = new Set<ServerResponse>();
  private work = new Set<Promise<unknown>>();
  private idleWaiters = new Set<() => void>();
  private workAdmissionClosed = false;

  /** Tracks business completion independently of HTTP connection lifetime. */
  track<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.workAdmissionClosed) {
      return Promise.reject(Object.assign(new Error('The service is restarting. Please retry.'), {
        statusCode: 503
      }));
    }
    const work = Promise.resolve().then(operation);
    this.work.add(work);
    return work.finally(() => {
      this.work.delete(work);
      if (this.work.size === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    });
  }

  private whenIdle() {
    if (!this.work.size) return Promise.resolve();
    return new Promise<void>(resolve => this.idleWaiters.add(resolve));
  }

  readonly admit: RequestHandler = (_req, res, next) => {
    if (!this.draining) {
      requestLifecycles.set(_req, this);
      observeResponse(_req, res);
      this.responses.add(res);
      onResponseComplete(res, () => {
        this.responses.delete(res);
      });
      return next();
    }
    res.setHeader('Connection', 'close');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ message: 'The service is restarting. Please retry.' });
  };

  /** Stops admission before closing sockets; database teardown happens after the drain. */
  stop(server: Server, closeDatabase: () => Promise<void>, graceMs: number, cleanupMs: number) {
    if (this.shutdown) return this.shutdown;
    this.draining = true;
    for (const response of this.responses) {
      response.shouldKeepAlive = false;
      if (!response.headersSent) response.setHeader('Connection', 'close');
    }
    this.shutdown = this.finishStop(server, closeDatabase, graceMs, cleanupMs);
    return this.shutdown;
  }

  private async finishStop(
    server: Server, closeDatabase: () => Promise<void>, graceMs: number, cleanupMs: number
  ): Promise<'graceful' | 'forced'> {
    let forced = false;
    await new Promise<void>(resolve => {
      let timer: NodeJS.Timeout | undefined;
      const complete = () => {
        // A callback parser may have dispatched new work since the previous idle snapshot.
        if (!forced && this.work.size > 0) {
          void this.whenIdle().then(complete);
          return;
        }
        this.workAdmissionClosed = true;
        clearTimeout(timer);
        resolve();
      };
      // close() stops new connections and closes idle keep-alive connections on Node 24.
      const socketsClosed = new Promise<void>(closed => server.close(() => closed()));
      void Promise.all([socketsClosed, this.whenIdle()]).then(complete);
      timer = setTimeout(() => {
        forced = true;
        server.closeAllConnections();
        // Allow socket-close hooks to abort media sources before tearing down storage.
        timer = setTimeout(complete, 100);
      }, graceMs);
    });
    this.idleWaiters.clear();
    await new Promise<void>(resolve => {
      let timer: NodeJS.Timeout | undefined;
      const complete = () => { clearTimeout(timer); resolve(); };
      timer = setTimeout(() => { forced = true; complete(); }, cleanupMs);
      Promise.resolve().then(closeDatabase).then(complete, () => { forced = true; complete(); });
    });
    return forced ? 'forced' : 'graceful';
  }
}

/** Installs only this server's handlers, without disturbing other process signal listeners. */
export const installShutdownHandlers = (
  server: Server,
  lifecycle: ServerLifecycle,
  closeDatabase: () => Promise<void>,
  graceMs: number,
  cleanupMs: number,
  stopped: (outcome: 'graceful' | 'forced') => void
) => {
  let started = false;
  const shutdown = () => {
    if (started) return;
    started = true;
    void lifecycle.stop(server, closeDatabase, graceMs, cleanupMs).then(outcome => {
      dispose();
      stopped(outcome);
    });
  };
  const dispose = () => {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return dispose;
};
