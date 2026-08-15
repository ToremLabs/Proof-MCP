// Proof MCP — device install metadata (Goal #1, the handoff spine).
//
// When the MCP server boots in cloud mode it best-effort detects WHERE it was
// installed — which host app launched it (Claude Code / Cursor / Claude Desktop
// / VS Code), the OS, and the working-directory / repo it was started in — and
// stamps that onto its own `user_mcp_devices` row (column added in migration
// 0046). The Agent ▸ MCP subtab reads this back to show "online + host + repo"
// and to route a handoff to the right device.
//
// Everything here is BEST-EFFORT and PURE-ish:
//   * detectHostApp / collectDeviceMetadata read process.env + os + cwd only;
//     they never throw and degrade to 'unknown' when nothing is recognisable.
//   * stampDeviceMetadata does one UPDATE against user_mcp_devices for the
//     current user's active row matching the device_name; a failure (RLS, row
//     not found, table missing) is logged to stderr and swallowed — it must
//     never break the server boot or a tool call.

import { hostname, platform, release } from 'node:os';
import { basename } from 'node:path';
import { envVar } from './env.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Known host apps we can route a handoff back to. */
export type McpHost =
  | 'claude-code'
  | 'claude-desktop'
  | 'cursor'
  | 'vscode'
  | 'windsurf'
  | 'zed'
  | 'unknown';

export interface DeviceMetadata {
  host: McpHost;
  hostLabel: string;
  os: string;
  osRelease: string;
  cwd: string;
  repo: string;
  label: string;
  mcpVersion?: string;
  stampedAt: number;
}

const HOST_LABELS: Record<McpHost, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  zed: 'Zed',
  unknown: 'Unknown host',
};

/** Pretty label for a host id. Exported so the UI side could share it later. */
export function hostLabel(host: McpHost): string {
  return HOST_LABELS[host] ?? HOST_LABELS.unknown;
}

/**
 * Best-effort detection of which host app launched this MCP process.
 *
 * Order of precedence:
 *   1. An explicit `--host <name>` flag (or PROOF_HOST env; legacy HEURESIS_HOST) — the user's
 *      own override always wins and is normalised to a known id when possible.
 *   2. Well-known environment markers each host sets in the child process:
 *      - Claude Code sets CLAUDECODE / CLAUDE_CODE_* and a CLAUDE_* family.
 *      - Cursor sets CURSOR_* / the editor TERM_PROGRAM "cursor".
 *      - VS Code sets TERM_PROGRAM=vscode and VSCODE_* vars.
 *      - Claude Desktop runs MCP servers but exports little; we fall back to a
 *        generic "claude-desktop" when a CLAUDE_DESKTOP marker is present.
 *   3. 'unknown' when nothing matches.
 *
 * Pure: reads `env` only, returns a known id. Never throws.
 */
export function detectHostApp(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): McpHost {
  // 1. Explicit override.
  const explicit = readHostFlag(argv) ?? envVar('HOST', env);
  if (explicit) {
    const norm = normaliseHost(explicit);
    if (norm) return norm;
  }

  // 2. Environment markers.
  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();

  // Claude Code exports CLAUDECODE=1 and a CLAUDE_CODE_ENTRYPOINT in the MCP
  // child env.
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SSE_PORT) {
    return 'claude-code';
  }
  if (env.CURSOR_TRACE_ID || env.CURSOR_CHANNEL || termProgram === 'cursor') {
    return 'cursor';
  }
  if (env.WINDSURF_ENV || termProgram === 'windsurf') {
    return 'windsurf';
  }
  if (env.ZED_TERM || termProgram === 'zed') {
    return 'zed';
  }
  if (termProgram === 'vscode' || env.VSCODE_PID || env.VSCODE_CWD) {
    return 'vscode';
  }
  // Claude Desktop is the catch-all when a CLAUDE marker exists but it's not
  // Claude Code (which we already matched above).
  if (env.CLAUDE_DESKTOP || env.CLAUDE_DESKTOP_ENTRYPOINT) {
    return 'claude-desktop';
  }
  return 'unknown';
}

