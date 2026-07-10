// LLM client — server-side analogue of `src/llm/client.ts`. Same four
// providers (Anthropic, OpenAI, OpenRouter, Google), same defaults, but
// streaming is collapsed into a single response since MCP tool calls return
// a single payload anyway. No `dangerouslyAllowBrowser` because we're in
// Node — the SDKs work natively here.
//
// Key resolution: the caller passes the key already resolved (via the
// `get_my_provider_key` RPC in cloudOperators.ts) — this file never reads
// from disk or the cloud directly. That keeps the trust boundary at one
// place (the RPC + the resolver in cloudOperators.ts).

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

export type LlmProvider = 'anthropic' | 'openai' | 'openrouter' | 'google';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
}

export interface LlmRunInput {
  prompt: string;
  systemPrefix?: string;
  /** Token budget. Default 4096 — operator JSON with 3–5 partitions easily
   *  exceeds 2048, which truncates mid-string. */
  maxTokens?: number;
  /** Default 0.7 for inventive output. */
  temperature?: number;
}

export interface LlmRunResult {
  text: string;
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

const ANTHROPIC_DEFAULT = 'claude-sonnet-4-5-20250929';
const OPENAI_DEFAULT = 'gpt-4o-mini';
const OPENROUTER_DEFAULT = 'anthropic/claude-3.5-sonnet';
const GOOGLE_DEFAULT = 'gemini-2.5-flash';

export function defaultModelFor(provider: LlmProvider): string {
  switch (provider) {
    case 'anthropic':
      return ANTHROPIC_DEFAULT;
    case 'openai':
      return OPENAI_DEFAULT;
    case 'openrouter':
      return OPENROUTER_DEFAULT;
    case 'google':
      return GOOGLE_DEFAULT;
  }
}

export async function runLlm(
  config: LlmConfig,
  input: LlmRunInput,
): Promise<LlmRunResult> {
  if (!config.apiKey) {
    throw new Error(
      `No API key provided for ${config.provider}. Resolve a key via get_my_provider_key first.`,
    );
  }
  const maxTokens = input.maxTokens ?? 4096;
  const temperature = input.temperature ?? 0.7;
  switch (config.provider) {
    case 'anthropic':
      return callAnthropic(config, input, maxTokens, temperature);
    case 'openai':
      return callOpenAI(config, input, maxTokens, temperature);
    case 'openrouter':
      return callOpenRouter(config, input, maxTokens, temperature);
    case 'google':
      return callGoogle(config, input, maxTokens, temperature);
  }
}

async function callAnthropic(
  config: LlmConfig,
  input: LlmRunInput,
  maxTokens: number,
  temperature: number,
): Promise<LlmRunResult> {
  const client = new Anthropic({ apiKey: config.apiKey });
  // Mirror the webapp's prompt-caching strategy: when a stable systemPrefix
  // is supplied, mark it as ephemeral-cacheable so repeated operator runs
  // against the same doctrine block re-use the prompt cache.
  const system = input.systemPrefix
    ? [
        {
          type: 'text' as const,
          text: input.systemPrefix,
          cache_control: { type: 'ephemeral' as const },
        },
      ]
    : undefined;
  const res = await client.messages.create({
    model: config.model || ANTHROPIC_DEFAULT,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: 'user', content: input.prompt }],
  });
  const text = res.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  return {
    text,
    stopReason: res.stop_reason ?? undefined,
    usage: {
      inputTokens: res.usage?.input_tokens,
      outputTokens: res.usage?.output_tokens,
    },
  };
}

async function callOpenAI(
  config: LlmConfig,
  input: LlmRunInput,
  maxTokens: number,
  temperature: number,
): Promise<LlmRunResult> {
  const client = new OpenAI({ apiKey: config.apiKey });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (input.systemPrefix) messages.push({ role: 'system', content: input.systemPrefix });
  messages.push({ role: 'user', content: input.prompt });
  const res = await client.chat.completions.create({
    model: config.model || OPENAI_DEFAULT,
    max_tokens: maxTokens,
    temperature,
    messages,
    response_format: { type: 'json_object' },
  });
  const text = (res.choices[0]?.message?.content ?? '').trim();
  return {
    text,
    stopReason: res.choices[0]?.finish_reason ?? undefined,
    usage: {
      inputTokens: res.usage?.prompt_tokens,
      outputTokens: res.usage?.completion_tokens,
    },
  };
}

async function callOpenRouter(
  config: LlmConfig,
  input: LlmRunInput,
  maxTokens: number,
  temperature: number,
): Promise<LlmRunResult> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://proof.toremlabs.com',
      'X-Title': 'Proof MCP',
    },
  });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (input.systemPrefix) messages.push({ role: 'system', content: input.systemPrefix });
  messages.push({ role: 'user', content: input.prompt });
  const res = await client.chat.completions.create({
    model: config.model || OPENROUTER_DEFAULT,
    max_tokens: maxTokens,
    temperature,
    messages,
  });
  const text = (res.choices[0]?.message?.content ?? '').trim();
  return {
    text,
    stopReason: res.choices[0]?.finish_reason ?? undefined,
    usage: {
      inputTokens: res.usage?.prompt_tokens,
      outputTokens: res.usage?.completion_tokens,
    },
  };
}

async function callGoogle(
  config: LlmConfig,
  input: LlmRunInput,
  maxTokens: number,
  temperature: number,
): Promise<LlmRunResult> {
  const genAI = new GoogleGenerativeAI(config.apiKey);
  const model = genAI.getGenerativeModel({
    model: config.model || GOOGLE_DEFAULT,
    systemInstruction: input.systemPrefix,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
    },
  });
  const res = await model.generateContent(input.prompt);
  const text = res.response.text().trim();
  const candidate = res.response.candidates?.[0];
  const meta = res.response.usageMetadata;
  return {
    text,
    stopReason: candidate?.finishReason ?? undefined,
    usage: meta
      ? { inputTokens: meta.promptTokenCount, outputTokens: meta.candidatesTokenCount }
      : undefined,
  };
}
