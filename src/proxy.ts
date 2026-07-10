// Proof MCP — global fetch dispatcher wiring (proxy + IPv4 preference).
//
// Node 18-22's undici does NOT auto-honor HTTPS_PROXY / HTTP_PROXY (Node 24+
// does). Without this, every outbound fetch fails with "fetch failed" on
// networks that require an egress proxy — both the device-pairing + GoTrue
// refresh calls in the CLI and the SupabaseClient's PostgREST queries in the
// running MCP server. We install an undici ProxyAgent as the global dispatcher
// once, at process start.
//
// When NO proxy is set we STILL install a custom global dispatcher: an Agent
// that resolves hostnames IPv4-only. On networks with a dead / black-holed
// IPv6 DNS resolver (e.g. a stale ISP IPv6 nameserver handed out over DHCPv6),
// a default dual-stack getaddrinfo issues BOTH an A and a AAAA query and waits
// for both — the AAAA query stalls ~4-8s or times out against the dead resolver
// before the (instant) A answer can be used, so every fetch intermittently
// hangs even though IPv4 connectivity is perfectly fine. Forcing family:4 skips
// the AAAA query entirely. This is safe for this client: every endpoint it
// talks to (Supabase behind Cloudflare) is IPv4-reachable — in fact the
// Supabase host publishes no AAAA record at all.
//
// Idempotent across the whole process (module-level flag) and safe to call from
// every entry point.
//
// NOTE: this only covers `fetch` (PostgREST + auth). The Realtime websocket
// uses a separate transport that the global dispatcher does not touch.

import { lookup } from 'node:dns';

let dispatcherInstalled = false;

/**
 * Install the process-wide undici dispatcher for Node's global `fetch`:
 * a ProxyAgent when HTTPS_PROXY/HTTP_PROXY is set, otherwise an IPv4-preferring
 * Agent (see header for why). Pass a logger to surface the routing decision
 * (the CLI logs to stderr; the server passes console.error). Idempotent.
 */
export async function ensureProxyAgent(
  log: (...args: unknown[]) => void = () => {},
): Promise<void> {
  if (dispatcherInstalled) return;
  dispatcherInstalled = true;
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  try {
    // undici is a direct dependency, so this resolves. Dynamic import keeps it
    // off the cold-start path until we actually configure the dispatcher.
    const { Agent, ProxyAgent, setGlobalDispatcher } = await import('undici');
    if (proxyUrl) {
      // Behind a proxy the target's DNS is resolved by the proxy, so the IPv6
      // stall does not apply locally — just route through the proxy.
      setGlobalDispatcher(new ProxyAgent(proxyUrl));
      log(`(routing through proxy ${proxyUrl})`);
    } else {
      // No proxy: pin IPv4 to dodge two distinct flaky-network failure modes
      // that both manifest as intermittent ~4-8s stalls to the Supabase host:
      //   1. A dead/stalling IPv6 DNS resolver — a default dual-stack lookup
      //      issues a AAAA query that hangs before the instant A answer is used.
      //   2. Node/undici's Happy-Eyeballs (autoSelectFamily) racing the
      //      connection, which on some networks wedges the handshake ~50% of
      //      the time to this host even when each IP is individually healthy
      //      (verified: both Cloudflare IPs 6/6 when pinned, but 3/6 with the
      //      race on). Disabling it + forcing family:4 is reliably 8/8.
      setGlobalDispatcher(
        new Agent({
          connect: {
            autoSelectFamily: false,
            // Pin the address family to IPv4 (also skips the AAAA query) while
            // preserving undici's other lookup options (e.g. `all`). The cast
            // sidesteps dns.lookup's overload union — we faithfully forward
            // undici's own callback, whatever result shape it expects.
            lookup: (hostname: string, options: unknown, callback: unknown) =>
              (lookup as (h: string, o: object, cb: unknown) => void)(
                hostname,
                { ...(options as object), family: 4 },
                callback,
              ),
          },
        }),
      );
    }
  } catch (err) {
    log(`(could not configure fetch dispatcher: ${err instanceof Error ? err.message : String(err)})`);
  }
}