/** Parse `--host <name>` (or `--host=<name>`) from argv. Returns the raw value. */
function readHostFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') return argv[i + 1];
    if (a.startsWith('--host=')) return a.slice('--host='.length);
  }
  return undefined;
}

/** Normalise a free-form host string to a known id, or undefined. */
function normaliseHost(raw: string): McpHost | undefined {
  const s = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const known: McpHost[] = [
    'claude-code',
    'claude-desktop',
    'cursor',
    'vscode',
    'windsurf',
    'zed',
    'unknown',
  ];
  if ((known as string[]).includes(s)) return s as McpHost;
  // Friendly aliases.
  if (s === 'claude' || s === 'claudecode') return 'claude-code';
  if (s === 'claude-desktop-app' || s === 'desktop') return 'claude-desktop';
  if (s === 'code' || s === 'visual-studio-code') return 'vscode';
  return undefined;
}

/**
 * Collect the full metadata bag for this install. `deviceName` is the credential
 * device name (used to build a friendly label); `mcpVersion` is the running
 * package version. Pure (reads os + cwd + env); never throws.
 */
export function collectDeviceMetadata(opts: {
  deviceName: string;
  mcpVersion?: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  cwd?: string;
}): DeviceMetadata {
  const env = opts.env ?? process.env;
  const argv = opts.argv ?? process.argv;
  const host = detectHostApp(env, argv);
  const cwd = opts.cwd ?? safeCwd();
  // The repo is the basename of the working directory — a cheap, dependency-free
  // proxy for "which project". Good enough to disambiguate two installs of the
  // same host on one machine.
  const repo = basename(cwd) || hostname();
  const label = buildLabel(opts.deviceName, host, repo);
  return {
    host,
    hostLabel: hostLabel(host),
    os: platform(),
    osRelease: release(),
    cwd,
    repo,
    label,
    mcpVersion: opts.mcpVersion,
    stampedAt: Date.now(),
  };
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return '';
  }
}

/** Build a human label like "Claude Code — proof". Falls back gracefully. */
function buildLabel(deviceName: string, host: McpHost, repo: string): string {
  const left = host === 'unknown' ? deviceName : hostLabel(host);
  return repo ? `${left} — ${repo}` : left;
}

/**
 * Stamp the collected metadata onto the current user's matching device row.
 *
 * We resolve the row by `device_name` (the credential's device name) among the
 * user's ACTIVE (revoked_at IS NULL) rows; that's how the device was registered
 * by mcp-device-grant. We also refresh `last_seen_at` in the same write so the
 * subtab's online indicator is honest. Best-effort: any failure is logged to
 * stderr and swallowed.
 *
 * Returns the updated device id on success, or null otherwise.
 */
export async function stampDeviceMetadata(
  client: SupabaseClient,
  userId: string,
  deviceName: string,
  metadata: DeviceMetadata,
): Promise<string | null> {
  try {
    // Find the active row for this device name (most-recently created wins if a
    // user re-paired the same name).
    const sel = await client
      .from('user_mcp_devices')
      .select('id')
      .eq('user_id', userId)
      .eq('device_name', deviceName)
      .is('revoked_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (sel.error) {
      console.error(
        `[proof-mcp] device metadata: lookup failed (best-effort): ${sel.error.message}`,
      );
      return null;
    }
    const row = sel.data as { id: string } | null;
    if (!row) {
      // No matching device row (e.g. headless email/password mode has no
      // device pairing). Nothing to stamp — not an error.
      return null;
    }
    const upd = await client
      .from('user_mcp_devices')
      .update({
        metadata: metadata as unknown,
        last_seen_at: new Date().toISOString(),
      } as never)
      .eq('id', row.id);
    if (upd.error) {
      console.error(
        `[proof-mcp] device metadata: update failed (best-effort): ${upd.error.message}`,
      );
      return null;
    }
    return row.id;
  } catch (err) {
    console.error(
      `[proof-mcp] device metadata: threw (best-effort): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
