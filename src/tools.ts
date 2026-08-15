// Read-only tools exposed by the proof-mcp snapshot server.
//
// All tools are designed to be cheap, deterministic, and side-effect free.
// Agent-write tools (append_concept, set_parent, …) are intentionally
// deferred — they need a provenance + write-back path through the running
// app, which is real Phase 12 work.

import { z } from 'zod';
import type { HeuresisStore } from './store.js';
import type { Node } from './types.js';

const MAX_RESULTS = 50;

// Bulk tool results are folded into the agent's next API request. Oversized
// payloads get reset in transit by strict corporate proxies (ECONNRESET), so
// bulk tools default to a compact view and the agent opts into full text per
// node via get_concept.
const detailArg = z
  .enum(['compact', 'full'])
  .default('compact')
  .describe(
    "'compact' drops description/rationale to keep the payload small; 'full' includes them.",
  );

/** A flat, agent-friendly view of a Node (drops position/embedding). */
function nodeView(n: Node, detail: 'compact' | 'full' = 'full') {
  const base = {
    id: n.id,
    label: n.label,
    status: n.status,
    starred: n.starred,
    parentId: n.parentId,
    operator: n.operator?.family,
    partitionAttribute: n.partitionAttribute,
    tags: n.tags,
    updatedAt: new Date(n.updatedAt).toISOString(),
  };
  if (detail === 'compact') return base;
  return { ...base, description: n.description, rationale: n.rationale };
}

// ── get_workspace_summary ───────────────────────────────────────────────────

export const getWorkspaceSummaryInput = z.object({}).strict();

export async function getWorkspaceSummary(store: HeuresisStore) {
  const [workspaces, nodes, edges, projects, ideas] = await Promise.all([
    store.workspaces(),
    store.nodes(),
    store.edges(),
    store.projects(),
    store.ideas(),
  ]);
  return {
    snapshotPath: store.getSnapshotPath(),
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })),
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      projects: projects.length,
      ideas: ideas.length,
    },
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      brief: p.brief,
      direction: p.direction,
      lifecycle: p.lifecycle,
      nodeCount: p.nodeIds.length,
      rootNodeId: p.rootNodeId,
    })),
    ideas: ideas.map((i) => ({
      id: i.id,
      name: i.name,
      nodeCount: i.nodeIds.length,
      color: i.color,
    })),
  };
}

// ── search_concepts ─────────────────────────────────────────────────────────

export const searchConceptsInput = z
  .object({
    query: z.string().describe('Substring matched against label, description, tags, partitionAttribute.'),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(20),
    projectId: z.string().optional().describe('Restrict results to nodes belonging to this project.'),
    status: z.enum(['open', 'validated', 'archived']).optional(),
    detail: detailArg,
  })
  .strict();

