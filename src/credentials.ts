// Credentials persistence at ~/.proof/credentials.json (chmod 600 on POSIX).
//
// The shape is intentionally small — supabase-js handles the access-token
// lifecycle from the refresh token, so all we ever need to write to disk is
// the refresh token and the project URL/anon key it pairs with.
//
// LEGACY: the server used to store under ~/.heuresis. Reads fall back to that
// path when ~/.proof has no credentials yet, and the next write lands in
// ~/.proof — so a machine paired under the old name keeps working and quietly
// migrates on the next token rotation.
//
// Format:
//   {
//     "supabase_url": "https://xyz.supabase.co",
//     "anon_key":     "ey...",
//     "refresh_token":"ey...",
//     "user_id":      "uuid",
//     "device_name":  "hostname-shortRandom",
//     "created_at":   "2026-05-21T..."
//   }
//
// Phase 19.3 will move refresh-token issuance behind the `mcp-device-grant`
// Edge Function and add a `refresh_token_id` column we record server-side.
// For now (19.1) the shape on disk matches what the user will paste from the
// browser link.

import { mkdir, readFile, writeFile, chmod, unlink, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface HeuresisCredentials {
  supabase_url: string;
  anon_key: string;
  refresh_token: string;
  user_id: string;
  device_name: string;
  created_at: string;
}

const isWindows = process.platform === 'win32';

/** The primary credentials path — ~/.proof/credentials.json. Writes always
 *  land here. */
export function credentialsPath(): string {
  return join(homedir(), '.proof', 'credentials.json');
}

/** The legacy path — ~/.heuresis/credentials.json. Read-only fallback for
 *  machines paired before the rename. */
function legacyCredentialsPath(): string {
  return join(homedir(), '.heuresis', 'credentials.json');
}

/** The path we should READ from: the new one when present, else the legacy
 *  one when it exists. Returns null when neither is present. */
function readablePath(): string | null {
  const primary = credentialsPath();
  if (existsSync(primary)) return primary;
  const legacy = legacyCredentialsPath();
  if (existsSync(legacy)) return legacy;
  return null;
}

export async function readCredentials(): Promise<HeuresisCredentials | null> {
  const path = readablePath();
  if (!path) return null;
  try {
    const text = await readFile(path, 'utf8');
    const data = JSON.parse(text) as Partial<HeuresisCredentials>;
    if (
      !data.supabase_url ||
      !data.anon_key ||
      !data.refresh_token ||
      !data.user_id ||
      !data.device_name ||
      !data.created_at
    ) {
      return null;
    }
    return data as HeuresisCredentials;
  } catch {
    return null;
  }
}

export async function writeCredentials(creds: HeuresisCredentials): Promise<string> {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(creds, null, 2), 'utf8');
  // chmod 600 — owner read/write only. No-op on Windows (NTFS perms are a
  // different model and the file lives in %USERPROFILE% which is already
  // user-private by default).
  if (!isWindows) {
    try {
      await chmod(path, 0o600);
    } catch {
      // best-effort; don't fail login just because of perm bits.
    }
  }
  return path;
}

export async function deleteCredentials(): Promise<boolean> {
  // Remove both the new and legacy files so `logout` fully unlinks a machine
  // regardless of which path it was paired under.
  let removed = false;
  for (const path of [credentialsPath(), legacyCredentialsPath()]) {
    if (!existsSync(path)) continue;
    try {
      await unlink(path);
      removed = true;
    } catch {
      /* best-effort per path */
    }
  }
  return removed;
}

export async function credentialsExist(): Promise<boolean> {
  const path = readablePath();
  if (!path) return false;
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

// ── Cross-process lock ────────────────────────────────────────────────────────
//
// GoTrue refresh tokens are single-use: the exchange consumes the stored token
// and rotates in a new one. When several MCP processes share one
// credentials.json (Claude Desktop + Claude Code + a cloud container), two of
// them can race to exchange the SAME token — the loser gets "Refresh Token Not
// Found" and, worse, can then overwrite the winner's freshly persisted token
// with a dead one. The fix is a small mutual-exclusion lock around the
// read-exchange-persist critical section, held via an exclusively-created lock
// directory next to credentials.json (mkdir is atomic on every platform,
// including Windows).

const LOCK_STALE_MS = 15_000;
const LOCK_RETRY_MS = 150;
const LOCK_WAIT_MS = 20_000;

function lockPath(): string {
  return join(dirname(credentialsPath()), 'credentials.lock');
}

async function acquireLock(): Promise<void> {
  const path = lockPath();
  const deadline = Date.now() + LOCK_WAIT_MS;
  // Ensure ~/.proof exists so the mkdir below fails only when the lock is held.
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try {
      await mkdir(path);
      return;
    } catch {
      // Held by someone else. Steal it when it is stale (holder crashed) so a
      // dead process can never wedge every future login.
      try {
        const s = await stat(path);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // raced with the holder's release — try again immediately
      }
      if (Date.now() > deadline) {
        // Last resort: proceed unlocked rather than deadlock. The exchange has
        // its own retry-on-stale-read fallback, so this stays survivable.
        return;
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

async function releaseLock(): Promise<void> {
  try {
    await rm(lockPath(), { recursive: true, force: true });
  } catch {
    /* best-effort — a stale lock is stolen after LOCK_STALE_MS anyway */
  }
}

/** Run `fn` while holding the cross-process credentials lock. Always releases,
 *  even when `fn` throws. */
export async function withCredentialsLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireLock();
  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}

/** Default device name = `${hostname}-${shortRandom}`. */
export function defaultDeviceName(): string {
  const host = hostname().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'device';
  const rand = randomBytes(3).toString('hex');
  return `${host}-${rand}`;
}
