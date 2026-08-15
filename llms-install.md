# Installing the Proof MCP server (guide for AI assistants)

This file is written for an **AI agent** setting this server up on a user's
behalf (Cline, Claude Code, Cursor, Continue, Goose, …). Humans want
[`README.md`](./README.md) instead.

Read the whole file before running anything. Step 2 needs the human, and
starting the server before the account is linked just produces auth errors.

## What this server is

`@toremlabs/proof-mcp` connects an MCP client to a
[Proof](https://proof.toremlabs.com) workspace: the concept canvas, the agent
hand-off, and the signed decision record. It authenticates as the user's own
Proof account and reads/writes the same cloud workspace the webapp uses, under
the same row-level security. There is **no anonymous mode** — an account is
required, and creating one is free.

## Step 1 — no install needed

Do **not** run `npm install`. Every command uses `npx -y`, which fetches the
package on demand and keeps it current:

```bash
npx -y @toremlabs/proof-mcp --help
```

If that prints usage, the package resolves and you can continue.

## Step 2 — link the machine (REQUIRES THE HUMAN)

```bash
npx -y @toremlabs/proof-mcp login
```

This prints a device code and a URL like
`https://proof.toremlabs.com/device?code=XXXX-XXXX`, then **blocks while polling**
until the code is confirmed in a browser.

**You cannot complete this step yourself.** It needs a human to open the URL,
sign in, and approve the device. So:

1. Run the command (or, if you cannot manage a long-running process, tell the
   user to run it in their own terminal).
2. Surface the URL to the user verbatim and ask them to open it and confirm.
3. Wait for them to say they're done, then verify with Step 3.

If the user has no Proof account, point them at
<https://proof.toremlabs.com> — signups are open and new accounts get free
credits. Do not try to create one for them.

On success the CLI writes `~/.proof/credentials.json` (mode 600 on POSIX).
Later runs are silent; this is a one-time step per machine.

**Ephemeral environments** (CI, cloud agents, disposable containers): skip
device linking entirely — the filesystem is wiped between runs and the stored
refresh token is single-use under rotation, so a copied token dies after one
session. Use env vars instead, and let the server sign in fresh each boot:

```bash
PROOF_EMAIL=user@example.com
PROOF_PASSWORD=...            # secret — pull from a secrets manager, never inline it
PROOF_ANON_KEY=sb_publishable_...   # public project key, not a secret
```

## Step 3 — verify the link before configuring anything

```bash
npx -y @toremlabs/proof-mcp whoami
```

Prints the linked account and device. If it errors or reports no account,
Step 2 did not complete — go back rather than editing config files.

## Step 4 — add the server to the client config

Same server entry everywhere; only the file location differs.

```json
{
  "mcpServers": {
    "proof": { "command": "npx", "args": ["-y", "@toremlabs/proof-mcp"] }
  }
}
```

| Client | Config file |
| --- | --- |
| Cline | the MCP settings JSON in the Cline extension's storage directory |
| Claude Code / Cursor / Windsurf | `.mcp.json` in the workspace root |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%/Claude/claude_desktop_config.json` |

Merge into any existing `mcpServers` object — do not overwrite other servers.
Then restart the client so it picks the server up.

## Step 5 — confirm it works

Call `get_workspace_summary`. It returns the user's projects and concept counts.
If that succeeds the install is done.

## Optional flags

```bash
npx -y @toremlabs/proof-mcp --no-realtime   # disable live sync (persisted)
npx -y @toremlabs/proof-mcp --realtime      # re-enable it
npx -y @toremlabs/proof-mcp logout          # unlink this machine
```

Live sync is on by default: the server subscribes over Supabase Realtime and
notifies the client when concepts, edges, projects, or ideas change, so webapp
edits appear without a manual refresh. Turn it off if the notification volume
is noisy in your client. The preference persists to `~/.proof/config.json`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Auth errors on every tool call | Step 2 never completed. Run `whoami` to confirm, then re-run `login`. |
| Worked before, now fails | Device revoked (Settings ▸ Connected devices) or credentials wiped. Re-run `login`. |
| Fails only in CI / a container | Device pairing does not survive ephemeral filesystems. Switch to the `PROOF_EMAIL` / `PROOF_PASSWORD` env vars from Step 2. |
| `login` hangs | Expected — it polls until the human confirms in the browser. Make sure they got the URL. |
| Old `HEURESIS_*` env vars in the environment | Still honoured; the server shipped under that name previously. `PROOF_*` wins when both are set. |
