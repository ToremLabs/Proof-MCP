// Proof review link — the human handoff at the end of an agent run.
//
// The loop this closes (2026-07-31 user request): an agent finishes a run and
// reports its PR, and the HUMAN in the chat needs somewhere to click — the
// same `?reviewPr=` deep link the proof/accountability check prints on the PR.
// Reviewing and signing is deliberately not something the agent can do; the
// best the MCP can do is make the handoff unmissable, so update_agent_run
// attaches this link + a relay instruction to its result whenever it can
// derive one.
//
// Contract: the URL must parse into a deep-link intent the webapp executes —
// src/boot/deepLink.ts's parseDeepLink. mcpReviewLink.test.ts (main suite)
// round-trips the two so this file cannot drift from the app.
//
// Kept in its own module (not cloudTools.ts) so the test imports it without
// dragging supabase-js and the whole tool registry into the test runtime.

import { envVar } from './env.js';

/** Webapp origin for links. Same override the device-pairing CLI honours, so
 *  a self-hosted Proof gets self-hosted review links. */
export const PROOF_APP_ORIGIN = (
  envVar('DEVICE_BASE_URL') ?? 'https://proof.toremlabs.com'
).replace(/\/+$/, '');

export interface ProofReview {
  /** Deep link into Proof: Review mode, this PR's diff loaded. */
  url: string;
  /** Relay instruction for the chat assistant carrying the tool result. */
  forTheHuman: string;
}

/** Parse a github.com pull-request URL into its repo + PR number. Returns
 *  null for anything else — including URLs merely CONTAINING a PR path. */
export function parseGithubPrUrl(
  prUrl: string | null | undefined,
): { repo: string; pr: number } | null {
  if (typeof prUrl !== 'string') return null;
  const m =
    /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(
      prUrl.trim(),
    );
  if (!m) return null;
  const pr = Number.parseInt(m[3], 10);
  if (!Number.isFinite(pr) || pr <= 0) return null;
  return { repo: `${m[1]}/${m[2]}`, pr };
}

/** The slice of check_run_status's response the progress line reads. */
export interface PolicyStatusLike {
  policy?: { minRole: string; requiredCount: number } | null;
  validSignoffs?: number;
  satisfied?: boolean;
}

/**
 * One sentence of live policy progress, or null when the repo has no sign-off
 * policy (in which case the plain handoff line is the whole story). Pure —
 * the caller fetches check_run_status and hands the JSON here, so this stays
 * testable without a database.
 */
export function policyProgress(
  s: PolicyStatusLike | null | undefined,
): string | null {
  const pol = s?.policy;
  if (!pol) return null;
  const valid = s?.validSignoffs ?? 0;
  const bar = `${pol.requiredCount} sign-off${pol.requiredCount === 1 ? '' : 's'} from ${pol.minRole} or higher`;
  return s?.satisfied
    ? `Sign-off policy already met: ${valid} of ${bar}.`
    : `Sign-off progress: ${valid} of ${bar} so far.`;
}

/** Build the review handoff from a GitHub PR URL. Returns null when the URL
 *  is absent or not a github.com pull-request URL. */
export function proofReviewFor(
  prUrl: string | null | undefined,
): ProofReview | null {
  const parsed = parseGithubPrUrl(prUrl);
  if (!parsed) return null;
  const { repo, pr } = parsed;
  const url = `${PROOF_APP_ORIGIN}/projects?reviewPr=${pr}&repo=${repo}`;
  return {
    url,
    forTheHuman:
      `A human still needs to review and sign PR #${pr} (${repo}) in Proof — ` +
      `the proof/accountability check stays open until they do. ` +
      `ALWAYS include this link in your reply so they can do it in one click: ${url}`,
  };
}
