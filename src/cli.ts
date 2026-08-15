// Proof MCP — CLI subcommand handlers.
//
// `npx @toremlabs/proof-mcp` with no subcommand → start the MCP stdio server
// (run by Claude Desktop / Claude Code / etc.). With a subcommand it's a
// one-shot CLI:
//   login    — pair this machine with the user's Proof account
//   logout   — delete ~/.proof/credentials.json
//   whoami   — print the linked email + workspace
//   --help   — usage
//
// AUTH UX (device-code poll flow).
// ----------------------------------------------------------
// 1. POST to the `mcp-device-init` Edge Function with the chosen device name.
//    Receive a short XXXX-XXXX code + an expiry.
// 2. Tell the user to open https://proof.toremlabs.com/device (overridable via
//    PROOF_DEVICE_BASE_URL for staging / self-hosted setups) and enter
//    the code.
// 3. Poll `mcp-device-poll` every 5s until status: ok (claim accepted) or
//    410 (expired / already-used), or 15-minute timeout.
// 4. On success, write ~/.proof/credentials.json with the returned
//    refresh_token + supabase_url + anon_key + user_id + device_name and
//    print "Linked to <email>".
//
// The webapp `/device` page calls a third Edge Function `mcp-device-grant`
// to attach the user's identity to the pending grant row.

// Polyfill global WebSocket on Node < 22 before any Supabase client is built.
import './wsPolyfill.js';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  credentialsPath,
  defaultDeviceName,
  deleteCredentials,
  readCredentials,
  writeCredentials,
  type HeuresisCredentials,
} from './credentials.js';
import { exchangeRefreshToken, RefreshTokenError } from './gotrue.js';
import { ensureProxyAgent } from './proxy.js';
import { envVar } from './env.js';

// Where the device pairing UI lives. Production default; can be overridden
// for staging / self-hosted deploys via PROOF_DEVICE_BASE_URL. We also
// allow PROOF_SUPABASE_URL to override which Supabase project the CLI
// talks to (e.g. a staging instance). Both default to production — the same
// Supabase project the Proof webapp uses (its /device page and the
// mcp-device-* Edge Functions live there).
const DEFAULT_DEVICE_BASE_URL = 'https://proof.toremlabs.com';
export const DEFAULT_SUPABASE_URL = 'https://lgipbkejyrenexnkkyvr.supabase.co';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 15 * 60 * 1_000;

function log(...args: unknown[]): void {
  // Use stderr so we don't confuse MCP-client stdout parsers when this CLI
  // is misconfigured into the MCP slot. stderr is always safe.
  console.error(...args);
}

function printHelp(): void {
  log(
    [
      'proof-mcp — Proof MCP server (cloud-authenticated)',
      '',
      'Usage:',
      '  npx -y @toremlabs/proof-mcp               Start the MCP stdio server (run by Claude Desktop, Cursor, etc.)',
      '  npx -y @toremlabs/proof-mcp login         Link this machine to your Proof account',
      '    --device-name <name>                      Override the default device name (hostname-shortRand).',
      '  npx -y @toremlabs/proof-mcp logout        Remove the saved credentials',
      '  npx -y @toremlabs/proof-mcp whoami        Show the linked account',
      '  npx -y @toremlabs/proof-mcp --help        Show this message',
      '',
      'Credentials are stored at:',
      `  ${credentialsPath()}`,
      '',
      'Environment overrides (legacy HEURESIS_* names still work):',
      '  PROOF_DEVICE_BASE_URL   Webapp origin (default https://proof.toremlabs.com)',
      '  PROOF_SUPABASE_URL      Supabase project URL (default the Proof project)',
      '',
      'Snapshot mode (read-only, against a JSON export):',
      '  PROOF_SNAPSHOT=/path/to/export.json npx @toremlabs/proof-mcp',
    ].join('\n'),
  );
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input, output, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

interface LoginOptions {
  deviceName?: string;
}

/** Parse `npx @toremlabs/proof-mcp login [--device-name <name>]`. */
function parseLoginFlags(argv: string[]): LoginOptions {
  const opts: LoginOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--device-name' || flag === '--device') {
      const v = argv[i + 1];
      if (!v) {
        log(`Missing value for ${flag}`);
        process.exit(2);
      }
      opts.deviceName = v;
      i++;
    } else {
      log(`Unknown flag: ${flag}`);
      process.exit(2);
    }
  }
  return opts;
}

