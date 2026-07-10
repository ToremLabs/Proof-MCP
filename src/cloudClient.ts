// Proof MCP — Supabase client wrapper.
//
// One SupabaseClient per MCP process. We DON'T let supabase-js persist the
// session to localStorage (no such thing in Node) — instead we manage the
// session manually:
//
//   1. At process start: read ~/.proof/credentials.json (or the legacy ~/.heuresis one) → exchange the
//      refresh token for a fresh session by hitting the GoTrue token endpoint
//      directly (see gotrue.ts), then hand the resulting access_token +
//      refresh_token to `client.auth.setSession(...)`. We deliberately do NOT
//      use the old `setSession({ access_token: '', refresh_token })` trick:
//      auth-js 2.x rejects an empty access_token with "Auth session missing!"
//      before it ever refreshes. With a real access_token the guard passes
//      and supabase-js stores both tokens in memory.
//   2. supabase-js handles silent re-refresh in the background while the
//      process runs. We don't have to do anything per-tool-call.
//   3. If the refresh fails (revoked, expired), the bootstrap throws — the
//      wrapper surfaces a "re-run login" message.

// Polyfill global WebSocket on Node < 22 before any Supabase client is built.
import './wsPolyfill.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  readCredentials,
  writeCredentials,
  withCredentialsLock,
  type HeuresisCredentials,
} from './credentials.js';
import { exchangeRefreshToken, signInWithPassword, type GoTrueSession } from './gotrue.js';
import { makeRetryingFetch } from './httpRetry.js';

// Shared across every Supabase client we build: PostgREST queries and auth-js's
// background refresh both go through this, so a flaky route can't hang or
// one-shot-fail a data call (see httpRetry.ts).
const retryingFetch = makeRetryingFetch();

let cached: { client: SupabaseClient; userId: string } | null = null;

// The device name from credentials.json, captured at bootstrap so provenance
// stamps can record WHICH device an MCP write came from (surfaced in the webapp
// timeline once it syncs cloud provenance). null in headless/password mode,
// which has no device pairing.
let activeDeviceName: string | null = null;
export function getActiveDeviceName(): string | null {
  return activeDeviceName;
}

// The `user_mcp_devices.id` of THIS install, resolved when device metadata is
// stamped at boot (deviceMetadata.stampDeviceMetadata). Lets the handoff tools
// target / claim runs for exactly this device. null in headless/password mode
// (no device pairing) or before the first stamp.
let activeDeviceId: string | null = null;
export function getActiveDeviceId(): string | null {
  return activeDeviceId;
}
export function setActiveDeviceId(id: string | null): void {
  activeDeviceId = id;
}

export class CloudAuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CloudAuthError';
  }
}

/**
 * Create a headless Supabase client and seed it with an already-obtained
 * GoTrue session, so every subsequent PostgREST call carries the user's JWT
 * and supabase-js keeps the in-memory access token alive. Caches the result.
 */
async function seedClient(
  supabaseUrl: string,
  anonKey: string,
  session: GoTrueSession,
  userId: string,
): Promise<{ client: SupabaseClient; userId: string }> {
  const client = createClient(supabaseUrl, anonKey, {
    auth: {
      // Headless: no localStorage, no URL detection, no auto-refresh
      // listeners writing to disk. The library still auto-refreshes the
      // in-memory access token from the refresh token, which is all we want.
      persistSession: false,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    // Harden every PostgREST query / background refresh against the flaky
    // route to the Supabase edge: bounded timeout + retry instead of an
    // unbounded hang on a dropped TLS handshake.
    global: { fetch: retryingFetch },
  });
  const { error } = await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) {
    throw new CloudAuthError(`Failed to seed Proof session: ${error.message}.`);
  }
  cached = { client, userId };
  return cached;
}

/**
 * Persist a rotated refresh token back to ~/.proof/credentials.json.
 *
 * GoTrue rotates the refresh token on every exchange and invalidates the old
 * one. The bootstrap exchange — and supabase-js's later silent auto-refreshes —
 * therefore make the on-disk token stale the moment we use it. If we never
 * write the replacement back, the NEXT process start reads a spent token and
 * fails with "Refresh Token Not Found", forcing a needless re-login (the MCP
 * server is restarted on every Claude reconnect, so this bites constantly).
 * Writing the new token back keeps the stored credential usable across
 * restarts. Best-effort: a failed disk write must never break the live
 * in-memory session, which is already valid for this process.
 */
async function persistRotatedToken(
  creds: HeuresisCredentials,
  newToken: string | undefined,
): Promise<void> {
  if (!newToken || newToken === creds.refresh_token) return;
  try {
    await writeCredentials({ ...creds, refresh_token: newToken });
    creds.refresh_token = newToken; // keep the in-memory copy in sync
  } catch {
    /* non-fatal — the in-memory session stays valid for this process */
  }
}

