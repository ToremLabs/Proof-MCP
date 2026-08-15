// Postgres row types — narrow subset duplicated from src/cloud/types.ts so the
// MCP package builds independently of the main app. Only the rows we actually
// touch from MCP tools (nodes, edges, projects, project_nodes, workspaces,
// workspace_memberships, ideas, idea_nodes, sheets) are mirrored here. Add
// more as the tool-parity waves expand.
//
// Field names are snake_case to match what supabase-js returns.

export type NodeStatus = 'open' | 'validated' | 'archived';
export type ConceptStanding = 'unknown' | 'novel' | 'emerging' | 'established';
export type EdgeKind =
  | 'partition'
  | 'k-ref'
  | 'semantic-adjacency'
  | 'derived-from'
  | 'imported-from';
export type ProjectLifecycle = 'active' | 'paused' | 'completed' | 'abandoned';
export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'viewer';

export interface WorkspaceRow {
  id: string;
  external_id: string | null;
  name: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMembershipRow {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  updated_at: string;
}

// Phase 21 — proving shapes (migration 0043). A concept's proving state travels
// as one JSONB blob on `nodes.proof_data`; mirror the webapp's domain shapes
// (src/types/domain.ts) so reads/writes round-trip with the app and cloud sync.
export type EvidenceKind = 'support' | 'counter';
export type ObjectionSeverity = 'low' | 'medium' | 'high';

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  text: string;
  source?: string;
  /** Who added it: the user, or an AI pass. MCP writes stamp 'ai'. */
  addedBy: 'user' | 'ai';
  createdAt: number;
}

export interface ChallengeObjection {
  text: string;
  severity: ObjectionSeverity;
  addressed: boolean;
}

export interface Challenge {
  objections: ChallengeObjection[];
  verdict: string;
  generatedAt: number;
}

export interface ProofRecord {
  validatedAt: number;
  validatedBy: string;
  basis: string;
  supportCount: number;
  counterCount: number;
  criteriaMet: number;
  criteriaTotal: number;
  challengeRaised: number;
  challengeAddressed: number;
}

/** The `nodes.proof_data` JSONB blob (migration 0043). All keys optional. */
export interface ProofData {
  evidence?: Evidence[];
  challenge?: Challenge | null;
  criteriaMet?: string[];
  proof?: ProofRecord | null;
}

/** One project success criterion (the `projects.criteria` JSONB array, 0043). */
export interface ProofCriterion {
  id: string;
  text: string;
  createdAt: number;
}

export interface NodeRow {
  id: string;
  external_id: string | null;
  workspace_id: string;
  parent_id: string | null;
  label: string;
  description: string;
  partition_attribute: string | null;
  rationale: string | null;
  self_critique: string | null;
  operator_family: string | null;
  operator_principle: string | null;
  status: NodeStatus;
  starred: boolean;
  standing: ConceptStanding;
  standing_rationale: string | null;
  standing_assessed_at: string | null;
  project_id: string | null;
  // The sheet (canvas page) the node lives on (migration 0047, FK → sheets).
  // NULL renders on the client's default sheet.
  sheet_id: string | null;
  position_x: number | null;
  position_y: number | null;
  embedding: number[] | null;
  tags: string[];
  notes: string | null;
  // Phase 21 — proving state as one JSONB blob (migration 0043). Null on
  // concepts with no proving state yet.
  proof_data: ProofData | null;
  created_at: string;
  updated_at: string;
}

export interface EdgeRow {
  id: string;
  external_id: string | null;
  workspace_id: string;
  from_id: string;
  to_id: string;
  kind: EdgeKind;
  weight: number | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  external_id: string | null;
  workspace_id: string;
  name: string;
  brief: string;
  direction: string | null;
  lifecycle: ProjectLifecycle;
  root_node_id: string | null;
  // Phase 21 — project success criteria as a JSONB array (migration 0043).
  criteria: ProofCriterion[] | null;
  // Phase 22 — signed code-review records as a JSONB array (migration 0044).
  verification_records: VerificationRecord[] | null;
  // GitHub target the webapp's agent handoffs push against (migration 0054).
  github_repo: string | null;
  github_branch: string | null;
  // Per-project agent API-key policy (migration 0026).
  api_key_policy: string | null;
  // Identity-first frame (migration 0056): one plain sentence of what the
  // project IS, plus the design dimensions its concept decomposition ran
  // along (a JSONB string array). Written by the webapp's identity-first
  // analysis — and by the set_project_identity MCP tool.
  identity: string | null;
  dimensions: string[] | null;
  created_at: string;
  updated_at: string;
}

