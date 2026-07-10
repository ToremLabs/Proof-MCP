#!/usr/bin/env node
// @toremlabs/proof-mcp — Proof Model Context Protocol server.
//
// Two operating modes:
//
//   1. CLOUD (default) — when ~/.proof/credentials.json exists (or the legacy
//      ~/.heuresis one), every tool call hits Supabase against the user's
//      session. Same workspace the webapp sees, same RLS, live reads + writes.
//
//   2. SNAPSHOT (read-only) — when no credentials are present AND
//      $PROOF_SNAPSHOT is set, fall back to read-only file-snapshot behavior
//      against a JSON export.
//
// Subcommands (one-shot, never start the MCP server):
//   login | logout | whoami | --help

import { existsSync, readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from './zod-to-json-schema.js';
import { z } from 'zod';
import { envVar } from './env.js';
import { HeuresisStore } from './store.js';
import {
  getConcept as legacyGetConcept,
  getConceptInput as legacyGetConceptInput,
  getProjectGraph as legacyGetProjectGraph,
  getProjectGraphInput as legacyGetProjectGraphInput,
  getSubtree as legacyGetSubtree,
  getSubtreeInput as legacyGetSubtreeInput,
  getWorkspaceSummary as legacyGetWorkspaceSummary,
  getWorkspaceSummaryInput as legacyGetWorkspaceSummaryInput,
  listProjects as legacyListProjects,
  listProjectsInput as legacyListProjectsInput,
  listRecentDecisions as legacyListRecentDecisions,
  listRecentDecisionsInput as legacyListRecentDecisionsInput,
  searchConcepts as legacySearchConcepts,
  searchConceptsInput as legacySearchConceptsInput,
} from './tools.js';
import { CLOUD_TOOLS, type CloudToolDef } from './cloudTools.js';
import { readCredentials } from './credentials.js';
import {
  CloudAuthError,
  getCloudClient,
  getCloudClientFromPassword,
  setActiveDeviceId,
} from './cloudClient.js';
import {
  collectDeviceMetadata,
  stampDeviceMetadata,
} from './deviceMetadata.js';
import { autoOpenEnabled, surfacePendingHandoffs } from './autoOpen.js';
import { ensureProxyAgent } from './proxy.js';
import {
  DEFAULT_SUPABASE_URL,
  helpCommand,
  loginCommand,
  logoutCommand,
  whoamiCommand,
} from './cli.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  readRealtimeFlag,
  resolveSubscriptionWorkspaceId,
  startRealtimeSubscription,
  stripRealtimeFlags,
  type RealtimeChangeEvent,
} from './realtime.js';

// Report the real published version (dist/index.js → ../package.json) so
// `proof-mcp --version` and the startup banner never lie about what's loaded.
const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const MAX_RESULT_CHARS = 50_000;

// Fields worth preserving when a node/edge-bearing result is degraded to fit
// the size cap (everything else — descriptions, rationale, tags — is dropped).
const SKELETON_KEYS = [
  'id',
  'label',
  'name',
  'parentId',
  'parent_id',
  'kind',
  'from',
  'to',
  'status',
  'standing',
  'starred',
  'projectId',
  'rootNodeId',
];

function skeletonize(item: unknown): unknown {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const o = item as Record<string, unknown>;
    const keep: Record<string, unknown> = {};
    for (const k of SKELETON_KEYS) if (k in o) keep[k] = o[k];
    return Object.keys(keep).length > 0 ? keep : item;
  }
  return item;
}

