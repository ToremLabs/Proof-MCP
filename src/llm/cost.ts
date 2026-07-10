// Cost-preview helper — derives an estimated credit cost for an operator run
// from the rate card in `docs/credits.md` §2. Informational only; no actual
// billing happens because operator runs use BYO-key (the cost goes against
// the user's own provider account).
//
// One credit = $0.01 USD at retail. The rate card splits models into three
// classes and applies a flat 1.5× markup. We pick the class by string match
// on the model id — slightly fragile, but the alternative is to keep the
// MCP in lockstep with a server-side card. Both numbers tend back to "1
// credit for cheap, 3-4 for mid, 13-14 for top" so rough is fine.
//
// Token estimate for the prompt is `ceil(chars / 4)` (English heuristic).
// Output is assumed to mirror the operator-JSON envelope: ~1500 tokens for
// the canonical 3-5-partition response.

import type { LlmProvider } from './client.js';

export interface CostEstimate {
  /** Whole-cent credits (rounded UP). */
  credits: number;
  /** USD equivalent (credits / 100). */
  dollars: number;
  /** Which class we matched ("haiku" | "sonnet" | "opus" | "unknown"). */
  modelClass: 'haiku' | 'sonnet' | 'opus' | 'unknown';
  /** Token counts that went into the estimate. */
  inputTokensEst: number;
  outputTokensEst: number;
}

interface RateRow {
  inputCentsPer1K: number;
  outputCentsPer1K: number;
}

const RATES: Record<'haiku' | 'sonnet' | 'opus' | 'unknown', RateRow> = {
  haiku: { inputCentsPer1K: 0.025, outputCentsPer1K: 0.125 },
  sonnet: { inputCentsPer1K: 0.45, outputCentsPer1K: 2.25 },
  opus: { inputCentsPer1K: 2.25, outputCentsPer1K: 11.25 },
  // Unknown model: assume sonnet-class so the preview doesn't undersell.
  unknown: { inputCentsPer1K: 0.45, outputCentsPer1K: 2.25 },
};
const MARKUP = 1.5;

function classifyModel(
  provider: LlmProvider,
  model: string,
): 'haiku' | 'sonnet' | 'opus' | 'unknown' {
  const m = (model || '').toLowerCase();
  if (provider === 'anthropic' || provider === 'openrouter') {
    if (m.includes('opus')) return 'opus';
    if (m.includes('sonnet')) return 'sonnet';
    if (m.includes('haiku')) return 'haiku';
  }
  if (provider === 'openai') {
    if (m.includes('mini') || m.includes('nano')) return 'haiku';
    if (m.includes('gpt-4o') || m.includes('gpt-4.1')) return 'sonnet';
    if (m.includes('o1') || m.includes('o3')) return 'opus';
  }
  if (provider === 'google') {
    if (m.includes('flash')) return 'haiku';
    if (m.includes('pro')) return 'sonnet';
  }
  return 'unknown';
}

export interface EstimateArgs {
  provider: LlmProvider;
  model: string;
  /** Composed prompt length in chars. */
  promptChars: number;
  /** Expected output token budget. Defaults to 1500 (typical operator JSON). */
  expectedOutputTokens?: number;
}

export function estimateCost(args: EstimateArgs): CostEstimate {
  const cls = classifyModel(args.provider, args.model);
  const rate = RATES[cls];
  const inputTokens = Math.ceil(args.promptChars / 4);
  const outputTokens = args.expectedOutputTokens ?? 1500;
  const cents =
    ((inputTokens / 1000) * rate.inputCentsPer1K +
      (outputTokens / 1000) * rate.outputCentsPer1K) *
    MARKUP;
  const credits = Math.max(1, Math.ceil(cents));
  return {
    credits,
    dollars: Math.round(credits) / 100,
    modelClass: cls,
    inputTokensEst: inputTokens,
    outputTokensEst: outputTokens,
  };
}
