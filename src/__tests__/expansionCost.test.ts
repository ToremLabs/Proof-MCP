// What `expand_concept` actually costs (QA, 2026-08-15).
//
// The old guardrail tested `depth * breadth <= 60` against knobs that cap at
// 3 and 5 — a maximum product of 15, so the check could never fire. It was
// dead code shaped like a safety net, and the tool description repeated the
// same wrong cap, so the calling model was told that depth=3 breadth=5 sat
// inside a documented limit. It does not: expansion re-expands every node at
// every level, which is 31 sequential model calls and ~155 concepts written
// to someone's canvas, uncancellable.

import { describe, it, expect } from 'vitest';
import {
  expansionCalls,
  expansionConcepts,
  expandConceptInput,
  MAX_EXPANSION_CALLS,
} from '../cloudOperators.js';

describe('expansion cost', () => {
  it('is geometric, not the product of the knobs', () => {
    // The two cases the QA report measured.
    expect(expansionCalls(3, 3)).toBe(13);
    expect(expansionConcepts(3, 3)).toBe(39);
    expect(expansionCalls(3, 5)).toBe(31);
    expect(expansionConcepts(3, 5)).toBe(155);
    // ...and the product model that was there before says 9 and 15.
    expect(expansionCalls(3, 5)).toBeGreaterThan(3 * 5);
  });

  it('counts one call per node expanded', () => {
    expect(expansionCalls(1, 5)).toBe(1); // just the anchor
    expect(expansionCalls(2, 3)).toBe(4); // anchor + its 3 children
  });
});

describe('the guardrail', () => {
  const base = { id: 'c1' };

  it('actually fires now — the old one could not', () => {
    const bad = expandConceptInput.safeParse({ ...base, depth: 3, breadth: 5 });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      // The message has to name the real numbers, since the caller is a model
      // deciding whether to retry smaller.
      expect(bad.error.issues[0].message).toMatch(/31 model calls/);
      expect(bad.error.issues[0].message).toMatch(/155 concepts/);
    }
  });

  it('lets a sensible expansion through', () => {
    expect(expandConceptInput.safeParse({ ...base, depth: 2, breadth: 3 }).success).toBe(true);
    expect(expansionCalls(2, 3)).toBeLessThanOrEqual(MAX_EXPANSION_CALLS);
  });
});
