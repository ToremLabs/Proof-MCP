# @toremlabs/proof-mcp

A Model Context Protocol (MCP) server that exposes a [Proof](https://proof.toremlabs.com)
workspace to any MCP-capable client (Claude Desktop, Claude Code, Cursor,
Windsurf, custom agents). The server logs into the user's Proof account,
talks to the same Supabase project the webapp talks to, and respects the
same RLS. Webapp and MCP are two front-ends to one cloud workspace.

Current version: `1.0.0-rc.20`.

## Install

```bash
npm install -g @toremlabs/proof-mcp
# or on demand without installing:
npx -y @toremlabs/proof-mcp
```

The npm package is `@toremlabs/proof-mcp` and the command it installs is
`proof-mcp`, so subcommands run directly:

```bash
npx -y @toremlabs/proof-mcp login
```

## Quickstart

### 1. Link this machine to your Proof account

```bash
npx -y @toremlabs/proof-mcp login
```

The CLI prints a device code and a one-click URL of the form
`https://proof.toremlabs.com/device?code=XXXX-XXXX`. Open it in your browser,
sign in if you aren't already, and confirm the device. The CLI polls in the
background and writes credentials to `~/.proof/credentials.json` (chmod 600 on
POSIX) the moment you confirm. Subsequent runs of the MCP are silent.

The login flow rides three Supabase Edge Functions: `mcp-device-init`,
`mcp-device-grant`, and `mcp-device-poll`.

To unlink a machine: `npx -y @toremlabs/proof-mcp logout`, or open
Settings ▸ Connected devices in the webapp to revoke remotely.

`npx -y @toremlabs/proof-mcp whoami` confirms which account a machine is
currently linked to.

### 2. Point your MCP client at it

**Claude Desktop.** Edit
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
or `%APPDATA%/Claude/claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "proof": { "command": "npx", "args": ["-y", "@toremlabs/proof-mcp"] }
  }
}
```

**Claude Code / Cursor / Windsurf.** Drop a `.mcp.json` in the workspace root:

```json
{
  "mcpServers": {
    "proof": { "command": "npx", "args": ["-y", "@toremlabs/proof-mcp"] }
  }
}
```

Restart the client. The Proof tools appear in the tool menu.

### 3. CLI subcommands

```bash
npx -y @toremlabs/proof-mcp whoami        # show the linked account + device
npx -y @toremlabs/proof-mcp logout        # delete the credentials file
npx -y @toremlabs/proof-mcp --help        # all options
npx -y @toremlabs/proof-mcp --no-realtime # boot the server with live sync off (persisted)
npx -y @toremlabs/proof-mcp --realtime    # re-enable live sync
```

## Headless mode (CI, cloud agents, disposable containers)

Device pairing writes a **refresh token** to disk. That works great on a
personal machine, but it does **not** survive disposable/ephemeral
environments (CI runners, cloud agent containers, "Claude Code on the web"):
the filesystem is wiped between runs, and a Supabase refresh token is
**single-use under rotation** — so a token baked into config dies after the
first session.

For those environments, skip pairing and let the server **sign in fresh on
every boot** from your account email + password (a password is not consumed on
use, so it works forever with no re-pairing). Set three env vars:

```bash
PROOF_EMAIL=you@example.com          # your Proof account email
PROOF_PASSWORD=your-account-password # secret — store it in a secrets manager
PROOF_ANON_KEY=sb_publishable_...    # project anon/publishable key (public, not a secret)
# optional: PROOF_SUPABASE_URL=...   # defaults to the production Proof project
```

When `PROOF_EMAIL` + `PROOF_PASSWORD` are present they take precedence over any
`credentials.json`, and the MCP server authenticates per boot — no device link
required. Requirements:

- Email + password sign-in must be enabled for the Supabase project, and the
  account must have a password set (passwordless / magic-link-only accounts
  need a password added first).
- Treat `PROOF_PASSWORD` as a secret. Prefer a dedicated account if your
  environment can only expose env vars that are visible to its users.

> **Legacy env names.** The server previously shipped as Heuresis, so every
> variable also accepts its old `HEURESIS_*` spelling (`HEURESIS_EMAIL`,
> `HEURESIS_SNAPSHOT`, …). The `PROOF_*` name wins when both are set. Machines
> paired under the old `~/.heuresis/` directory keep working — reads fall back
> to it and the next write migrates to `~/.proof/`.

## Live sync

When the MCP boots in cloud mode it subscribes to the workspace over Supabase
Realtime and notifies the client whenever a `nodes`, `edges`, `projects`, or
`ideas` row changes. Edits made in the webapp show up in the agent's view
without a manual refresh, and writes from one MCP-connected client reach any
other connected client the same way. Pass `--no-realtime` to disable the
subscription (useful if the chatter is noisy or the client logs every
notification). The preference is saved to `~/.proof/config.json` so the flag
only needs to be passed once.

## Tools

50 tools total: 46 data tools against the cloud workspace, plus 4 operator
tools that drive the same ideation operators the webapp uses.

**Reads.** `get_workspace_summary`, `list_projects`, `get_project_graph`,
`get_subtree`, `list_concepts`, `list_edges`, `get_concept`, `search_concepts`,
`find_concepts`, `find_orphans`, `list_recent_decisions`. Most agent sessions
start with `get_workspace_summary` or `list_projects`.

**Concept writes.** `add_concept`, `update_concept`, `bulk_add_concepts`,
`set_parent`, `link_concepts`, `add_kref`, `validate_concept`, `set_standing`,
`archive_concept`, `unarchive_concept`, `star_concept`, `remove_concept`,
`remove_concepts`.

**Idea & project writes.** `create_idea`, `rename_idea`, `recolor_idea`,
`set_idea_members`, `add_to_idea`, `delete_idea`, `create_project`,
`update_project`, `delete_project`.

**Agent runs & handoffs.** `list_agent_runs`, `get_agent_run`,
`update_agent_run`, `list_pending_handoffs`, `claim_handoff`.

**Evidence, proof & review.** `add_evidence`, `add_challenge`, `record_proof`,
`get_concept_proof`, `list_proofs`, `list_verification_records`,
`get_verification_record`, `submit_review_summary`.

Every write stamps a row in `public.provenance` with `origin='mcp'` so the
webapp's session log shows which surface made the change.

**Operators (4).** `run_operator` (generate candidates with Branch / Matrix /
ASIT / TRIZ / Combine / Free / Contradiction), `run_operator_and_commit` (same,
plus commit the result in one round-trip), `expand_concept` (recursive Branch,
capped at depth × breadth ≤ 60), and `get_run` (fetch a prior operator run).

Tool input shapes mirror their counterparts in the webapp's `src/agent/tools.ts`,
so an agent that uses both surfaces sees a uniform contract.

## Snapshot mode (read-only)

Without credentials, the server can read a JSON workspace export from disk and
expose the read-only tool set (`get_workspace_summary`, `list_projects`,
`search_concepts`, `get_concept`, `get_subtree`, `get_project_graph`,
`list_recent_decisions`). Point `PROOF_SNAPSHOT` at the file:

```bash
export PROOF_SNAPSHOT="/absolute/path/to/your-export.json"
npx @toremlabs/proof-mcp
```

Export a workspace from the webapp via Settings → Workspace → Export. This mode
is a convenience for offline / read-only use; cloud mode is the primary path.

## License

AGPL-3.0-or-later.