// Never hard-fail a read on size. If a result blows the cap, first drop verbose
// fields from its array elements (keep id/label/parent/kind…), then, if still
// too big, slice the largest array — always tagging `_truncated` + `_note` so
// the agent knows to narrow (limit/depth/scope) or fetch detail via get_concept.
function fitResultToCap(result: unknown, cap: number): unknown {
  if (JSON.stringify(result, null, 2).length <= cap) return result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    const s = JSON.stringify(result, null, 2);
    return {
      _truncated: true,
      _note: `Result exceeded ${cap} chars and could not be structurally reduced; showing a prefix. Narrow the query.`,
      preview: s.slice(0, Math.max(0, cap - 200)),
    };
  }
  const obj: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  const arrayKeys = Object.keys(obj).filter(
    (k) => Array.isArray(obj[k]) && (obj[k] as unknown[]).some((x) => x && typeof x === 'object'),
  );
  for (const k of arrayKeys) obj[k] = (obj[k] as unknown[]).map(skeletonize);
  obj._truncated = true;
  obj._note =
    'Result exceeded the size cap; verbose fields were dropped (id/label/parent/kind kept). Use get_concept(id) for full detail, or narrow with limit/depth/scope.';
  let guard = 0;
  while (JSON.stringify(obj, null, 2).length > cap && guard++ < 100) {
    let biggestKey: string | undefined;
    let biggestLen = 0;
    for (const k of arrayKeys) {
      const len = (obj[k] as unknown[]).length;
      if (len > biggestLen) {
        biggestLen = len;
        biggestKey = k;
      }
    }
    if (!biggestKey || biggestLen <= 1) break;
    const arr = obj[biggestKey] as unknown[];
    obj[biggestKey] = arr.slice(0, Math.max(1, Math.floor(arr.length * 0.8)));
    obj._note = `Result exceeded the size cap; showing a truncated, skeletonized view (some "${biggestKey}" omitted). Narrow with limit/depth/scope, or fetch specifics with get_concept.`;
  }
  return obj;
}

interface ToolDef<TInput> {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (args: TInput) => Promise<unknown>;
}

function makeCloudTools(
  getClient: () => Promise<import('@supabase/supabase-js').SupabaseClient>,
  operatorTools: CloudToolDef[],
): ToolDef<unknown>[] {
  // Lazy: defer the actual auth handshake until the first tool call so the
  // MCP server boots fast.
  //
  // We compose two sources: CLOUD_TOOLS (Phase 19.4 data-layer parity) and
  // operatorTools (Phase 19.5 LLM-backed operators). Both share the
  // `CloudToolDef` shape; the only thing this layer adds is the lazy
  // `getClient()` hop so the handlers in cloudTools.ts can stay client-
  // agnostic.
  const merged: CloudToolDef[] = [...CLOUD_TOOLS, ...operatorTools];
  return merged.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    handler: async (args: unknown) => t.handler(await getClient(), args),
  }));
}

// Phase 19.5 — try to load LLM-backed Operator tools. The module may be absent
// or export nothing; in that case we fall back to just the Phase 19.4 parity
// set. Wrapping the dynamic import in try/catch keeps the server starting
// cleanly either way.
async function loadOperatorTools(): Promise<CloudToolDef[]> {
  try {
    const mod = (await import('./cloudOperators.js').catch(() => null)) as
      | { OPERATOR_TOOLS?: CloudToolDef[] }
      | null;
    if (mod && Array.isArray(mod.OPERATOR_TOOLS)) return mod.OPERATOR_TOOLS;
  } catch {
    /* fall through to empty */
  }
  return [];
}

