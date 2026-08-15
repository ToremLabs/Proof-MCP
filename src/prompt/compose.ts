// Prompt composer — port of `src/prompt/compose.ts` adapted to read the MCP's
// cloud row shapes (snake_case via supabase-js) instead of the webapp's
// camelCase domain types. The instruction text, response template, and rule
// list are kept verbatim so the parser's expectations line up.
//
// The webapp's composer also blends in a <context> graph-awareness block and
// a <files> prefix. The MCP composes the bare minimum: brief, ancestry,
// target, knowledge pool, operator, plus the operator-specific inputs block.
// File-context retrieval is a separate tool (find_in_files) that ships in
// Agent B's tool-parity wave; not folded in here.

import type { OperatorDefinition } from '../operators/types.js';
import type { NodeRow, ProjectRow } from '../cloudTypes.js';

export interface ComposeArgs {
  project: ProjectRow;
  /** Root → target ancestry, target first (the helper below reverses). */
  ancestry: NodeRow[];
  target: NodeRow;
  operator: OperatorDefinition;
  /** Validated concepts in the same project, used as the K pool. */
  knowledge: NodeRow[];
  /** FREEFORM / COMBINE / EXPLORE creative-direction hint. */
  freeformAngle?: string;
  /** COMBINE: other inputs being fused into the target. */
  combineInputs?: { id: string; label: string; description?: string | null }[];
  /** EXPLORE: parent label + existing children, drives the <branch> block. */
  branch?: {
    parentLabel: string;
    existingChildren: { label: string; description?: string | null }[];
  };
  /** CONTRADICTION: matrix-resolved principles inlined into the prompt. */
  contradiction?: {
    improvingName: string;
    worseningName: string;
    principles: { num: number; name: string; doctrine: string }[];
  };
}

const RESPONSE_TEMPLATE = `{
  "partitions": [
    {
      "label": "STANDALONE concept title — 2–5 words, ≤ 60 chars, NO parent prefix, no trailing period",
      "description": "1–2 sentences, ≤ 280 chars",
      "partitionAttribute": "≤ 5 words for the distinguishing attribute",
      "rationale": "1–3 sentences citing the operator and any K used",
      "kReferences": ["k_id_or_empty"],
      "selfCritique": "main weakness or assumption",
      "children": [
        {
          "label": "STANDALONE sub-concept title — same rules; do NOT prefix with this partition's label either",
          "description": "1–2 sentences, ≤ 280 chars",
          "partitionAttribute": "≤ 5 words",
          "rationale": "1–3 sentences",
          "kReferences": [],
          "selfCritique": "main weakness or assumption"
        }
      ]
    }
  ],
  "newKnowledgeProposed": [
    { "title": "fact title", "body": "1–2 sentences", "tags": ["tag1"] }
  ],
  "operatorNotes": "one line on how the operator fit (optional)"
}`;

function pathBlock(path: NodeRow[]): string {
  return path
    .map((n, i) => {
      const indent = '  '.repeat(i);
      const head = i === 0 ? 'ROOT' : `LVL ${i}`;
      const attr = n.partition_attribute ? `  attribute: ${n.partition_attribute}` : '';
      const desc = n.description ? `\n${indent}  description: ${n.description}` : '';
      return `${indent}- [${head}] ${n.label}${attr}${desc}`;
    })
    .join('\n');
}

function knowledgeBlock(knowledge: NodeRow[]): string {
  if (knowledge.length === 0) return '(no knowledge items pinned)';
  return knowledge
    .map(
      (k) =>
        `- id=${k.id} tags=[${(k.tags ?? []).join(', ')}] :: ${k.label}\n    ${k.description}`,
    )
    .join('\n');
}

function inputsBlock(inputs: NonNullable<ComposeArgs['combineInputs']>): string {
  return inputs
    .map(
      (n) =>
        `  <input id="${n.id}">\n    <label>${n.label}</label>${
          n.description ? `\n    <description>${n.description}</description>` : ''
        }\n  </input>`,
    )
    .join('\n');
}

function branchBlock(branch: NonNullable<ComposeArgs['branch']>): string {
  if (branch.existingChildren.length === 0) {
    return `<branch parent="${branch.parentLabel}">\n  (no existing children — propose first partitions)\n</branch>`;
  }
  const children = branch.existingChildren
    .map(
      (c) =>
        `  <child>\n    <label>${c.label}</label>${
          c.description ? `\n    <desc>${c.description}</desc>` : ''
        }\n  </child>`,
    )
    .join('\n');
  return `<branch parent="${branch.parentLabel}">\n${children}\n</branch>`;
}

