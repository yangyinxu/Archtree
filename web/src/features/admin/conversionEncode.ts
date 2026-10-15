import type { AdminGuard } from './adminTransport';
import type { ConversionLocalError, ConversionErrorCode, ConversionStore, ConversionTask } from './conversionStore';
import type { ConversionProgress } from './conversionRunner';
import type { ConversionEncodingResult, ConversionWorkerMessage, ConversionWorkerRequest } from './conversionWorkerProtocol';

export interface ConversionEncodeDependencies {
  store: Pick<ConversionStore, 'outputHandle' | 'updateTask'>;
  check: (guard: AdminGuard, signal?: AbortSignal, requireFeature?: boolean) => void;
  makeWorker: () => Worker;
  parseResult: (value: unknown) => ConversionEncodingResult;
  ErrorClass: typeof ConversionLocalError;
  errorCodes: readonly ConversionErrorCode[];
  /** The owning runner registers termination, then clears only this same Worker. */
  activeWorker: (worker: Worker, registered: boolean) => void;
}

/** One Worker owns one encoding; durable completion requires an independent local output digest. */
export async function encodeConversionTask(task: ConversionTask, file: File, guard: AdminGuard, signal: AbortSignal,
  progress: ((event: ConversionProgress) => void) | undefined, dependencies: ConversionEncodeDependencies): Promise<ConversionTask> {
  const { store, check, makeWorker, parseResult, ErrorClass, errorCodes, activeWorker } = dependencies;
  check(guard, signal); const output = await store.outputHandle(task); check(guard, signal);
  return new Promise<ConversionTask>((resolve, reject) => {
    const worker = makeWorker(); activeWorker(worker, true);
    let settled = false;
    const finish = (error?: unknown, value?: ConversionTask) => {
      if (settled) return; settled = true; signal.removeEventListener('abort', cancel);
      worker.terminate(); activeWorker(worker, false); error ? reject(error) : resolve(value!);
    };
    const cancel = () => finish(new ErrorClass('conversion_cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    worker.onerror = () => finish(new ErrorClass('conversion_encoder_failed'));
    worker.onmessage = (event: MessageEvent<ConversionWorkerMessage>) => {
      if (settled) return;
      try {
        check(guard, signal); const message = event.data;
        if (message?.taskId !== task.id) throw new ErrorClass('conversion_output_invalid');
        if (message.type === 'progress') {
          if (!['validating', 'encoding', 'verifying'].includes(message.stage) || !Number.isFinite(message.progress)
            || message.progress < 0 || message.progress > 1) throw new ErrorClass('conversion_output_invalid');
          progress?.({ taskId: task.id, stage: message.stage, progress: message.progress }); return;
        }
        if (message.type === 'failed') {
          finish(new ErrorClass(errorCodes.includes(message.code) ? message.code : 'conversion_encoder_failed')); return;
        }
        if (message.type !== 'complete') throw new ErrorClass('conversion_output_invalid');
        const result = parseResult(message.result);
        if (task.result && (result.outputSha256 !== task.result.outputSha256 || result.outputBytes !== task.result.outputBytes)
          || result.sourceSha256 !== task.source.sha256 || result.sourceBytes !== task.source.byteLength) throw new ErrorClass('conversion_output_invalid');
        void (async () => {
          const actual = await output.getFile(); check(guard, signal);
          const { hashConversionFile } = await import('./conversionSourceValidation');
          if (actual.size !== result.outputBytes || await hashConversionFile(actual, () => check(guard, signal)) !== result.outputSha256) throw new ErrorClass('conversion_output_invalid');
          check(guard, signal);
          return store.updateTask(task.ownerId, task.batchId, task.id, { result, status: 'complete', error: null, cacheRemoved: false }, guard);
        })().then(value => finish(undefined, value), error => finish(error));
      } catch (error) { finish(error instanceof ErrorClass ? error : new ErrorClass('conversion_output_invalid')); }
    };
    try {
      check(guard, signal);
      const request: ConversionWorkerRequest = { type: 'convert', taskId: task.id, source: file, output, preset: 'mp3-320' };
      worker.postMessage(request);
    } catch (error) { finish(error); }
  });
}
