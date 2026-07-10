// Proof MCP — boot-time handoff surfacing + best-effort auto-open (Goal #1).
//
// HONEST SCOPE. The web app cannot launch a desktop app, and an MCP server is a
// child process of whatever host already launched it — so "auto-open the host"
// is mostly a no-op by construction: the host is already open and running this
// process. What we CAN do, genuinely, is:
//
//   1. On boot (cloud mode), check for PENDING handoffs targeted at this device
//      and print them to stderr so they show up in the host's MCP/server logs —
//      a real, visible "you have N briefs waiting; call claim_handoff(<id>)".
//   2. Behind an opt-in flag (--open / PROOF_AUTO_OPEN=1), run the OS "open"
//      command on the handoff's repo path (best-effort). This can pop the folder
//      in Finder/Explorer or, with a registered handler, an editor — but it is
//      OS-dependent and disabled by default to avoid surprising side effects.
//
// Everything here is best-effort and never throws into the boot path.

import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listPendingHandoffs } from './cloudTools.js';
import { envVar } from './env.js';

/** Whether the user opted into OS-open behaviour. */
export function autoOpenEnabled(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): boolean {
  if (argv.includes('--open')) return true;
  const v = (envVar('AUTO_OPEN', env) ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** The platform-appropriate "open this path" command, or null if unknown. */
function openCommand(target: string): { cmd: string; args: string[] } | null {
  switch (platform()) {
    case 'darwin':
      return { cmd: 'open', args: [target] };
    case 'win32':
      // `start` is a cmd builtin; invoke via cmd /c. The empty "" is the title
      // arg `start` expects before the path.
      return { cmd: 'cmd', args: ['/c', 'start', '', target] };
    case 'linux':
      return { cmd: 'xdg-open', args: [target] };
    default:
      return null;
  }
}

/**
 * Best-effort OS open of a path. Detached + unref'd so it never holds the MCP
 * process open, and errors are swallowed (the binary may be absent in a
 * headless container). Returns true if a command was spawned.
 */
export function openPath(target: string): boolean {
  if (!target) return false;
  const spec = openCommand(target);
  if (!spec) return false;
  try {
    const child = spawn(spec.cmd, spec.args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {
      /* binary missing / not permitted — swallow */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * On boot, surface pending handoffs for this device to stderr (always) and,
 * when auto-open is enabled, OS-open the most recent handoff's repo path.
 *
 * Never throws. Returns the number of pending handoffs found (0 on any error).
 */
export async function surfacePendingHandoffs(
  client: SupabaseClient,
  opts: { autoOpen: boolean } = { autoOpen: false },
): Promise<number> {
  try {
    const res = (await listPendingHandoffs(client, {
      includeUntargeted: true,
      limit: 20,
    })) as {
      total: number;
      handoffs: {
        runId: string;
        intent: string | null;
        handoff: Record<string, unknown> | null;
      }[];
    };
    const handoffs = res.handoffs ?? [];
    if (handoffs.length === 0) {
      console.error('[proof-mcp] handoffs: none pending for this device.');
      return 0;
    }
    console.error(
      `[proof-mcp] handoffs: ${handoffs.length} pending for this device — call claim_handoff(<runId>) to start:`,
    );
    for (const h of handoffs) {
      const title =
        (typeof h.intent === 'string' && h.intent.trim()) || '(no intent)';
      console.error(`  • ${h.runId} — ${title}`);
    }
    if (opts.autoOpen) {
      // Open the most recent handoff's repo path, when it carries one.
      const top = handoffs[0];
      const repoPath = readRepoPath(top.handoff);
      if (repoPath) {
        const ok = openPath(repoPath);
        console.error(
          ok
            ? `[proof-mcp] handoffs: auto-open requested for ${repoPath}.`
            : `[proof-mcp] handoffs: auto-open not available on this platform for ${repoPath}.`,
        );
      } else {
        console.error(
          '[proof-mcp] handoffs: auto-open is on, but the top handoff carries no repo path to open.',
        );
      }
    }
    return handoffs.length;
  } catch (err) {
    console.error(
      `[proof-mcp] handoffs: check failed (best-effort): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
  }
}

/** Best-effort pull of a target repo/cwd path from a handoff payload. */
function readRepoPath(handoff: Record<string, unknown> | null): string | null {
  if (!handoff) return null;
  const cwd = handoff.cwd;
  if (typeof cwd === 'string' && cwd) return cwd;
  const repoPath = handoff.repoPath;
  if (typeof repoPath === 'string' && repoPath) return repoPath;
  return null;
}
