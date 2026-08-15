// EXPLORE (Branch) operator — verbatim duplicate of the EXPLORE_OPERATOR
// constant in `src/operators/explore.ts`. The webapp ALSO exports a
// `runExploreForBranch` helper from that file, which reaches into the store
// and the LLM client and is intentionally NOT mirrored here — the MCP runs
// the operator through its own pipeline in `cloudOperators.ts`.

import type { OperatorDefinition } from './types.js';

export const EXPLORE_OPERATOR: OperatorDefinition = {
  family: 'EXPLORE',
  key: 'branch',
  name: 'Explore branch',
  glyph: '▾',
  oneLiner: 'Propose more children from what is already underneath.',
  doctrine:
    'Look at the parent concept and its existing direct children. Infer the axis or theme they share, then propose 4–8 more children that extend the set: cover extremes, inversions, fractional/qualitative variants, and overlooked common cases. If there are no existing children, propose 4–8 natural first partitions.',
  promptFragment:
    'Apply the EXPLORE operator: read the <branch> block — the parent concept and its existing direct children (which may be empty). Propose 4–8 additional sibling concepts. Each must be a standalone label suitable as a concept node (short, concrete). Order from most natural to most provocative.',
};
