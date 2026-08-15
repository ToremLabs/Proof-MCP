// What the published tool schema tells a calling model (QA, 2026-08-15).
//
// Two ways it was lying. Arrays were emitted as a bare `{"type":"array"}`,
// so `bulk_add_concepts` was effectively untyped and a wrong key produced a
// raw zod dump. And `set_parent`'s `newParentId: z.string().nullable()`
// published as a REQUIRED string, so the only documented way to detach a
// concept — pass null — was rejected by validating clients before it reached
// the handler that supports it.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from '../zod-to-json-schema.js';
import { setParentInput } from '../cloudTools.js';

describe('array parameters', () => {
  it('publish the shape of what goes in them', () => {
    const schema = zodToJsonSchema(
      z.object({ tags: z.array(z.string()).describe('Free-form labels.') }),
    );
    const tags = (schema.properties as Record<string, { type?: string; items?: { type?: string } }>)
      .tags;
    expect(tags.type).toBe('array');
    expect(tags.items?.type).toBe('string');
  });

  it('describe object elements too, not just scalars', () => {
    const schema = zodToJsonSchema(
      z.object({ concepts: z.array(z.object({ label: z.string() })) }),
    );
    const concepts = (
      schema.properties as Record<string, { items?: { type?: string; properties?: unknown } }>
    ).concepts;
    expect(concepts.items?.type).toBe('object');
    expect(concepts.items?.properties).toBeTruthy();
  });
});

describe('set_parent detach', () => {
  it('accepts null — the documented way to detach', () => {
    expect(setParentInput.safeParse({ nodeId: 'n1', newParentId: null }).success).toBe(true);
  });

  it('accepts an omitted parent as the same thing', () => {
    expect(setParentInput.safeParse({ nodeId: 'n1' }).success).toBe(true);
  });

  it('still accepts a real parent id', () => {
    expect(setParentInput.safeParse({ nodeId: 'n1', newParentId: 'n2' }).success).toBe(true);
  });
});
