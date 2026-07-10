// Contradiction operator — verbatim duplicate of
// `src/operators/contradiction.ts`. The composer + matrix lookup that the
// webapp uses to surface principles for a given (improving × worsening) pair
// live in `triz-matrix.ts`.

import type { OperatorDefinition } from './types.js';

export const CONTRADICTION_OPERATOR: OperatorDefinition = {
  family: 'CONTRADICTION',
  key: 'triz_matrix',
  name: 'Contradiction',
  glyph: '⇄',
  oneLiner: 'Resolve a trade-off via the TRIZ matrix.',
  doctrine:
    'When improving one parameter worsens another, look up the contradiction in the 39×39 TRIZ matrix to get the inventive principles Altshuller found most often resolved that exact trade-off. Composer asks for the parameter you want to improve and the parameter that gets worse, then preloads the top 3 principles as next operators on the focused node.',
  promptFragment:
    "Apply the CONTRADICTION operator: the user picked an improving parameter and a worsening parameter from TRIZ's 39 standard parameters. The matrix-suggested inventive principles are listed inline. For each principle, propose 1–2 concrete reformulations of the focused concept that embody that principle and resolve the contradiction.",
};
