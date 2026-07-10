// Node < 22 ships no global `WebSocket`, but @supabase/realtime-js requires
// one: a Supabase client builds a RealtimeClient in its constructor (even when
// realtime is never used), which throws "Node.js 20 detected without native
// WebSocket support" when no global WebSocket exists. Install the `ws`
// implementation as the global so createClient works on Node 18/20. No-op on
// Node 22+, where WebSocket is native. Imported for its side effect by every
// module that builds a Supabase client, before the first createClient call.
import WebSocket from 'ws';

const g = globalThis as { WebSocket?: unknown };
if (typeof g.WebSocket === 'undefined') {
  g.WebSocket = WebSocket;
}