/**
 * Build (or return cached) a Supabase client bound to the credentials on
 * disk. Bootstraps by exchanging the stored (rotating) refresh token, then
 * persists the rotated replacement back to disk and keeps it in sync as
 * supabase-js silently re-refreshes over the process lifetime — so the stored
 * credential survives restarts. Throws CloudAuthError if the refresh token has
 * been revoked/rotated away.
 */
export async function getCloudClient(
  creds: HeuresisCredentials,
): Promise<{ client: SupabaseClient; userId: string }> {
  activeDeviceName = creds.device_name ?? activeDeviceName;
  if (cached) return cached;
  try {
    // The whole read-exchange-persist sequence runs under the cross-process
    // credentials lock: refresh tokens are single-use, so two MCP processes
    // sharing one credentials.json (Desktop + Code + a cloud container) must
    // not race to spend the same token or overwrite each other's rotation.
    const session = await withCredentialsLock(async () => {
      // Re-read INSIDE the lock — a sibling process may have rotated the token
      // after our boot-time read, making our in-memory copy stale.
      const onDisk = await readCredentials();
      if (onDisk && onDisk.supabase_url === creds.supabase_url) {
        creds.refresh_token = onDisk.refresh_token;
      }
      let s: GoTrueSession;
      try {
        s = await exchangeRefreshToken(
          creds.supabase_url,
          creds.anon_key,
          creds.refresh_token,
        );
      } catch (err) {
        // "Refresh Token Not Found" usually means a sibling spent it between
        // our read and our exchange (or the lock was force-stolen). If the
        // file now carries a DIFFERENT token, that sibling persisted its
        // rotation — retry once with the fresh one before giving up.
        const latest = await readCredentials();
        if (
          !latest ||
          latest.supabase_url !== creds.supabase_url ||
          latest.refresh_token === creds.refresh_token
        ) {
          throw err;
        }
        creds.refresh_token = latest.refresh_token;
        s = await exchangeRefreshToken(
          creds.supabase_url,
          creds.anon_key,
          creds.refresh_token,
        );
      }
      // The exchange just consumed the on-disk token and rotated in a new one;
      // persist it before releasing the lock so a crash here can't strand us.
      await persistRotatedToken(creds, s.refresh_token);
      return s;
    });
    const result = await seedClient(creds.supabase_url, creds.anon_key, session, creds.user_id);
    // Keep disk current as supabase-js auto-refreshes the token while we run.
    // Under the lock: a sibling process may be mid-exchange on the same file.
    result.client.auth.onAuthStateChange((event, s) => {
      if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && s?.refresh_token) {
        void withCredentialsLock(() => persistRotatedToken(creds, s.refresh_token)).catch(
          () => {
            /* best-effort — the in-memory session stays valid */
          },
        );
      }
    });
    return result;
  } catch (err) {
    if (err instanceof CloudAuthError) throw err;
    throw new CloudAuthError(
      `Failed to refresh Proof session: ${
        err instanceof Error ? err.message : String(err)
      }. Run \`npx -y @toremlabs/proof-mcp login\` to re-authenticate.`,
    );
  }
}

/**
 * Build (or return cached) a Supabase client by signing in fresh with an
 * email + password. Because a password is not consumed on use, this works
 * durably across disposable/ephemeral sessions that re-authenticate on every
 * boot — no persisted, rotating refresh token required. Throws CloudAuthError
 * on bad credentials or if password sign-in is disabled for the project.
 */
export async function getCloudClientFromPassword(
  supabaseUrl: string,
  anonKey: string,
  email: string,
  password: string,
): Promise<{ client: SupabaseClient; userId: string }> {
  if (cached) return cached;
  try {
    const session = await signInWithPassword(supabaseUrl, anonKey, email, password);
    const userId = session.user?.id ?? '(unknown)';
    return await seedClient(supabaseUrl, anonKey, session, userId);
  } catch (err) {
    if (err instanceof CloudAuthError) throw err;
    throw new CloudAuthError(
      `Headless email/password sign-in failed: ${
        err instanceof Error ? err.message : String(err)
      }. Check PROOF_EMAIL / PROOF_PASSWORD / PROOF_ANON_KEY.`,
    );
  }
}

/** Clear the cached client. Used after logout. */
export function resetCloudClient(): void {
  cached = null;
}

/**
 * Convenience wrapper that surfaces Postgres / auth errors as a readable
 * MCP tool error. supabase-js returns `{ data, error }` everywhere; this
 * unwraps it.
 */
export function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  if (res.data === null) throw new Error('Empty result from cloud.');
  return res.data;
}

/**
 * Like unwrap(), but a `null` data is RETURNED rather than thrown. Use for
 * `.maybeSingle()` lookups where "no row" is a meaningful outcome the caller
 * handles itself (e.g. `if (!node) return { error: 'No concept with id …' }`).
 * Wrapping those in unwrap() turned a legitimate not-found into the opaque
 * "Empty result from cloud" — and made get_concept throw on dangling ancestry.
 */
export function unwrapMaybe<T>(res: {
  data: T | null;
  error: { message: string } | null;
}): T | null {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}
