// How HttpClient handles a response: waits that honour the read's abort
// signal, best-effort stream cleanup, and charset-aware decoding.

/**
 * Decodes with the charset the response declares (UTF-8 when absent or
 * unknown). The observed providers all send UTF-8; a page declared as
 * ISO-8859-1 or windows-1252 would otherwise lose every accented letter.
 * TextDecoder also drops a UTF-8 byte-order mark, which JSON.parse rejects.
 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const label = contentType?.match(/;\s*charset\s*=\s*"?([^";\s]+)/i)?.[1];
  if (label) {
    try { return new TextDecoder(label).decode(bytes); } catch { /* Unknown label: fall back to UTF-8. */ }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export function cancelBody(body: ReadableStream<Uint8Array> | null | undefined) {
  if (!body) return;
  try { void body.cancel().catch(() => {}); } catch { /* Best-effort cleanup must not mask the response error. */ }
}

export function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try { void reader.cancel().catch(() => {}); } catch { /* Best-effort cleanup must not mask the response error. */ }
}

export function withSignal<T>(operation: PromiseLike<T>, signal: AbortSignal, onLate?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return;
      settled = true; cleanup(); reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(value => {
      if (settled) { try { onLate?.(value); } catch {} return; }
      settled = true; cleanup(); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    });
    if (signal.aborted) abort();
  });
}