// A sheet — one canvas page inside a project (migration 0047). Nodes point at
// a sheet via `nodes.sheet_id`; a NULL sheet_id renders on the client's
// default sheet. RLS mirrors `ideas`.
export interface SheetRow {
  id: string;
  external_id: string | null;
  workspace_id: string;
  project_id: string;
  name: string;
  sheet_order: number;
  // Soft-delete tombstone (same sync rationale as nodes/edges — see
  // tombstonePatch in cloudTools.ts).
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

// Phase 22 — a signed verification record (migration 0044), stored as one entry
// in the `projects.verification_records` JSONB array. Mirrors the webapp's
// VerificationRecord (src/verify/review.ts). The MCP only READS these — the
// human sign-off that mints one is an accountable act that stays in the app.
export type FileOutcome = 'cleared' | 'approved' | 'flagged';

export interface VerificationRecordFile {
  path: string;
  status: string;
  outcome: FileOutcome;
  reason?: string;
  note?: string;
}

export interface VerificationRecord {
  id: string;
  signedAt: number;
  signedBy: string;
  title?: string;
  summary?: string;
  filesTotal: number;
  filesCleared: number;
  filesApproved: number;
  filesFlagged: number;
  additions: number;
  deletions: number;
  files: VerificationRecordFile[];
  // Traceability links (the "one record, end to end" spine). Optional — present
  // only on records minted with the link wired (src/verify/review.ts).
  agentRunId?: string;
  ideaId?: string;
  conceptIds?: string[];
}

// Phase 2 (Agent) — an agent-run record (migration 0045). Mirrors the webapp's
// AgentRunRow / AgentRun (src/cloud/agentRuns.ts). The run-lifecycle MCP tools
// patch the row the handoff brief was tracked under.
export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface AgentRunRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  created_by: string | null;
  device_id: string | null;
  intent: string | null;
  status: AgentRunStatus;
  summary: string | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string | null;
}

export interface ProjectNodeRow {
  id: string;
  project_id: string;
  node_id: string;
  position: number;
  created_at: string;
}

export interface IdeaRow {
  id: string;
  external_id: string | null;
  workspace_id: string;
  name: string;
  color: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdeaNodeRow {
  id: string;
  idea_id: string;
  node_id: string;
  position: number;
  created_at: string;
}

// A flat, agent-friendly view of a Node (drops position/embedding) — same
// shape the legacy snapshot path produced.
export interface NodeView {
  id: string;
  label: string;
  status: NodeStatus;
  starred: boolean;
  parentId: string | null;
  partitionAttribute: string | null;
  // The sheet (canvas page) the node renders on: the sheet's external id when
  // the caller resolved one, else its uuid; null = the default sheet (0047).
  sheetId: string | null;
  tags: string[];
  updatedAt: string;
  description?: string;
  rationale?: string | null;
  standing?: ConceptStanding;
}

// Phase 19.4 — cloud-side audit log row (added in migration 0015). Append-only
// (the MCP only inserts; the webapp reads workspace-level rows via the
// list_recent_decisions / SessionLog surfaces).
export type ProvenanceOriginCloud =
  | 'manual'
  | 'mcp'
  | 'llm-conversation'
  | 'asit'
  | 'triz'
  | 'contradiction'
  | 'freeform'
  | 'combine'
  // NB: the app's ProvenanceOrigin union (src/types/domain.ts) spells this
  // 'import' — 'imported' never existed there and would fail its validation.
  | 'import';

export interface ProvenanceRow {
  id: string;
  external_id: string | null;
  workspace_id: string;
  node_id: string;
  origin: ProvenanceOriginCloud;
  operator_key: string | null;
  source_refs: string[];
  llm_json: Record<string, unknown> | null;
  created_by: 'user' | 'agent' | 'system';
  analysis_id: string | null;
  analysis_tool: string | null;
  timestamp_ms: number;
  created_at: string;
}
