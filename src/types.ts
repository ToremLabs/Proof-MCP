// Mirror of the relevant subset of src/types/domain.ts from the main app.
// Kept inline rather than imported across packages so this server is a
// standalone npm package — drop into any agent setup without the rest of
// the Proof monorepo.

export type ID = string;

export type NodeStatus = 'open' | 'validated' | 'archived';

export type OperatorFamily =
  | 'ASIT'
  | 'TRIZ'
  | 'CONTRADICTION'
  | 'FREEFORM'
  | 'COMBINE'
  | 'EXPLORE';

export interface OperatorRef {
  family: OperatorFamily;
  key: string;
  variant?: string;
}

export interface Workspace {
  id: ID;
  name: string;
  schemaVersion: number;
  createdAt: number;
}

export interface Node {
  id: ID;
  workspaceId: ID;
  parentId: ID | null;
  label: string;
  description: string;
  partitionAttribute?: string;
  rationale?: string;
  selfCritique?: string;
  operator?: OperatorRef;
  status: NodeStatus;
  starred: boolean;
  position?: { x: number; y: number };
  embedding?: number[];
  tags: string[];
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export type EdgeKind =
  | 'partition'
  | 'k-ref'
  | 'semantic-adjacency'
  | 'derived-from'
  | 'imported-from';

export interface Edge {
  id: ID;
  workspaceId: ID;
  fromId: ID;
  toId: ID;
  kind: EdgeKind;
  weight?: number;
  createdAt: number;
}

export type ProjectLifecycle = 'active' | 'paused' | 'completed' | 'abandoned';

export interface Project {
  id: ID;
  workspaceId: ID;
  name: string;
  brief: string;
  direction?: string;
  lifecycle: ProjectLifecycle;
  nodeIds: ID[];
  rootNodeId: ID | null;
  createdAt: number;
  updatedAt: number;
}

export interface Idea {
  id: ID;
  workspaceId: ID;
  name: string;
  color: string;
  nodeIds: ID[];
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Provenance {
  id: ID;
  workspaceId: ID;
  nodeId: ID;
  origin: string;
  operatorKey?: string;
  sourceRefs?: string[];
  createdBy?: string;
  timestamp: number;
}

// The on-disk snapshot shape — matches what `Settings → Export workspace`
// writes from the app today (schemaVersion 4).
export interface Snapshot {
  schemaVersion: number;
  workspaces: Workspace[];
  nodes: Node[];
  edges: Edge[];
  projects: Project[];
  ideas: Idea[];
  provenance?: Provenance[];
}
