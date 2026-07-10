// Combine operator — verbatim duplicate of `src/operators/combine.ts`.

import type { OperatorDefinition } from './types.js';

export const COMBINE_OPERATOR: OperatorDefinition = {
  family: 'COMBINE',
  key: 'synthesize',
  name: 'Synthesize',
  glyph: '⊕',
  oneLiner: 'Combine N concepts into a new one.',
  doctrine:
    'Treat all selected concepts as equal inputs. Propose a concept that captures their union, intersection, or a synthesis along the user-supplied angle.',
  promptFragment:
    'Apply the COMBINE operator: read the <inputs> block (N grounded concepts). Propose 1–3 new concepts that synthesize them. Each proposed concept should explicitly cite which inputs it draws from.',
};
