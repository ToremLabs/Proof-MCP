// In-memory Proof store backed by a JSON snapshot on disk.
//
// Re-reads the file at every tool call if its mtime has changed, so the
// agent always sees the latest export without needing a server restart.
// The file path is taken from $PROOF_SNAPSHOT (preferred; legacy HEURESIS_SNAPSHOT
// still works) or, when absent, `~/.proof/snapshot.json` (legacy ~/.heuresis).
//
// Why this shape:
//  • The web app stores everything in IndexedDB, which Node can't read.
//  • The app's existing Export workspace action writes a JSON file in
//    exactly this shape; the eventual Settings → MCP sync (next commit)
//    will write the same file automatically to a fixed path.
//  • This decouples the MCP server from the browser entirely. The MCP
//    server runs in the agent's process (Claude Desktop, Cursor, …) and
//    reads whatever the latest snapshot has — no IPC, no permission
//    dance, no auth.

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { envVar } from './env.js';
import type {
  Edge,
  Idea,
  Node,
  Project,
  Provenance,
  Snapshot,
  Workspace,
} from './types.js';

export interface StoreOpts {
  /** Override snapshot path. Falls back to env, then default. */
  path?: string;
}

export class HeuresisStore {
  private readonly path: string;
  private lastMtimeMs: number | null = null;
  private cache: Snapshot | null = null;

  constructor(opts: StoreOpts = {}) {
    // Explicit path wins; then PROOF_SNAPSHOT (legacy HEURESIS_SNAPSHOT); then
    // the default file — ~/.proof/snapshot.json, or the legacy
    // ~/.heuresis/snapshot.json when only that one is present.
    const legacyDefault = join(homedir(), '.heuresis', 'snapshot.json');
    const proofDefault = join(homedir(), '.proof', 'snapshot.json');
    const fileDefault =
      !existsSync(proofDefault) && existsSync(legacyDefault)
        ? legacyDefault
        : proofDefault;
    this.path = opts.path ?? envVar('SNAPSHOT') ?? fileDefault;
  }

  getSnapshotPath(): string {
    return this.path;
  }

  /**
   * Lazy-load and cache the snapshot. Re-reads from disk if the file's
   * mtime has advanced — the agent always sees the latest data without
   * us having to manage file watches.
   */
  async load(): Promise<Snapshot> {
    if (!existsSync(this.path)) {
      throw new Error(
        `Proof snapshot not found at ${this.path}. Export your workspace from Settings → Workspace → Export, then either set PROOF_SNAPSHOT to point at it, or place it at the default path.`,
      );
    }
    const s = await stat(this.path);
    if (this.cache && this.lastMtimeMs === s.mtimeMs) {
      return this.cache;
    }
    const text = await readFile(this.path, 'utf8');
    const data = JSON.parse(text) as Snapshot;
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
      throw new Error(
        `Snapshot at ${this.path} is missing required nodes/edges arrays. Re-export from Settings.`,
      );
    }
    this.cache = data;
    this.lastMtimeMs = s.mtimeMs;
    return data;
  }

  // ── Convenience accessors ────────────────────────────────────────────

  async workspaces(): Promise<Workspace[]> {
    return (await this.load()).workspaces;
  }

  async nodes(): Promise<Node[]> {
    return (await this.load()).nodes;
  }

  async edges(): Promise<Edge[]> {
    return (await this.load()).edges;
  }

  async projects(): Promise<Project[]> {
    return (await this.load()).projects;
  }

  async ideas(): Promise<Idea[]> {
    return (await this.load()).ideas;
  }

  async provenance(): Promise<Provenance[]> {
    return (await this.load()).provenance ?? [];
  }

  async nodeById(id: string): Promise<Node | undefined> {
    return (await this.nodes()).find((n) => n.id === id);
  }

  async projectById(id: string): Promise<Project | undefined> {
    return (await this.projects()).find((p) => p.id === id);
  }

  /**
   * Children of a node via partition edges + the canonical `parentId`
   * field. We accept both because the app sometimes records parent
   * relationships only on the node and sometimes only on the edge.
   */
  async childrenOf(id: string): Promise<Node[]> {
    const [nodes, edges] = await Promise.all([this.nodes(), this.edges()]);
    const ids = new Set<string>();
    for (const e of edges) {
      if (e.kind === 'partition' && e.fromId === id) ids.add(e.toId);
    }
    for (const n of nodes) {
      if (n.parentId === id) ids.add(n.id);
    }
    return nodes.filter((n) => ids.has(n.id));
  }

  /**
   * Walk descendants breadth-first up to `maxDepth`. Depth 0 = just the
   * node itself, depth 1 = node + direct children, etc.
   */
  async descendantsOf(id: string, maxDepth: number): Promise<Node[]> {
    const out: Node[] = [];
    const seen = new Set<string>();
    let frontier: string[] = [id];
    for (let d = 0; d <= maxDepth; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        if (seen.has(cur)) continue;
        seen.add(cur);
        const node = await this.nodeById(cur);
        if (!node) continue;
        out.push(node);
        if (d < maxDepth) {
          const kids = await this.childrenOf(cur);
          for (const k of kids) if (!seen.has(k.id)) next.push(k.id);
        }
      }
      frontier = next;
    }
    return out;
  }
}
