import { net } from 'electron';

// net.fetch cancels manual redirects. Expose them with net.request so the provider
// can validate every hop before opening the next URL, while keeping system proxy support.
export const electronResourceFetch: typeof fetch = (input, init) => new Promise<Response>((resolve, reject) => {
  const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
  const request = net.request({ url, method: 'GET', redirect: 'manual' });
  let settled = false;
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cleanup = () => init?.signal?.removeEventListener('abort', abort);
  const fail = (error: Error) => {
    if (finished) return;
    finished = true;
    cleanup();
    if (!settled) reject(error);
    else controller?.error(error);
  };
  const abort = () => { fail(new Error('资源请求已取消或超时')); request.abort(); };
  request.on('error', fail);
  request.on('redirect', (status, _method, destination) => {
    if (settled || finished) return;
    settled = finished = true;
    cleanup();
    resolve(new Response(null, { status, headers: { Location: destination } }));
    request.abort();
  });
  request.on('response', response => {
    if (settled || finished) return;
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    if ([204, 205, 304].includes(response.statusCode)) {
      settled = finished = true;
      cleanup();
      resolve(new Response(null, { status: response.statusCode, headers }));
      request.abort();
      return;
    }
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        // Electron requires the end listener to be installed before the data listener.
        response.on('end', () => { if (!finished) { finished = true; cleanup(); controller!.close(); } });
        response.on('error', fail);
        response.on('aborted', () => fail(new Error('资源下载中断')));
        response.on('data', bytes => { if (!finished) controller!.enqueue(new Uint8Array(bytes)); });
      },
      cancel() { finished = true; cleanup(); request.abort(); },
    });
    settled = true;
    resolve(new Response(body, { status: response.statusCode, headers }));
  });
  for (const [name, value] of new Headers(init?.headers)) request.setHeader(name, value);
  if (init?.signal?.aborted) { abort(); return; }
  init?.signal?.addEventListener('abort', abort, { once: true });
  request.end();
});
