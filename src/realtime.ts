// Proof MCP - Supabase Realtime CDC subscription (Phase 19.8).
//
// We subscribe to row-level changes on the four workspace tables that the
// webapp also watches: nodes, edges, projects, ideas. When a change lands we
// fire a single callback so the MCP server can notify its client (Claude
// Desktop, Claude Code, Cursor, etc.) that the workspace state has moved.
//
// One channel per process, filtered by workspace_id. RLS still applies to
// Realtime payloads, so even if a stray row leaks through the publication a
// non-member of the workspace would not see it. The filter is belt-and-braces.
//
// Reconnect behavior:
//   supabase-js auto-reconnects on transient socket drops. We hook the
//   subscribe-status callback and re-emit a "resync" event on every
//   SUBSCRIBED transition that follows a CLOSED / CHANNEL_ERROR / TIMED_OUT
//   state, so the client knows it may have missed updates while offline and
//   should refetch.
//
// CLI flag:
//   The default is ON. Users can opt out with `--no-realtime` (one-shot for
//   this process) or persistently by setting `{ realtime: false }` in
//   ~/.proof/config.json (legacy ~/.heuresis). The CLI flag wins over the config file when both
//   are present.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RealtimeTable = 'nodes' | 'edges' | 'projects' | 'ideas';
export type RealtimeEventKind = 'INSERT' | 'UPDATE' | 'DELETE' | 'RESYNC';

export interface RealtimeChangeEvent {
  table: RealtimeTable | null;
  eventType: RealtimeEventKind;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
}

export type RealtimeChangeHandler = (event: RealtimeChangeEvent) => void;

const TABLES: RealtimeTable[] = ['nodes', 'edges', 'projects', 'ideas'];

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/**
 * Subscribe to Postgres change events on the user's workspace and call
 * `onChange` for every row change (INSERT / UPDATE / DELETE) and for every
 * post-reconnect resync signal.
 *
 * Returns an `unsubscribe` function that tears down the channel. Safe to call
 * more than once; subsequent calls are no-ops.
 */
export function startRealtimeSubscription(
  client: SupabaseClient,
  workspaceId: string,
  onChange: RealtimeChangeHandler,
): () => void {
  const channelName = `proof-mcp-ws-${workspaceId}`;
  const channel = client.channel(channelName);
  let everSubscribed = false;
  let lastStatusWasBad = false;

  for (const table of TABLES) {
    channel.on(
      // The supabase-js types for `channel.on('postgres_changes', ...)` are
      // strictly typed against a string-literal overload. Casting through
      // `any` keeps this file readable while still matching the runtime API.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'postgres_changes' as any,
      {
        event: '*',
        schema: 'public',
        table,
        filter: `workspace_id=eq.${workspaceId}`,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload: any) => {
        const newRow = payload && typeof payload.new === 'object' && payload.new
          ? (payload.new as Record<string, unknown>)
          : null;
        const oldRow = payload && typeof payload.old === 'object' && payload.old
          ? (payload.old as Record<string, unknown>)
          : null;
        const eventType: RealtimeEventKind =
          payload?.eventType === 'INSERT' || payload?.eventType === 'UPDATE' || payload?.eventType === 'DELETE'
            ? payload.eventType
            : 'UPDATE';
        try {
          onChange({ table, eventType, new: newRow, old: oldRow });
        } catch (err) {
          console.error('[proof-mcp] realtime handler threw:', err);
        }
      },
    );
  }

  channel.subscribe((status, err) => {
    // status is one of SUBSCRIBED | TIMED_OUT | CLOSED | CHANNEL_ERROR.
    if (status === 'SUBSCRIBED') {
      if (everSubscribed && lastStatusWasBad) {
        // Reconnect: tell the caller it may have missed events while the
        // socket was down.
        try {
          onChange({ table: null, eventType: 'RESYNC', new: null, old: null });
        } catch (handlerErr) {
          console.error('[proof-mcp] realtime resync handler threw:', handlerErr);
        }
        console.error(
          `[proof-mcp] realtime: reconnected to workspace ${workspaceId} (possible missed updates).`,
        );
      } else {
        console.error(
          `[proof-mcp] realtime: subscribed to workspace ${workspaceId} (tables: ${TABLES.join(', ')}).`,
        );
      }
      everSubscribed = true;
      lastStatusWasBad = false;
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      lastStatusWasBad = true;
      const detail = err ? `: ${err.message}` : '';
      console.error(`[proof-mcp] realtime: channel ${status}${detail}. supabase-js will retry.`);
    }
  });

  let torn = false;
  return () => {
    if (torn) return;
    torn = true;
    try {
      void client.removeChannel(channel);
    } catch (err) {
      console.error('[proof-mcp] realtime: removeChannel failed:', err);
    }
  };
}