function contradictionBlock(c: NonNullable<ComposeArgs['contradiction']>): string {
  const principles = c.principles
    .map((p) => `  - #${p.num} ${p.name}: ${p.doctrine}`)
    .join('\n');
  return `<contradiction>
  improving: ${c.improvingName}
  worsening: ${c.worseningName}
  matrix_principles:
${principles}
</contradiction>`;
}

export function composePrompt(input: ComposeArgs): string {
  const {
    project,
    ancestry,
    target,
    operator,
    knowledge,
    freeformAngle,
    combineInputs,
    branch,
    contradiction,
  } = input;
  const angleBlock =
    freeformAngle &&
    (operator.family === 'FREEFORM' ||
      operator.family === 'COMBINE' ||
      operator.family === 'EXPLORE')
      ? `\n<angle>\n${freeformAngle}\n</angle>\n`
      : '';
  const inputsXml =
    operator.family === 'COMBINE' && combineInputs && combineInputs.length > 0
      ? `\n<inputs>\n${inputsBlock(combineInputs)}\n</inputs>\n`
      : '';
  const branchXml =
    operator.family === 'EXPLORE' && branch ? `\n${branchBlock(branch)}\n` : '';
  const contradictionXml =
    operator.family === 'CONTRADICTION' && contradiction
      ? `\n${contradictionBlock(contradiction)}\n`
      : '';

  return `You are assisting an inventive design session structured by C-K theory. The user is growing a graph of concepts (C) drawing on a pool of validated knowledge (K). You will generate a set of new partitions of the TARGET concept by applying the requested operator from ASIT/TRIZ.

<brief>
${project.brief}
</brief>

<concept_path_root_to_target>
${pathBlock(ancestry)}
</concept_path_root_to_target>

<target_concept>
id: ${target.id}
label: ${target.label}
description: ${target.description || '(no description)'}
notes: ${target.notes || '(none)'}
</target_concept>

<knowledge_pool>
${knowledgeBlock(knowledge)}
</knowledge_pool>

<operator>
family: ${operator.family}
key: ${operator.key}
name: ${operator.name}
doctrine: ${operator.doctrine}
</operator>
${inputsXml}${branchXml}${contradictionXml}${angleBlock}
<instructions>
${operator.promptFragment}

Rules:
- Produce 3–5 partitions at the top level, each genuinely distinct, each adding a clear new attribute to the TARGET concept. (The optional \`children\` array below adds depth-2 nodes; it does NOT count toward the 3–5 top-level requirement.)
- Labels MUST be STANDALONE concept titles. Do NOT prefix labels with the parent concept's label. For example, if the parent is "Test", do NOT write labels like "Test by destruction" or "Test for X" — just write "Destruction" or "X". The label should make sense on its own; the parent context is implicit from the graph structure. This rule applies to EVERY label in the response, including children (a child's label must not contain its immediate parent partition's label either).
- Labels MUST be short: 2–5 words, ≤ 60 characters, no trailing punctuation. The label is a concept title, not a sentence. Put long-form prose in description/rationale, not in label.
- Each partition MAY optionally include a \`children\` array of 1–4 sub-partitions, when the partition naturally decomposes further into a clearly distinct sub-axis. Children follow the same shape (label, description, partitionAttribute, rationale, kReferences, selfCritique). Do NOT nest beyond one level — a child must NEVER have its own \`children\` array. Omit \`children\` entirely when no useful sub-decomposition exists; do not pad.
- Stay faithful to the operator's doctrine. If the operator forbids alien components (ASIT closed-world), do not introduce them.
- For each partition, cite by id any knowledge item from <knowledge_pool> you actually used in kReferences. Empty array if none.
- Use selfCritique to surface the strongest assumption or risk in that partition (do not flatter the idea).
- If you needed a fact you did not have, propose it via newKnowledgeProposed (1–3 items max). Do NOT invent specific numbers as facts; phrase as questions to verify.
- Output ONLY a single JSON object, matching this shape exactly. No prose before or after, no markdown fences.
</instructions>

<response_shape>
${RESPONSE_TEMPLATE}
</response_shape>`;
}
