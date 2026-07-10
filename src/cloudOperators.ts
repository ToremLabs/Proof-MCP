// Proof MCP — operator-running tools (Phase 19.5).
//
// Turns the MCP from a "data layer" into a "thinking partner": the user / a
// host agent can fire a Branch / Matrix / ASIT / TRIZ / Free / Combine /
// Contradiction operator directly from the MCP, against the same cloud
// workspace the webapp sees. The MCP loads the user's BYO key via the
// `get_my_provider_key` SECURITY DEFINER RPC, calls the provider directly,
// parses the JSON envelope through the same schema the webapp uses, and
// returns structured candidates.
//
// Two surfaces:
//
//   * run_operator(family, key, anchor_id, args?)  — generates candidates
//     and (by default) does NOT commit. The caller decides whether to use
//     `bulk_add_concepts` (Agent B's tool) to commit, or to call the sibling
//     `run_operator_and_commit` to do it in one tool round-trip.
//
//   * expand_concept(id, depth, breadth, angle?)  — recursive Branch. Walks
//     breadth-first and commits each level immediately so the user sees
//     partial results in the webapp as the run progresses (rather than
//     waiting 30s for a full tree). Hard-capped at depth * breadth ≤ 60 per
//     PLAN.md Phase 10.3 safety guardrail.
//
// Provenance — every committed concept gets a row in `public.provenance`
// stamped origin='mcp', operator='<family>:<key>', sourceRefs=[anchor_id].
// The migration that lands the table is 0015 (Agent B's half).
//
// Cost preview — every run_operator response carries an `estimated_cost:
// { credits, dollars }` chip from the rate card in `docs/credits.md` §2.
// Informational only; BYO-key runs don't bill against managed credits.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { unwrap } from './cloudClient.js';
import type { CloudToolDef } from './cloudTools.js';
import type { EdgeKind, NodeRow, ProjectRow } from './cloudTypes.js';
import type { OperatorDefinition, OperatorFamily } from './operators/types.js';
import { ASIT_OPERATORS } from './operators/asit.js';
import { TRIZ_OPERATORS } from './operators/triz.js';
import { CONTRADICTION_OPERATOR } from './operators/contradiction.js';
import { COMBINE_OPERATOR } from './operators/combine.js';
import { EXPLORE_OPERATOR } from './operators/explore.js';
import {
  TRIZ_PARAMETERS,
  TRIZ_PRINCIPLES,
  lookupPrinciples,
} from './operators/triz-matrix.js';
import { composePrompt } from './prompt/compose.js';
import { composeOperatorSystemPrefix } from './llm/operatorFraming.js';
import { parseLlmResponse } from './prompt/parse.js';
import type {
  ParsedNewKnowledge,
  ParsedPartition,
  ParsedPartitionLeaf,
} from './prompt/schema.js';
import {
  defaultModelFor,
  runLlm,
  type LlmConfig,
  type LlmProvider,
} from './llm/client.js';
import { estimateCost } from './llm/cost.js';

// ---------------------------------------------------------------------------
// FREEFORM operator — referenced by run_operator(family='free') and reused
// internally by expand_concept. Defined inline rather than in
// `operators/free.ts` because it's a single value and the webapp lives it in
// `operators/catalog.ts`; folding it here keeps the operator file count low.
// ---------------------------------------------------------------------------

const FREEFORM_OPERATOR: OperatorDefinition = {
  family: 'FREEFORM',
  key: 'freeform',
  name: 'Free expansion',
  glyph: '✎',
  oneLiner: 'Expand the concept along a user-supplied angle.',
  doctrine:
    'No fixed heuristic. The user supplies an angle or question and the LLM proposes partitions consistent with that angle.',
  promptFragment:
    'Apply the FREEFORM operator: propose 3–5 partitions that expand the current concept along the angle stated by the user (see <angle> tag below).',
};

