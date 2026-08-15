// Proof MCP — a retrying, timeout-bounded fetch for flaky networks.
//
// Some networks have an intermittently-broken route to the Supabase edge: the
// TCP connect succeeds but the TLS handshake is sporadically dropped, so a lone
// request fails with "fetch failed" (or, worse, a plain fetch with no timeout
// hangs indefinitely) even though an identical request moments later lands.
// This wrapper bounds each attempt with a timeout and retries transient
// failures with exponential backoff. It is handed to supabase-js as its global
// `fetch`, so every PostgREST query and auth-js background refresh inherits the
// resilience — mirroring what gotrue.ts/postWithRetry and cli.ts/postJson do
// for the calls they own.

export interface RetryFetchOptions {
  attempts?: number;
  perAttemptTimeoutMs?: number;
}

/**
 * Build a `fetch`-compatible function with bounded retry + per-attempt timeout.
 *
 * Retry policy is idempotency-aware so we never risk double-applying a write:
 *   - Transport errors (no response: TLS reset, connection drop, per-attempt
 *     timeout) are retried for ANY method — the request almost certainly never
 *     reached the server.
 *   - 429 / 5xx are retried ONLY for idempotent methods (GET/HEAD). A POST/
 *     PATCH/DELETE that got a 5xx may have been applied server-side, so we hand
 *     that response back unretried and let the caller decide.
 * A caller-supplied AbortSignal is honored: if it aborts, we stop immediately
 * and never retry (the caller asked to cancel).
 */
export function makeRetryingFetch(opts: RetryFetchOptions = {}): typeof fetch {
  const attempts = opts.attempts ?? 4;
  const perAttemptTimeoutMs = opts.perAttemptTimeoutMs ?? 10_000;

  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const idempotent = method === 'GET' || method === 'HEAD';
    const callerSignal = init?.signal ?? undefined;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (callerSignal?.aborted) throw callerSignal.reason ?? new Error('Aborted');
      // Per-attempt timeout, combined with any caller signal so a caller-side
      // cancel still propagates.
      const timeout = AbortSignal.timeout(perAttemptTimeoutMs);
      const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
      try {
        const res = await fetch(input, { ...init, signal });
        if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
          if (!idempotent) return res; // don't retry a non-idempotent server error
          lastErr = new Error(`HTTP ${res.status}`);
        } else {
          return res;
        }
      } catch (err) {
        // A caller-initiated abort is terminal — surface it, don't retry.
        if (callerSignal?.aborted) throw err;
        lastErr = err; // transport error / per-attempt timeout — retry
      }
      if (attempt < attempts) {
        // Backoff: 250ms, 500ms, 1000ms, … capped at 2s.
        await new Promise((r) => setTimeout(r, Math.min(250 * 2 ** (attempt - 1), 2000)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }) as typeof fetch;
}
