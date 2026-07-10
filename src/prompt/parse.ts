// JSON-extraction + schema-validation for LLM operator responses. Verbatim
// duplicate of `src/prompt/parse.ts` so the MCP can validate provider output
// without importing from the main app.
//
// The scanner tolerates ```json fences and stray prose because providers
// (especially OpenRouter pass-throughs) sometimes wrap JSON even when
// response_format=json_object is requested.

import { llmResponseSchema, type LlmResponse } from './schema.js';

export interface ParseSuccess {
  ok: true;
  data: LlmResponse;
  raw: string;
}

export interface ParseFailure {
  ok: false;
  error: string;
  raw: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

const FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

function stripFence(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(FENCE);
  if (m) return m[1].trim();
  return trimmed;
}

interface FindJsonResult {
  text: string | null;
  /** True iff we found an opening `{` but ran out of input before a
   *  matching closing `}` — i.e. the response was TRUNCATED mid-JSON.
   *  Surfaced separately so the parse error can be specific
   *  ("response truncated — bump max_tokens / tier") instead of the
   *  misleading "no JSON found" message. */
  truncated: boolean;
}

function findJsonObject(input: string): FindJsonResult {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return { text: input.slice(start, i + 1), truncated: false };
      }
    }
  }
  return { text: null, truncated: start !== -1 };
}

export function parseLlmResponse(rawInput: string): ParseResult {
  const cleaned = stripFence(rawInput);
  let candidate: string | null;
  let truncated = false;
  if (cleaned.startsWith('{')) {
    const scan = findJsonObject(cleaned);
    candidate = scan.text;
    truncated = scan.truncated;
  } else {
    const scan = findJsonObject(cleaned);
    candidate = scan.text;
    truncated = scan.truncated;
  }
  if (!candidate) {
    return {
      ok: false,
      error: truncated
        ? 'Response was truncated mid-JSON — likely hit the max-tokens limit. Retry with a higher-tier model.'
        : 'No JSON object found in the model response.',
      raw: rawInput,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch (e) {
    return {
      ok: false,
      error: `JSON.parse failed: ${(e as Error).message}`,
      raw: rawInput,
    };
  }
  const result = llmResponseSchema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      error: `Schema validation failed: ${result.error.issues
        .map((i) => `${i.path.join('.')} — ${i.message}`)
        .join('; ')}`,
      raw: rawInput,
    };
  }
  return { ok: true, data: result.data, raw: rawInput };
}