/** Sleep `ms` milliseconds. Resolves only — no rejection path. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface InitResponse {
  code: string;
  expires_at: string;
}

interface PollSuccess {
  status: 'ok';
  refresh_token: string;
  user_id: string;
  supabase_url: string;
  anon_key: string;
  device_name: string;
}

interface PollPending {
  status: 'pending';
  expires_at: string;
}

// POST JSON with bounded retry + a per-attempt timeout. The device-pairing
// endpoints sit behind the same Supabase edge as the auth token endpoint, so
// they hit the same intermittently-dropped-TLS-handshake problem (see
// gotrue.ts/postWithRetry): a lone fetch fails with "fetch failed" even though
// a retry moments later lands. We retry transient transport errors and 5xx/429
// here too; 4xx and the poll's own 202/410 signals are returned to the caller
// unchanged. Throws the last transport error only after every attempt fails.
async function postJson(
  url: string,
  body: unknown,
  { attempts = 4, perAttemptTimeoutMs = 8000 }: { attempts?: number; perAttemptTimeoutMs?: number } = {},
): Promise<{ status: number; data: unknown }> {
  await ensureProxyAgent(log);
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(perAttemptTimeoutMs) });
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        lastErr = new Error(`HTTP ${res.status}`); // transient — retry
      } else {
        let data: unknown = null;
        try {
          data = await res.json();
        } catch {
          /* leave null */
        }
        return { status: res.status, data };
      }
    } catch (err) {
      lastErr = err; // network drop / TLS reset / per-attempt timeout
    }
    if (attempt < attempts) {
      // Backoff: 250ms, 500ms, 1000ms, … capped at 2s.
      await sleep(Math.min(250 * 2 ** (attempt - 1), 2000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function loginCommand(argv: string[] = []): Promise<void> {
  const opts = parseLoginFlags(argv);
  const deviceName = opts.deviceName ?? defaultDeviceName();

  const deviceBaseUrl = envVar('DEVICE_BASE_URL') ?? DEFAULT_DEVICE_BASE_URL;
  const supabaseUrl = envVar('SUPABASE_URL') ?? DEFAULT_SUPABASE_URL;

  log('');
  log('Proof MCP — device link');
  log('─'.repeat(50));

  // 1. Init — allocate a pairing code.
  const initUrl = `${supabaseUrl}/functions/v1/mcp-device-init`;
  let initRes: { status: number; data: unknown };
  try {
    initRes = await postJson(initUrl, { device_name: deviceName });
  } catch (err) {
    log('');
    log(`Could not reach Proof at ${initUrl}.`);
    log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    log('If you are on a private / staging Supabase project, set PROOF_SUPABASE_URL.');
    process.exit(1);
  }
  if (initRes.status !== 200) {
    log('');
    log(`Failed to start the pairing flow (HTTP ${initRes.status}).`);
    const data = initRes.data as { error?: string; detail?: string } | null;
    if (data?.error) log(`  ${data.error}${data.detail ? ` — ${data.detail}` : ''}`);
    process.exit(1);
  }
  const init = initRes.data as InitResponse;
  if (!init?.code) {
    log('Pairing init returned no code. Aborting.');
    process.exit(1);
  }

  // 2. Tell the user where to go. The URL has the code baked in as a query
  // param so the device page can pre-fill it; the user just clicks Confirm.
  const confirmUrl = `${deviceBaseUrl}/device?code=${encodeURIComponent(init.code)}`;
  log('');
  log(`Open this URL to link this machine to your Proof account:`);
  log('');
  log(`  ${confirmUrl}`);
  log('');
  log(`(Code: ${init.code}, in case the page needs it manually. Expires in 15 min.)`);
  log('');
  log(`Waiting for confirmation…`);

  // 3. Poll until ok / 410 / timeout.
  const pollUrl = `${supabaseUrl}/functions/v1/mcp-device-poll`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let success: PollSuccess | null = null;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let pollRes: { status: number; data: unknown };
    try {
      pollRes = await postJson(pollUrl, { code: init.code });
    } catch (err) {
      // Transient network errors don't kill the loop — log once and keep polling.
      log(`  (network blip: ${err instanceof Error ? err.message : String(err)}; retrying)`);
      continue;
    }
    if (pollRes.status === 410) {
      log('');
      log('That code expired or was already used. Run `npx -y @toremlabs/proof-mcp login` again to start over.');
      process.exit(1);
    }
    if (pollRes.status === 202) {
      // Still pending — wait for the next tick.
      continue;
    }
    if (pollRes.status === 200) {
      const data = pollRes.data as PollSuccess | PollPending;
      if (data && (data as PollSuccess).status === 'ok') {
        success = data as PollSuccess;
        break;
      }
      // Unexpected 200 shape — keep trying until timeout rather than fail
      // catastrophically; the next poll will likely clarify.
      continue;
    }
    // Anything else: log and keep polling. The function may transiently 5xx.
    log(`  (poll returned HTTP ${pollRes.status}; retrying)`);
  }

  if (!success) {
    log('');
    log('Timed out waiting for confirmation. Run `npx -y @toremlabs/proof-mcp login` again.');
    process.exit(1);
  }

  // 4. Verify the refresh token works + fetch the user's email to print.
  // We exchange the refresh token straight against the GoTrue token endpoint
  // rather than going through supabase-js's stored-session machinery (which
  // throws "Auth session missing!" headlessly — see gotrue.ts for why).
  let email = '(no email on record)';
  try {
    const session = await exchangeRefreshToken(
      success.supabase_url,
      success.anon_key,
      success.refresh_token,
    );
    email = session.user?.email ?? email;
    // GoTrue rotates the refresh token on every exchange — persist the NEW
    // one so the credentials we write are immediately usable. The token we
    // got from the poll is now spent.
    success.refresh_token = session.refresh_token;
  } catch (err) {
    log('');
    if (err instanceof RefreshTokenError) {
      log(`Pairing returned a token, but it failed to refresh: ${err.message}`);
    } else {
      log(`Verification of the new refresh token failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    log('Run `npx -y @toremlabs/proof-mcp login` again to retry.');
    process.exit(1);
  }

  const creds: HeuresisCredentials = {
    supabase_url: success.supabase_url,
    anon_key: success.anon_key,
    refresh_token: success.refresh_token,
    user_id: success.user_id,
    device_name: success.device_name || deviceName,
    created_at: new Date().toISOString(),
  };
  const path = await writeCredentials(creds);

  log('');
  log(`Linked to ${email} as device "${creds.device_name}".`);
  log(`Credentials saved to ${path} (chmod 600 on POSIX).`);
  log('You can now point Claude Desktop / Claude Code at @toremlabs/proof-mcp.');
  log('');
}

export async function logoutCommand(): Promise<void> {
  const removed = await deleteCredentials();
  if (removed) {
    log('Proof credentials removed.');
  } else {
    log('No Proof credentials were found.');
  }
}

export async function whoamiCommand(): Promise<void> {
  const creds = await readCredentials();
  if (!creds) {
    log('Not linked. Run `npx -y @toremlabs/proof-mcp login` to pair this machine.');
    process.exit(1);
  }
  log(`Proof MCP — linked`);
  log(`  device:        ${creds.device_name}`);
  log(`  user_id:       ${creds.user_id}`);
  log(`  supabase_url:  ${creds.supabase_url}`);
  log(`  created_at:    ${creds.created_at}`);
  log(`  credentials:   ${credentialsPath()}`);
}

export function helpCommand(): void {
  printHelp();
}

// The unused `prompt` helper would only be used if we re-introduced any
// interactive form; export it so future subcommands can pick it up without
// re-implementing readline plumbing.
export { prompt };