function makeLegacySnapshotTools(store: HeuresisStore): ToolDef<unknown>[] {
  // LEGACY FALLBACK — removed after 19.7. Read-only, no auth, snapshot file.
  return [
    {
      name: 'get_workspace_summary',
      description:
        "(Legacy snapshot mode) Counts of nodes/edges/projects/ideas + a one-line overview of each project and idea. Always start here when you don't know what's in the workspace.",
      inputSchema: legacyGetWorkspaceSummaryInput,
      handler: () => legacyGetWorkspaceSummary(store),
    },
    {
      name: 'list_projects',
      description:
        '(Legacy snapshot mode) Every project in the snapshot with brief, direction, lifecycle, and member count.',
      inputSchema: legacyListProjectsInput,
      handler: () => legacyListProjects(store),
    },
    {
      name: 'search_concepts',
      description:
        '(Legacy snapshot mode) Substring search across concept labels, descriptions, tags, and partition attributes.',
      inputSchema: legacySearchConceptsInput,
      handler: (args: unknown) => legacySearchConcepts(store, legacySearchConceptsInput.parse(args)),
    },
    {
      name: 'get_concept',
      description:
        '(Legacy snapshot mode) One concept by id, optionally with ancestry, children, and idea memberships.',
      inputSchema: legacyGetConceptInput,
      handler: (args: unknown) => legacyGetConcept(store, legacyGetConceptInput.parse(args)),
    },
    {
      name: 'get_subtree',
      description:
        '(Legacy snapshot mode) A node and its descendants up to a given depth.',
      inputSchema: legacyGetSubtreeInput,
      handler: (args: unknown) => legacyGetSubtree(store, legacyGetSubtreeInput.parse(args)),
    },
    {
      name: 'get_project_graph',
      description:
        '(Legacy snapshot mode) Every node + edge inside one project. Returns a graph the agent can reason over end-to-end.',
      inputSchema: legacyGetProjectGraphInput,
      handler: (args: unknown) =>
        legacyGetProjectGraph(store, legacyGetProjectGraphInput.parse(args)),
    },
    {
      name: 'list_recent_decisions',
      description:
        '(Legacy snapshot mode) Nodes the user has explicitly resolved (validated, starred, or archived) recently.',
      inputSchema: legacyListRecentDecisionsInput,
      handler: (args: unknown) =>
        legacyListRecentDecisions(store, legacyListRecentDecisionsInput.parse(args)),
    },
  ];
}