const ALL_OPERATORS: OperatorDefinition[] = [
  ...ASIT_OPERATORS,
  ...TRIZ_OPERATORS,
  CONTRADICTION_OPERATOR,
  FREEFORM_OPERATOR,
  COMBINE_OPERATOR,
  EXPLORE_OPERATOR,
];

// ---------------------------------------------------------------------------
// Family-key resolution
// ---------------------------------------------------------------------------
// `run_operator` accepts `family` as a low-case string ('asit' | 'triz' |
// 'contradiction' | 'free' | 'combine') for caller convenience; the webapp
// uses UPPER (OperatorDefinition.family). Normalize once.

const FAMILY_ALIASES: Record<string, OperatorFamily> = {
  asit: 'ASIT',
  triz: 'TRIZ',
  contradiction: 'CONTRADICTION',
  free: 'FREEFORM',
  freeform: 'FREEFORM',
  combine: 'COMBINE',
  explore: 'EXPLORE',
  branch: 'EXPLORE',
};

function normalizeFamily(raw: string): OperatorFamily | null {
  const lower = raw.toLowerCase();
  return FAMILY_ALIASES[lower] ?? null;
}

function resolveOperator(
  family: OperatorFamily,
  key: string,
): OperatorDefinition | null {
  // EXPLORE / FREEFORM / COMBINE / CONTRADICTION ignore `key` — there's
  // exactly one operator per family. Default to that.
  if (family === 'EXPLORE') return EXPLORE_OPERATOR;
  if (family === 'FREEFORM') return FREEFORM_OPERATOR;
  if (family === 'COMBINE') return COMBINE_OPERATOR;
  if (family === 'CONTRADICTION') return CONTRADICTION_OPERATOR;
  // ASIT + TRIZ need a key. Match exactly.
  return (
    ALL_OPERATORS.find((o) => o.family === family && o.key === key) ?? null
  );
}

// ---------------------------------------------------------------------------
// Anchor + project + ancestry loaders
// ---------------------------------------------------------------------------

async function loadAnchor(
  client: SupabaseClient,
  id: string,
): Promise<NodeRow> {
  const res = await client.from('nodes').select('*').eq('id', id).maybeSingle();
  if (res.error) throw new Error(res.error.message);
  if (!res.data) throw new Error(`No concept with id ${id}`);
  return res.data as NodeRow;
}

async function loadProjectForNode(
  client: SupabaseClient,
  node: NodeRow,
): Promise<ProjectRow> {
  // Prefer the denormalized project_id on the node; fall back to a join
  // through project_nodes (legacy rows pre-migration 0012 lacked the column).
  let projectId = node.project_id;
  if (!projectId) {
    const rows = unwrap(
      await client
        .from('project_nodes')
        .select('project_id')
        .eq('node_id', node.id)
        .limit(1),
    ) as { project_id: string }[];
    projectId = rows[0]?.project_id ?? null;
  }
  if (!projectId) {
    throw new Error(
      `Concept ${node.id} is not in any project — operators need a project context to compose prompts.`,
    );
  }
  const proj = unwrap(
    await client.from('projects').select('*').eq('id', projectId).single(),
  ) as ProjectRow;
  return proj;
}

async function loadAncestry(
  client: SupabaseClient,
  node: NodeRow,
): Promise<NodeRow[]> {
  // Walk parent_id up to the root. Cheap because depth is small.
  const chain: NodeRow[] = [node];
  const seen = new Set<string>([node.id]);
  let cur: string | null = node.parent_id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const res = await client.from('nodes').select('*').eq('id', cur).maybeSingle();
    if (res.error) break;
    const p = res.data as NodeRow | null;
    if (!p) break;
    chain.unshift(p);
    cur = p.parent_id;
  }
  return chain;
}

async function loadKnowledgePool(
  client: SupabaseClient,
  project: ProjectRow,
): Promise<NodeRow[]> {
  const memberRows = unwrap(
    await client
      .from('project_nodes')
      .select('node_id')
      .eq('project_id', project.id),
  ) as { node_id: string }[];
  const memberIds = memberRows.map((r) => r.node_id);
  if (memberIds.length === 0) return [];
  const rows = unwrap(
    await client
      .from('nodes')
      .select('*')
      .in('id', memberIds)
      .eq('status', 'validated'),
  ) as NodeRow[];
  // Cap at 20 to keep prompt bloat bounded; same heuristic the webapp uses.
  return rows.slice(0, 20);
}

