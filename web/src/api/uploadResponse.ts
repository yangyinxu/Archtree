/** Measured request-body bytes; a missing browser total keeps the transfer indeterminate. */
export interface UploadProgress { loaded: number; total: number | null }

/** Uses browser upload events while leaving authentication and response validation to the shared API client. */
export function uploadResponse(path: string, init: RequestInit, headers: Headers,
  onProgress: (progress: UploadProgress) => void, assertCurrent?: () => void): Promise<Response> {
  init.signal?.throwIfAborted();
  if (!(init.body instanceof Blob)) throw new TypeError('Upload progress requires a Blob request body.');
  const body = init.body;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const cleanup = () => {
      init.signal?.removeEventListener('abort', abort);
      xhr.upload.onprogress = null; xhr.upload.onload = null;
      xhr.onload = null; xhr.onerror = null; xhr.onabort = null; xhr.ontimeout = null;
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    };
    const stop = () => { try { xhr.abort(); } catch { /* A terminal request already has its recorded outcome. */ } };
    const abort = () => {
      fail(new DOMException('The operation was aborted.', 'AbortError'));
      stop();
    };
    const report = (progress: UploadProgress) => {
      if (settled) return;
      try { assertCurrent?.(); onProgress(progress); }
      catch (error) { fail(error); stop(); }
    };
    xhr.upload.onprogress = event => {
      if (!Number.isFinite(event.loaded) || event.loaded < 0) return;
      const total = event.lengthComputable && Number.isFinite(event.total) && event.total > 0 ? event.total : null;
      report({ loaded: total === null ? event.loaded : Math.min(event.loaded, total), total });
    };
    // Completing the body transfer still leaves the server's admission receipt outstanding.
    xhr.upload.onload = () => report({ loaded: body.size, total: body.size });
    xhr.onerror = xhr.ontimeout = () => fail(new TypeError('Upload network failure.'));
    xhr.onabort = () => fail(new DOMException('The operation was aborted.', 'AbortError'));
    xhr.onload = () => {
      if (settled) return;
      try {
        assertCurrent?.();
        const responseHeaders = new Headers();
        for (const line of xhr.getAllResponseHeaders().split(/\r?\n/)) {
          const colon = line.indexOf(':');
          if (colon > 0) responseHeaders.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
        }
        const response = new Response([204, 205, 304].includes(xhr.status) ? null : xhr.responseText,
          { status: xhr.status, statusText: xhr.statusText, headers: responseHeaders });
        settled = true; cleanup(); resolve(response);
      } catch (error) { fail(error); }
    };
    try {
      xhr.open(init.method ?? 'GET', path, true);
      xhr.responseType = 'text';
      if (init.cache === 'no-store') {
        if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-cache');
        if (!headers.has('Pragma')) headers.set('Pragma', 'no-cache');
      }
      headers.forEach((value, name) => xhr.setRequestHeader(name, value));
      init.signal?.addEventListener('abort', abort, { once: true });
      if (init.signal?.aborted) { abort(); return; }
      report({ loaded: 0, total: body.size });
      if (!settled) xhr.send(body);
    } catch (error) { fail(error); }
  });
}
