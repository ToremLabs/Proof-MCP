// LLM response schema — duplicate of `src/prompt/schema.ts` so the MCP can
// parse operator output without reaching into the main app. Keep in sync if
// the webapp tightens limits (label ≤ 60, etc.) — the parser will accept
// either; the webapp is the strict gate at write time.

import { z } from 'zod';

const partitionBaseShape = {
  label: z.string().min(1).max(60),
  description: z.string().min(1).max(600),
  partitionAttribute: z.string().min(1).max(80),
  rationale: z.string().min(1).max(800),
  kReferences: z.array(z.string()).default([]),
  selfCritique: z.string().max(600).optional().default(''),
};

// Leaf — depth-2 children. No further nesting.
export const partitionLeafSchema = z.object(partitionBaseShape);

// Root — depth-1 partitions. May optionally carry up to 4 children.
export const partitionSchema = z.object({
  ...partitionBaseShape,
  children: z.array(partitionLeafSchema).max(4).optional(),
});

export const newKnowledgeSchema = z.object({
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(800),
  tags: z.array(z.string()).default([]),
});

export const llmResponseSchema = z.object({
  partitions: z.array(partitionSchema).min(1).max(8),
  newKnowledgeProposed: z.array(newKnowledgeSchema).default([]),
  operatorNotes: z.string().max(400).optional().default(''),
});

export type LlmResponse = z.infer<typeof llmResponseSchema>;
export type ParsedPartition = z.infer<typeof partitionSchema>;
export type ParsedPartitionLeaf = z.infer<typeof partitionLeafSchema>;
export type ParsedNewKnowledge = z.infer<typeof newKnowledgeSchema>;