export async function searchConcepts(
  store: HeuresisStore,
  args: z.infer<typeof searchConceptsInput>,
) {
  const q = args.query.toLowerCase().trim();
  const allNodes = await store.nodes();
  const project = args.projectId ? await store.projectById(args.projectId) : null;
  const allowed =
    project ? new Set(project.nodeIds) : null;
  const hits = allNodes
    .filter((n) => {
      if (allowed && !allowed.has(n.id)) return false;
      if (args.status && n.status !== args.status) return false;
      if (!q) return true;
      const hay = [
        n.label,
        n.description,
        n.partitionAttribute ?? '',
        n.rationale ?? '',
        (n.tags ?? []).join(' '),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, args.limit)
    .map((n) => nodeView(n, args.detail));
  return { query: q, total: hits.length, detail: args.detail, results: hits };
}

// ── get_concept ─────────────────────────────────────────────────────────────

export const getConceptInput = z
  .object({
    id: z.string(),
    includeAncestry: z.boolean().default(true),
    includeChildren: z.boolean().default(true),
    includeIdeaMemberships: z.boolean().default(true),
  })
  .strict();

export async function getConcept(
  store: HeuresisStore,
  args: z.infer<typeof getConceptInput>,
) {
  const node = await store.nodeById(args.id);
  if (!node) return { error: `No concept with id ${args.id}` };
  const out: Record<string, unknown> = { node: nodeView(node) };
  if (args.includeAncestry) {
    const chain: { id: string; label: string }[] = [];
    const seen = new Set<string>();
    let cur: string | null = node.parentId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const p = await store.nodeById(cur);
      if (!p) break;
      chain.unshift({ id: p.id, label: p.label });
      cur = p.parentId;
    }
    out.ancestry = chain;
  }
  if (args.includeChildren) {
    const kids = await store.childrenOf(node.id);
    out.children = kids.map((k) => ({ id: k.id, label: k.label, status: k.status }));
  }
  if (args.includeIdeaMemberships) {
    const ideas = await store.ideas();
    out.ideaMemberships = ideas
      .filter((i) => i.nodeIds.includes(node.id))
      .map((i) => ({ id: i.id, name: i.name, color: i.color }));
  }
  return out;
}

// ── get_subtree ─────────────────────────────────────────────────────────────

export const getSubtreeInput = z
  .object({
    rootId: z.string(),
    depth: z.number().int().min(0).max(6).default(3).describe('How many generations below the root to include.'),
    detail: detailArg,
  })
  .strict();

export async function getSubtree(
  store: HeuresisStore,
  args: z.infer<typeof getSubtreeInput>,
) {
  const root = await store.nodeById(args.rootId);
  if (!root) return { error: `No concept with id ${args.rootId}` };
  const nodes = await store.descendantsOf(args.rootId, args.depth);
  return {
    rootId: args.rootId,
    depth: args.depth,
    detail: args.detail,
    nodeCount: nodes.length,
    nodes: nodes.map((n) => nodeView(n, args.detail)),
  };
}

// ── list_projects ───────────────────────────────────────────────────────────

export const listProjectsInput = z.object({}).strict();

export async function listProjects(store: HeuresisStore) {
  const projects = await store.projects();
  return {
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      brief: p.brief,
      direction: p.direction,
      lifecycle: p.lifecycle,
      nodeCount: p.nodeIds.length,
      rootNodeId: p.rootNodeId,
    })),
  };
}

// ── get_project_graph ───────────────────────────────────────────────────────

export const getProjectGraphInput = z
  .object({
    projectId: z.string(),
    includeArchived: z.boolean().default(false),
    detail: detailArg,
  })
  .strict();

export async function getProjectGraph(
  store: HeuresisStore,
  args: z.infer<typeof getProjectGraphInput>,
) {
  const project = await store.projectById(args.projectId);
  if (!project) return { error: `No project with id ${args.projectId}` };
  const memberIds = new Set(project.nodeIds);
  const [allNodes, allEdges] = await Promise.all([store.nodes(), store.edges()]);
  const nodes = allNodes
    .filter((n) => memberIds.has(n.id))
    .filter((n) => (args.includeArchived ? true : n.status !== 'archived'));
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const edges = allEdges
    .filter((e) => nodeIdSet.has(e.fromId) && nodeIdSet.has(e.toId))
    .map((e) => ({ from: e.fromId, to: e.toId, kind: e.kind }));
  return {
    project: {
      id: project.id,
      name: project.name,
      brief: project.brief,
      direction: project.direction,
      lifecycle: project.lifecycle,
      rootNodeId: project.rootNodeId,
    },
    detail: args.detail,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes: nodes.map((n) => nodeView(n, args.detail)),
    edges,
  };
}

// ── list_recent_decisions ───────────────────────────────────────────────────

export const listRecentDecisionsInput = z
  .object({
    sinceMs: z
      .number()
      .int()
      .optional()
      .describe('Unix-ms cutoff; default = last 7 days.'),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(20),
  })
  .strict();

export async function listRecentDecisions(
  store: HeuresisStore,
  args: z.infer<typeof listRecentDecisionsInput>,
) {
  const cutoff =
    args.sinceMs ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
  const allNodes = await store.nodes();
  // "Decisions" = validated, starred, or just-archived nodes — the ones
  // the user has explicitly resolved one way or the other.
  const decisions = allNodes
    .filter(
      (n) =>
        n.updatedAt >= cutoff &&
        (n.starred || n.status === 'validated' || n.status === 'archived'),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, args.limit)
    .map((n) => ({
      id: n.id,
      label: n.label,
      status: n.status,
      starred: n.starred,
      updatedAt: new Date(n.updatedAt).toISOString(),
      decision:
        n.status === 'validated'
          ? 'validated'
          : n.status === 'archived'
            ? 'archived'
            : n.starred
              ? 'starred'
              : 'open',
    }));
  return {
    sinceMs: cutoff,
    since: new Date(cutoff).toISOString(),
    count: decisions.length,
    decisions,
  };
}