/**
 * Resolve the workspace the MCP session should subscribe to. Same single-
 * workspace rule the cloud tools use: first workspace visible to the user,
 * ordered by name. A future per-session override (workspace id in
 * credentials.json or an env var) can replace this.
 */
export async function resolveSubscriptionWorkspaceId(
  client: SupabaseClient,
): Promise<string | null> {
  const res = await client
    .from('workspaces')
    .select('id, name')
    .order('name', { ascending: true })
    .limit(1);
  if (res.error) {
    console.error(`[proof-mcp] realtime: failed to resolve workspace: ${res.error.message}`);
    return null;
  }
  const rows = (res.data ?? []) as { id: string; name: string }[];
  return rows.length > 0 ? rows[0].id : null;
}

// ---------------------------------------------------------------------------
// Config file (~/.proof/config.json, legacy ~/.heuresis) and CLI flag handling
// ---------------------------------------------------------------------------

export interface HeuresisConfig {
  /** When false, the MCP skips the Realtime subscription on startup. */
  realtime?: boolean;
}

/** Primary config path — ~/.proof/config.json. Writes always land here. */
export function configPath(): string {
  return join(homedir(), '.proof', 'config.json');
}

/** Legacy ~/.heuresis/config.json — read-only fallback for older installs. */
function legacyConfigPath(): string {
  return join(homedir(), '.heuresis', 'config.json');
}

export async function readConfig(): Promise<HeuresisConfig> {
  const path = existsSync(configPath())
    ? configPath()
    : existsSync(legacyConfigPath())
      ? legacyConfigPath()
      : null;
  if (!path) return {};
  try {
    const text = await readFile(path, 'utf8');
    const data = JSON.parse(text) as HeuresisConfig;
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export async function writeConfig(next: HeuresisConfig): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const current = await readConfig();
  const merged = { ...current, ...next };
  await writeFile(path, JSON.stringify(merged, null, 2), 'utf8');
  return path;
}

/**
 * Read the effective "should Realtime be on?" decision from (in order):
 *   1. The CLI flag `--no-realtime` (or `--realtime` to force on).
 *   2. The `realtime` field in ~/.proof/config.json (legacy ~/.heuresis).
 *   3. Default: true.
 *
 * Also persists a CLI flag back to the config file so the preference sticks
 * across runs (the user only has to pass `--no-realtime` once).
 */
export async function readRealtimeFlag(argv: string[] = process.argv): Promise<boolean> {
  const hasOff = argv.includes('--no-realtime');
  const hasOn = argv.includes('--realtime');
  if (hasOff && hasOn) {
    console.error('[proof-mcp] both --no-realtime and --realtime passed; --no-realtime wins.');
  }
  if (hasOff) {
    await writeConfig({ realtime: false });
    return false;
  }
  if (hasOn) {
    await writeConfig({ realtime: true });
    return true;
  }
  const cfg = await readConfig();
  if (cfg.realtime === false) return false;
  return true;
}

/**
 * Strip realtime-related flags from argv so the subcommand dispatch in
 * index.ts does not mistake them for an unknown subcommand.
 */
export function stripRealtimeFlags(argv: string[]): string[] {
  return argv.filter((a) => a !== '--no-realtime' && a !== '--realtime');
}
