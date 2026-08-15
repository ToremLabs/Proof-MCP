// Environment-variable resolution for the Proof MCP.
//
// The public package reads `PROOF_*` variables. The server began life as
// "Heuresis" and shipped `HEURESIS_*` names to early users, so every read
// falls back to the legacy `HEURESIS_*` form — nobody's existing config
// breaks on the rename. Prefer `envVar('SUPABASE_URL')` over touching
// `process.env` directly so the fallback is applied consistently.

/**
 * Read an env var by its bare suffix, preferring the `PROOF_` prefix and
 * falling back to the legacy `HEURESIS_` one. Returns undefined when neither
 * is set. Pass e.g. 'SUPABASE_URL' → checks PROOF_SUPABASE_URL then
 * HEURESIS_SUPABASE_URL.
 */
export function envVar(
  suffix: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[`PROOF_${suffix}`] ?? env[`HEURESIS_${suffix}`];
}
