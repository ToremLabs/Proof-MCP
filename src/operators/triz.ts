// TRIZ family catalog — verbatim duplicate of `src/operators/triz.ts` so the
// MCP package builds without reaching into the main app's source tree. Derives
// 40 OperatorDefinitions from the principles table in `triz-matrix.ts`.

import type { OperatorDefinition } from './types.js';
import { TRIZ_PRINCIPLES, type TrizPrinciple } from './triz-matrix.js';

function buildPromptFragment(p: TrizPrinciple): string {
  const examples =
    p.examples && p.examples.length > 0
      ? ` Reference examples from the canonical literature: ${p.examples.join('; ')}.`
      : '';
  return `Apply TRIZ Inventive Principle #${p.num} — ${p.name}. Doctrine: ${p.doctrine}${examples} Propose 3–5 concrete partitions of the current concept that each embody this principle. For every partition, name precisely what is being transformed (subject), how the principle reshapes it (mechanism), and what new behavior or affordance results (consequence). Avoid vague restatements; every partition must be implementable.`;
}

export const TRIZ_OPERATORS: OperatorDefinition[] = TRIZ_PRINCIPLES.map((p) => ({
  family: 'TRIZ',
  key: `principle_${String(p.num).padStart(2, '0')}_${p.key}`,
  name: p.name,
  glyph: String(p.num).padStart(2, '0'),
  oneLiner: p.oneLiner,
  doctrine: p.doctrine,
  promptFragment: buildPromptFragment(p),
}));

export const TRIZ_KEYS_BY_NUMBER: Record<number, string> = TRIZ_PRINCIPLES.reduce(
  (acc, p, i) => {
    acc[p.num] = TRIZ_OPERATORS[i].key;
    return acc;
  },
  {} as Record<number, string>,
);