async function loadDirectChildren(
  client: SupabaseClient,
  node: NodeRow,
): Promise<NodeRow[]> {
  const rows = unwrap(
    await client
      .from('nodes')
      .select('*')
      .eq('parent_id', node.id)
      .neq('status', 'archived'),
  ) as NodeRow[];
  return rows;
}

// ---------------------------------------------------------------------------
// LLM config resolution — reads localStorage-style provider/model selection
// from credentials.json (added in a tiny extension) OR defaults to anthropic
// + sonnet. The key itself comes from the RPC.
// ---------------------------------------------------------------------------

async function resolveLlmConfig(
  client: SupabaseClient,
  preferProvider?: LlmProvider,
): Promise<LlmConfig> {
  const provider = preferProvider ?? 'anthropic';
  const rpcRes = await client.rpc('get_my_provider_key', {
    p_provider: provider,
  });
  if (rpcRes.error) {
    throw new Error(
      `Failed to load BYO key via get_my_provider_key: ${rpcRes.error.message}`,
    );
  }
  const apiKey = (rpcRes.data as string | null) ?? '';
  if (!apiKey) {
    throw new Error(
      `No provider key configured for "${provider}". Add one in Settings ▸ AI service (in the webapp) or pass a different provider via args.provider.`,
    );
  }
  return { provider, apiKey, model: defaultModelFor(provider) };
}

// ---------------------------------------------------------------------------
// run_operator
// ---------------------------------------------------------------------------

const ProviderEnum = z.enum(['anthropic', 'openai', 'openrouter', 'google']);

export const runOperatorInput = z
  .object({
    family: z
      .string()
      .describe(
        "Operator family. One of 'asit' | 'triz' | 'contradiction' | 'free' | 'combine' | 'explore'.",
      ),
    key: z
      .string()
      .describe(
        "Operator key within the family. Ignored for single-operator families (free, combine, contradiction, explore). For ASIT use one of: unification, multiplication, division, object_removal, breaking_symmetry. For TRIZ use 'principle_NN_<snake_name>' (e.g. principle_01_segmentation).",
      ),
    anchor_id: z.string().describe('The concept the operator runs against.'),
    args: z
      .record(z.unknown())
      .optional()
      .describe(
        "Family-specific extras: { angle?: string } for free/explore/combine, { improving: number, worsening: number } for contradiction, { combineWithIds: string[] } for combine. Optional { provider: 'anthropic' | 'openai' | 'openrouter' | 'google' } overrides the default provider.",
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        'Bypass idempotent reuse and force a fresh run even if an identical run is already in flight or recently finished.',
      ),
  })
  .strict();

export type RunOperatorArgs = z.infer<typeof runOperatorInput>;

export interface OperatorCandidate {
  label: string;
  description: string;
  partitionAttribute: string;
  rationale: string;
  kReferences: string[];
  selfCritique: string;
  children?: ParsedPartitionLeaf[];
}