async function runServer(): Promise<void> {
  // Route outbound fetch (GoTrue refresh + PostgREST queries) through
  // HTTPS_PROXY / HTTP_PROXY before any cloud call. No-op when unset.
  await ensureProxyAgent(console.error);

  const creds = await readCredentials();
  const snapshotEnv = envVar('SNAPSHOT');

  // Headless credential (durable across ephemeral/disposable sessions): when
  // PROOF_EMAIL + PROOF_PASSWORD are set, the server signs in fresh on
  // every boot. Unlike a persisted refresh token — which is single-use under
  // Supabase rotation and dies after one session — a password is not consumed,
  // so this survives container resets with zero re-pairing. It takes
  // precedence over a (possibly stale) credentials.json.
  const headlessEmail = envVar('EMAIL')?.trim();
  const headlessPassword = envVar('PASSWORD');

  let tools: ToolDef<unknown>[];
  let modeBanner: string;
  // Single cloud client getter, shared by the tool handlers and the realtime
  // subscription. null in legacy snapshot / unconfigured modes.
  let cloudGetClient: (() => Promise<SupabaseClient>) | null = null;

  if (headlessEmail && headlessPassword) {
    // CLOUD mode — headless email/password sign-in (recommended for cloud /
    // disposable containers).
    const supabaseUrl = envVar('SUPABASE_URL')?.trim() || DEFAULT_SUPABASE_URL;
    const anonKey = envVar('ANON_KEY')?.trim();
    if (!anonKey) {
      console.error(
        [
          '[proof-mcp] PROOF_EMAIL/PROOF_PASSWORD are set but PROOF_ANON_KEY is missing.',
          'Set PROOF_ANON_KEY to your project anon/publishable key (it is public, not a secret).',
        ].join('\n'),
      );
      process.exit(1);
    }
    let warnedFallback = false;
    cloudGetClient = async () => {
      try {
        const { client } = await getCloudClientFromPassword(
          supabaseUrl,
          anonKey,
          headlessEmail,
          headlessPassword,
        );
        return client;
      } catch (err) {
        // Headless env vars are often stale (rotated password, a key from an
        // old project). When this machine ALSO carries a paired device
        // credential, fall back to it instead of hard-failing every tool call.
        if (creds) {
          if (!warnedFallback) {
            warnedFallback = true;
            console.error(
              '[proof-mcp] Headless email/password sign-in failed ' +
                `(${err instanceof Error ? err.message : String(err)}); ` +
                'falling back to the paired device credential in ~/.proof.',
            );
          }
          try {
            const { client } = await getCloudClient(creds);
            return client;
          } catch (fallbackErr) {
            if (fallbackErr instanceof CloudAuthError) throw new Error(fallbackErr.message);
            throw fallbackErr;
          }
        }
        if (err instanceof CloudAuthError) throw new Error(err.message);
        throw err;
      }
    };
    tools = makeCloudTools(cloudGetClient, await loadOperatorTools());
    modeBanner = `cloud-authenticated (headless ${headlessEmail}; ${tools.length} tools)`;
  } else if (creds) {
    // CLOUD mode — persisted device credential (refresh-token bootstrap).
    cloudGetClient = async () => {
      try {
        const { client } = await getCloudClient(creds);
        return client;
      } catch (err) {
        if (err instanceof CloudAuthError) throw new Error(err.message);
        throw err;
      }
    };
    tools = makeCloudTools(cloudGetClient, await loadOperatorTools());
    modeBanner = `cloud-authenticated (user_id ${creds.user_id}, device ${creds.device_name}; ${tools.length} tools)`;
  } else if (snapshotEnv || hasDefaultSnapshot()) {
    // LEGACY snapshot fallback.
    const store = new HeuresisStore();
    tools = makeLegacySnapshotTools(store);
    modeBanner = `snapshot mode (path: ${store.getSnapshotPath()})`;
  } else {
    // Neither — print actionable error and exit.
    console.error(
      [
        '[proof-mcp] Not configured.',
        '',
        'To use cloud mode on a personal machine (device pairing):',
        '  npx -y @toremlabs/proof-mcp login',
        '',
        'To use cloud mode headlessly (CI / cloud agents / disposable containers),',
        'set these env vars so the server signs in fresh on every boot:',
        '  PROOF_EMAIL      your Proof account email',
        '  PROOF_PASSWORD   your Proof account password',
        '  PROOF_ANON_KEY   your project anon/publishable key (public, not a secret)',
        '',
        'To use snapshot mode (read-only, against a JSON export):',
        '  PROOF_SNAPSHOT=/path/to/export.json npx @toremlabs/proof-mcp',
        '',
        'See https://proof.toremlabs.com/mcp for setup details.',
      ].join('\n'),
    );
    process.exit(1);
  }

  // `resources` + `logging` are declared so the Realtime path (Phase 19.8) can
  // call `server.sendResourceListChanged()` / `sendLoggingMessage()` without
  // tripping the SDK's capability assertions. We don't expose any actual
  // resource handlers, but the notification surface is what the realtime
  // subscriber needs to ping the client when the workspace changes.
  const server = new Server(
    { name: '@toremlabs/proof-mcp', version: VERSION },
    { capabilities: { tools: {}, resources: { listChanged: true }, logging: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [
          { type: 'text' as const, text: `Unknown tool: ${req.params.name}` },
        ],
      };
    }

    // Heartbeat — emit progress notifications so MCP clients that honor them
    // keep resetting their request timeout. Operator/LLM runs routinely exceed
    // the 60s default, where the response would time out even though the work
    // already committed (which also drove duplicate retries). No-op when the
    // client supplied no progressToken.
    const progressToken = (
      req.params._meta as { progressToken?: string | number } | undefined
    )?.progressToken;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    if (progressToken !== undefined) {
      let ticks = 0;
      heartbeat = setInterval(() => {
        ticks += 1;
        try {
          void extra
            .sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: ticks,
                message: `still working… (~${ticks * 15}s)`,
              },
            })
            .catch(() => {});
        } catch {
          /* a heartbeat failure must never break the call */
        }
      }, 15_000);
    }

    try {
      // Operator tools are async now: they return a runId fast and run in the
      // background with their own concurrency control (cloudOperators.ts), so no
      // per-call serialization is needed here.
      const result = await tool.handler(req.params.arguments ?? {});
      // Never hard-fail on size: auto-degrade node/edge-bearing results
      // (skeletonize → slice) so the agent always gets actionable structure
      // back instead of an error it has to recover from.
      const text = JSON.stringify(fitResultToCap(result, MAX_RESULT_CHARS), null, 2);
      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
      };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[proof-mcp ${VERSION}] ready - ${modeBanner}`);

  // Goal #1 — device install metadata + pending-handoff surfacing. Cloud mode
  // only, and only when this install was paired as a device (refresh-token
  // credential): we stamp WHERE this MCP is installed (host app / OS / repo) so
  // Proof can route handoffs here, resolve our own device id (for claim_handoff
  // routing), and surface any pending handoffs to the host's logs. Best-effort
  // and fire-and-forget so it never blocks or breaks boot.
  if (cloudGetClient && creds) {
    const deviceCreds = creds; // narrow for the async closure
    void (async () => {
      try {
        const client = await cloudGetClient!();
        const meta = collectDeviceMetadata({
          deviceName: deviceCreds.device_name,
          mcpVersion: VERSION,
        });
        const deviceId = await stampDeviceMetadata(
          client,
          deviceCreds.user_id,
          deviceCreds.device_name,
          meta,
        );
        setActiveDeviceId(deviceId);
        console.error(
          `[proof-mcp] device: ${meta.label} (${meta.hostLabel}, ${meta.os}; cwd ${meta.cwd})` +
            (deviceId ? '' : ' — no device row to stamp (metadata skipped)'),
        );
        await surfacePendingHandoffs(client, { autoOpen: autoOpenEnabled() });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[proof-mcp] device/handoff init failed: ${msg}`);
      }
    })();
  }

  // Phase 19.8 - Supabase Realtime CDC subscription. Cloud mode only; legacy
  // snapshot mode has no live source to subscribe to.
  if (cloudGetClient) {
    const realtimeOn = await readRealtimeFlag();
    if (!realtimeOn) {
      console.error('[proof-mcp] realtime: disabled (--no-realtime or config).');
    } else {
      // Don't block boot on the realtime handshake; fire-and-forget. If the
      // client (Supabase) is not reachable, the error surfaces on stderr.
      void (async () => {
        try {
          const client = await cloudGetClient();
          const wsId = await resolveSubscriptionWorkspaceId(client);
          if (!wsId) {
            console.error('[proof-mcp] realtime: no workspace visible; skipping subscription.');
            return;
          }
          startRealtimeSubscription(client, wsId, (event: RealtimeChangeEvent) => {
            if (event.eventType === 'RESYNC') {
              console.error('[proof-mcp] workspace resync: refetch any cached state.');
            } else if (event.table) {
              console.error(
                `[proof-mcp] workspace updated: ${event.table} ${event.eventType}`,
              );
            }
            // Best-effort MCP notification. Most clients will treat this as a
            // hint to refresh. We swallow errors because not every client
            // honors the resources capability.
            void server.sendResourceListChanged().catch(() => {
              /* client does not implement resource updates; stderr log is enough */
            });
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[proof-mcp] realtime: subscription failed: ${msg}`);
        }
      })();
    }
  }
}

function hasDefaultSnapshot(): boolean {
  try {
    const s = new HeuresisStore();
    // Only count the default path if it actually exists on disk; we never
    // want the default-path branch to trigger a "snapshot not found" error
    // when the user simply hasn't logged in yet.
    return existsSync(s.getSnapshotPath());
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // The Realtime flags (`--no-realtime` / `--realtime`) are consumed by the
  // realtime module via process.argv directly; strip them here so they don't
  // collide with subcommand dispatch when a user runs e.g.
  // `npx @toremlabs/proof-mcp --no-realtime`.
  const stripped = stripRealtimeFlags(process.argv.slice(2));
  const sub = stripped[0];
  switch (sub) {
    case undefined:
      await runServer();
      return;
    case 'login':
      await loginCommand(stripped.slice(1));
      return;
    case 'logout':
      await logoutCommand();
      return;
    case 'whoami':
      await whoamiCommand();
      return;
    case '-v':
    case '--version':
    case 'version':
      console.log(VERSION);
      return;
    case '-h':
    case '--help':
    case 'help':
      helpCommand();
      return;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      helpCommand();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error('[proof-mcp] fatal:', err);
  process.exit(1);
});