export interface RunOperatorResult {
  family: OperatorFamily;
  key: string;
  anchorId: string;
  candidates: OperatorCandidate[];
  newKnowledgeProposed: ParsedNewKnowledge[];
  operatorNotes: string;
  estimatedCost: {
    credits: number;
    dollars: number;
    modelClass: string;
  };
  /** What the model actually returned, for debugging. Truncated to 5000 chars. */
  rawTextPreview: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export async function runOperator(
  client: SupabaseClient,
  args: RunOperatorArgs,
): Promise<RunOperatorResult> {
  const family = normalizeFamily(args.family);
  if (!family) {
    throw new Error(
      `Unknown operator family "${args.family}". Use one of: asit, triz, contradiction, free, combine, explore.`,
    );
  }
  const operator = resolveOperator(family, args.key);
  if (!operator) {
    throw new Error(
      `Unknown operator key "${args.key}" for family ${family}.`,
    );
  }

  const anchor = await loadAnchor(client, args.anchor_id);
  const project = await loadProjectForNode(client, anchor);
  const [ancestry, knowledge] = await Promise.all([
    loadAncestry(client, anchor),
    loadKnowledgePool(client, project),
  ]);

  // Family-specific extras.
  const extras = args.args ?? {};
  const angle = typeof extras.angle === 'string' ? extras.angle : undefined;

  let branch:
    | { parentLabel: string; existingChildren: { label: string; description?: string | null }[] }
    | undefined;
  if (family === 'EXPLORE') {
    const kids = await loadDirectChildren(client, anchor);
    branch = {
      parentLabel: anchor.label,
      existingChildren: kids.map((k) => ({
        label: k.label,
        description: k.description,
      })),
    };
  }

  let contradiction:
    | {
        improvingName: string;
        worseningName: string;
        principles: { num: number; name: string; doctrine: string }[];
      }
    | undefined;
  if (family === 'CONTRADICTION') {
    const improving = Number(extras.improving);
    const worsening = Number(extras.worsening);
    if (!Number.isInteger(improving) || improving < 1 || improving > 39) {
      throw new Error(
        "CONTRADICTION requires args.improving (1..39 — TRIZ parameter number).",
      );
    }
    if (!Number.isInteger(worsening) || worsening < 1 || worsening > 39) {
      throw new Error(
        "CONTRADICTION requires args.worsening (1..39 — TRIZ parameter number).",
      );
    }
    const improvingParam = TRIZ_PARAMETERS.find((p) => p.num === improving)!;
    const worseningParam = TRIZ_PARAMETERS.find((p) => p.num === worsening)!;
    const principleNums = lookupPrinciples(improving, worsening).slice(0, 5);
    const principles = principleNums
      .map((n) => TRIZ_PRINCIPLES.find((p) => p.num === n))
      .filter((p): p is (typeof TRIZ_PRINCIPLES)[number] => !!p)
      .map((p) => ({ num: p.num, name: p.name, doctrine: p.doctrine }));
    contradiction = {
      improvingName: improvingParam.name,
      worseningName: worseningParam.name,
      principles,
    };
  }

  let combineInputs: { id: string; label: string; description?: string | null }[] | undefined;
  if (family === 'COMBINE') {
    const ids = Array.isArray(extras.combineWithIds)
      ? (extras.combineWithIds as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        )
      : [];
    if (ids.length === 0) {
      throw new Error(
        'COMBINE requires args.combineWithIds: a non-empty array of concept ids to fuse with the anchor.',
      );
    }
    const rows = unwrap(
      await client
        .from('nodes')
        .select('id, label, description')
        .in('id', [anchor.id, ...ids]),
    ) as Pick<NodeRow, 'id' | 'label' | 'description'>[];
    combineInputs = rows;
  }

  // Compose + resolve the BYO key.
  const prompt = composePrompt({
    project,
    ancestry,
    target: anchor,
    operator,
    knowledge,
    freeformAngle: angle,
    combineInputs,
    branch,
    contradiction,
  });

  const preferProvider = ProviderEnum.safeParse(extras.provider).success
    ? (extras.provider as LlmProvider)
    : undefined;
  const config = await resolveLlmConfig(client, preferProvider);
  const cost = estimateCost({
    provider: config.provider,
    model: config.model,
    promptChars: prompt.length,
  });

  // Prompt-caching Step 2 mirror — pass a stable operator-framing system
  // prefix so the Anthropic prompt cache catches every repeat operator
  // call within the 5-minute TTL. The MCP `runLlm` already wraps
  // systemPrefix with `cache_control: ephemeral` for the Anthropic path.
  const llmResult = await runLlm(config, {
    prompt,
    systemPrefix: composeOperatorSystemPrefix(),
  });
  const parsed = parseLlmResponse(llmResult.text);
  if (!parsed.ok) {
    throw new Error(
      `Operator run produced output the parser rejected: ${parsed.error}`,
    );
  }

  const candidates: OperatorCandidate[] = parsed.data.partitions.map(
    (p: ParsedPartition) => ({
      label: p.label,
      description: p.description,
      partitionAttribute: p.partitionAttribute,
      rationale: p.rationale,
      kReferences: p.kReferences,
      selfCritique: p.selfCritique,
      children: p.children,
    }),
  );

  return {
    family,
    key: operator.key,
    anchorId: anchor.id,
    candidates,
    newKnowledgeProposed: parsed.data.newKnowledgeProposed,
    operatorNotes: parsed.data.operatorNotes,
    estimatedCost: {
      credits: cost.credits,
      dollars: cost.dollars,
      modelClass: cost.modelClass,
    },
    rawTextPreview: llmResult.text.slice(0, 5000),
    usage: llmResult.usage,
  };
}

// ---------------------------------------------------------------------------
// run_operator_and_commit — convenience wrapper that fires run_operator,
// then writes every top-level candidate as a child of the anchor, with a
// partition edge + provenance row. Children-of-children are NOT committed
// here (the depth-2 leaves are kept in the response for the caller to act on
// separately) because mixing depth-2 commits with the depth-1 set has
// surprised users in webapp testing.
// ---------------------------------------------------------------------------

export const runOperatorAndCommitInput = runOperatorInput;

export interface CommitResult {
  family: OperatorFamily;
  key: string;
  anchorId: string;
  committedIds: string[];
  estimatedCost: RunOperatorResult['estimatedCost'];
  operatorNotes: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export async function runOperatorAndCommit(
  client: SupabaseClient,
  args: RunOperatorArgs,
): Promise<CommitResult> {
  const run = await runOperator(client, args);
  const anchor = await loadAnchor(client, args.anchor_id);
  const project = await loadProjectForNode(client, anchor);
  const ids: string[] = [];
  for (const cand of run.candidates) {
    const id = await commitCandidate(client, {
      anchor,
      project,
      label: cand.label,
      description: cand.description,
      operator: `${run.family}:${run.key}`,
    });
    ids.push(id);
  }
  return {
    family: run.family,
    key: run.key,
    anchorId: run.anchorId,
    committedIds: ids,
    estimatedCost: run.estimatedCost,
    operatorNotes: run.operatorNotes,
    usage: run.usage,
  };
}

interface CommitArgs {
  anchor: NodeRow;
  project: ProjectRow;
  label: string;
  description: string;
  operator: string; // 'EXPLORE:branch', 'ASIT:unification', etc.
}

async function commitCandidate(
  client: SupabaseClient,
  args: CommitArgs,
): Promise<string> {
  const inserted = unwrap(
    await client
      .from('nodes')
      .insert({
        workspace_id: args.anchor.workspace_id,
        parent_id: args.anchor.id,
        label: args.label,
        description: args.description,
        project_id: args.project.id,
        tags: [],
      })
      .select('id')
      .single(),
  ) as { id: string };
  // Partition edge so the canvas draws the parent → child line.
  await client
    .from('edges')
    .insert({
      workspace_id: args.anchor.workspace_id,
      from_id: args.anchor.id,
      to_id: inserted.id,
      kind: 'partition' as EdgeKind,
    })
    .select('id')
    .maybeSingle();
  // project_nodes link (the project's member list).
  await client
    .from('project_nodes')
    .insert({ project_id: args.project.id, node_id: inserted.id, position: 0 })
    .select('id')
    .maybeSingle();
  // Provenance row — origin='mcp', operator='<family>:<key>', anchor as
  // source_ref. Best-effort: if the table is absent on a not-yet-migrated
  // database (0015 not applied), swallow the error rather than fail the
  // whole commit — the concept itself is still useful.
  try {
    await client.from('provenance').insert({
      workspace_id: args.anchor.workspace_id,
      node_id: inserted.id,
      origin: 'mcp',
      operator_key: args.operator,
      source_refs: [args.anchor.id],
      created_by: 'agent',
      timestamp_ms: Date.now(),
    });
  } catch {
    // ignore — provenance is metadata, not blocking.
  }
  return inserted.id;
}

// ---------------------------------------------------------------------------
// expand_concept — recursive Branch with depth + breadth.
// ---------------------------------------------------------------------------

export const expandConceptInput = z
  .object({
    id: z.string().describe('The concept to expand.'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(3)
      .describe('How many levels deep to expand (1..3).'),
    breadth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe('Approximate children per node (1..5).'),
    angle: z
      .string()
      .optional()
      .describe(
        'Optional creative-direction hint passed to the underlying free / explore operator.',
      ),
  })
  .strict()
  .refine(
    (v) => v.depth * v.breadth <= 60,
    'Safety guardrail: depth × breadth must be ≤ 60. See PLAN.md Phase 10.3.',
  );

export type ExpandConceptArgs = z.infer<typeof expandConceptInput>;

export interface ExpandConceptResult {
  rootId: string;
  totalCommitted: number;
  /** Tree of committed concepts, each with its children[]. */
  tree: ExpandTreeNode;
  estimatedCostTotal: { credits: number; dollars: number };
}

export interface ExpandTreeNode {
  id: string;
  label: string;
  children: ExpandTreeNode[];
}

export async function expandConcept(
  client: SupabaseClient,
  args: ExpandConceptArgs,
): Promise<ExpandConceptResult> {
  const root = await loadAnchor(client, args.id);
  const rootTree: ExpandTreeNode = { id: root.id, label: root.label, children: [] };
  let totalCommitted = 0;
  let totalCredits = 0;

  // Breadth-first: at each level, expand every just-committed node by one
  // level of EXPLORE. We commit each level immediately so the user sees
  // partial results in the webapp as the run progresses.
  let frontier: { node: NodeRow; tree: ExpandTreeNode }[] = [
    { node: root, tree: rootTree },
  ];
  for (let lvl = 0; lvl < args.depth; lvl++) {
    const nextFrontier: { node: NodeRow; tree: ExpandTreeNode }[] = [];
    for (const cur of frontier) {
      const runArgs: RunOperatorArgs = {
        family: 'explore',
        key: 'branch',
        anchor_id: cur.node.id,
        args: args.angle ? { angle: args.angle } : undefined,
      };
      const run = await runOperator(client, runArgs);
      totalCredits += run.estimatedCost.credits;
      // Take up to `breadth` candidates per node.
      const chosen = run.candidates.slice(0, args.breadth);
      const project = await loadProjectForNode(client, cur.node);
      for (const cand of chosen) {
        const newId = await commitCandidate(client, {
          anchor: cur.node,
          project,
          label: cand.label,
          description: cand.description,
          operator: 'expand',
        });
        totalCommitted++;
        const childTree: ExpandTreeNode = {
          id: newId,
          label: cand.label,
          children: [],
        };
        cur.tree.children.push(childTree);
        if (lvl + 1 < args.depth) {
          // Re-load the freshly-inserted node so subsequent EXPLORE calls
          // have a real NodeRow to anchor against.
          const fresh = await loadAnchor(client, newId);
          nextFrontier.push({ node: fresh, tree: childTree });
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return {
    rootId: root.id,
    totalCommitted,
    tree: rootTree,
    estimatedCostTotal: {
      credits: totalCredits,
      dollars: Math.round(totalCredits) / 100,
    },
  };
}

// ---------------------------------------------------------------------------
// OPERATOR_TOOLS export — index.ts splices this onto CLOUD_TOOLS and wires
// each entry's `handler(client, args)` to the lazy auth handshake.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Async run registry (rc.16) — operator runs are non-blocking.
// ---------------------------------------------------------------------------
// A heavy-model operator (free/explore) routinely exceeds the MCP client's 60s
// tool-call timeout, and progress-notification heartbeats don't extend that
// timeout in every client (confirmed: Claude Code on the web still timed out).
// So each operator call now returns a `runId` quickly — inline if it settles
// within FAST_PATH_MS, otherwise the agent polls `get_run`. The registry also
// buys us, for free:
//   • Idempotency — an identical (tool, args) call within REUSE_MS returns the
//     SAME run instead of starting (and committing) a duplicate. That is the
//     fix for the "10 capabilities instead of 5" double-commit on retry. Pass
//     force:true to override.
//   • Concurrency control — at most MAX_CONCURRENT_OPS operator bodies run at
//     once, so firing many in parallel queues rather than overloading the
//     provider/backend.
// Runs live in-memory for the process (a session); fine because operators
// already execute locally in the MCP process.

type RunStatus = 'running' | 'done' | 'error';
interface OperatorRun {
  runId: string;
  opKey: string;
  tool: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
}

const FAST_PATH_MS = 8_000; // return inline if the run settles this fast
const REUSE_MS = 10 * 60_000; // idempotent-reuse window for completed runs
const MAX_RUNS = 200; // cap the in-memory registry
const MAX_CONCURRENT_OPS = 2; // heavy LLM bodies allowed in flight at once

const runsById = new Map<string, OperatorRun>();
const runIdByOpKey = new Map<string, string>();

let activeOps = 0;
const opQueue: Array<() => void> = [];
function acquireOpSlot(): Promise<void> {
  if (activeOps < MAX_CONCURRENT_OPS) {
    activeOps += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => opQueue.push(resolve));
}
function releaseOpSlot(): void {
  const next = opQueue.shift();
  if (next) next();
  else activeOps -= 1;
}

function stableKey(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stableKey);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.keys(o)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        if (k !== 'force') acc[k] = stableKey(o[k]); // `force` never affects identity
        return acc;
      }, {});
  }
  return v;
}
function makeOpKey(tool: string, args: unknown): string {
  return JSON.stringify([tool, stableKey(args)]);
}

function startOperatorRun(
  tool: string,
  args: unknown,
  work: () => Promise<unknown>,
  force = false,
): OperatorRun {
  const opKey = makeOpKey(tool, args);
  if (!force) {
    const prevId = runIdByOpKey.get(opKey);
    const prev = prevId ? runsById.get(prevId) : undefined;
    if (
      prev &&
      (prev.status === 'running' ||
        (prev.status === 'done' &&
          prev.finishedAt !== undefined &&
          Date.now() - prev.finishedAt < REUSE_MS))
    ) {
      return prev; // idempotent reuse — no duplicate run/commit
    }
  }
  const run: OperatorRun = {
    runId: randomUUID(),
    opKey,
    tool,
    status: 'running',
    startedAt: Date.now(),
  };
  runsById.set(run.runId, run);
  runIdByOpKey.set(opKey, run.runId);
  if (runsById.size > MAX_RUNS) {
    let oldest: OperatorRun | undefined;
    for (const r of runsById.values()) if (!oldest || r.startedAt < oldest.startedAt) oldest = r;
    if (oldest) {
      runsById.delete(oldest.runId);
      if (runIdByOpKey.get(oldest.opKey) === oldest.runId) runIdByOpKey.delete(oldest.opKey);
    }
  }
  void (async () => {
    await acquireOpSlot();
    try {
      run.result = await work();
      run.status = 'done';
    } catch (err) {
      run.status = 'error';
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      run.finishedAt = Date.now();
      releaseOpSlot();
    }
  })();
  return run;
}

async function settleWithin(run: OperatorRun, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (run.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

function runView(run: OperatorRun): Record<string, unknown> {
  if (run.status === 'done') return { runId: run.runId, status: 'done', result: run.result };
  if (run.status === 'error') return { runId: run.runId, status: 'error', error: run.error };
  return {
    runId: run.runId,
    status: 'running',
    hint: `Operator still running (a heavy model can take 1-2 min). Call get_run with runId "${run.runId}" — it returns the result the moment status is "done".`,
  };
}

/**
 * Run an operator asynchronously: start it (or reuse an identical in-flight /
 * recent run), return inline if it settles within FAST_PATH_MS, otherwise hand
 * back a runId for the agent to poll via get_run.
 */
async function runAsync(
  tool: string,
  args: unknown,
  work: () => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const force = Boolean((args as { force?: unknown } | null | undefined)?.force);
  const run = startOperatorRun(tool, args, work, force);
  await settleWithin(run, FAST_PATH_MS);
  return runView(run);
}

export const getRunInput = z
  .object({
    runId: z
      .string()
      .min(1)
      .describe('The runId returned by run_operator / run_operator_and_commit / expand_concept.'),
  })
  .strict();

export const OPERATOR_TOOLS: CloudToolDef[] = [
  {
    name: 'run_operator',
    description:
      "Run an ASIT / TRIZ / Contradiction / Free / Combine / Explore operator against one concept (the anchor). Returns CANDIDATE concepts WITHOUT committing them — call `bulk_add_concepts` (or `run_operator_and_commit`) to persist. Use this when you want the agent to vet the candidates before writing. The anchor must already live in a project; the operator pulls in ancestry + validated knowledge in the same project to ground the prompt.",
    inputSchema: runOperatorInput as unknown as z.ZodObject<z.ZodRawShape>,
    handler: async (client, raw) => {
      const args = runOperatorInput.parse(raw);
      return runAsync('run_operator', args, () => runOperator(client, args));
    },
  },
  {
    name: 'run_operator_and_commit',
    description:
      "Same as `run_operator`, but immediately writes every top-level candidate as a child of the anchor with a partition edge and a provenance row stamped origin='mcp'. Use when the agent is confident the candidates should land directly on the canvas (e.g. inside an autonomous expand loop). Children-of-children proposed in `partitions[].children` are NOT auto-committed — request them via a separate run.",
    inputSchema: runOperatorAndCommitInput as unknown as z.ZodObject<z.ZodRawShape>,
    handler: async (client, raw) => {
      const args = runOperatorAndCommitInput.parse(raw);
      return runAsync('run_operator_and_commit', args, () =>
        runOperatorAndCommit(client, args),
      );
    },
  },
  {
    name: 'expand_concept',
    description:
      'Recursive Branch — expand a concept by `breadth` children at each of `depth` levels (depth*breadth ≤ 60). Commits each level immediately so the webapp shows partial results as the run progresses. Optionally takes an `angle` hint that biases the underlying EXPLORE operator. Best when the anchor has few or no children yet; on a dense subtree consider `run_operator(family="explore")` so the operator can read existing children and propose complementary partitions.',
    inputSchema: expandConceptInput as unknown as z.ZodObject<z.ZodRawShape>,
    handler: async (client, raw) => {
      const args = expandConceptInput.parse(raw);
      return runAsync('expand_concept', args, () => expandConcept(client, args));
    },
  },
  {
    name: 'get_run',
    description:
      'Fetch an async operator run by its runId. Returns { status: "running" | "done" | "error" }; when "done", the `result` field holds the operator output (candidates / committedIds). Waits up to ~8s for completion before returning, so a simple poll loop converges fast. run_operator / run_operator_and_commit / expand_concept hand back a runId whenever their work exceeds the ~8s fast-path window.',
    inputSchema: getRunInput as unknown as z.ZodObject<z.ZodRawShape>,
    handler: async (_client, raw) => {
      const { runId } = getRunInput.parse(raw);
      const run = runsById.get(runId);
      if (!run) {
        return {
          error: `No run with id ${runId}. Operator runs are kept in memory for the session; it may have been evicted (200-run cap) or the server restarted.`,
        };
      }
      await settleWithin(run, FAST_PATH_MS);
      return runView(run);
    },
  },
];

// Re-exports kept narrow on purpose: index.ts only needs `makeOperatorTools`,
// but the inputs / shapes are exported above for unit tests when they land.
export const OPERATOR_FAMILIES = [
  'asit',
  'triz',
  'contradiction',
  'free',
  'combine',
  'explore',
] as const;
